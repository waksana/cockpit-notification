import { createHash } from 'node:crypto';
import type { NativeObservation } from '@cockpit/module-api';
import { identity, MAX_BATCH, MAX_IDENTITIES, record, type MessageKey } from '../shared/protocol.ts';
import { BackendError } from './errors.ts';
import { notificationExcerpt, type NotificationPreview } from './preview.ts';

export const NATIVE_TYPES = [
  'assistant.turn_start', 'assistant.message_start', 'assistant.message_delta',
  'assistant.message', 'assistant.turn_end', 'assistant.idle',
  'tool.execution_start', 'tool.execution_complete', 'user_input.requested',
  'abort', 'session.error', 'assistant.error',
] as const;
const MAX_ACTIVE_TURNS = 128;

interface Turn {
  turnId: string;
  closed: boolean;
  apiCallHash?: string;
  streams: Set<string>;
  latest?: NotificationPreview;
  finals: Map<string, NotificationPreview>;
}

function root(event: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return ![event.agentId, event.parentToolCallId, data.agentId, data.parentToolCallId]
    .some(value => value !== undefined && value !== null && value !== '');
}

export class ReplyClassifier {
  #turns = new Map<string, Turn>();
  #seen = new Set<string>();
  #maxEvidence: number;
  #stopped = false;

  constructor(maxEvidence = MAX_IDENTITIES) {
    this.#maxEvidence = maxEvidence;
  }

  #discardTurn(sessionId: string): NotificationPreview[] {
    this.#turns.delete(sessionId);
    return [];
  }

  reset(sessionId: string): MessageKey[] {
    const turn = this.#turns.get(sessionId);
    this.#turns.delete(sessionId);
    return turn ? [...[...turn.finals.values()].map(message => message.key),
      ...(turn.latest ? [turn.latest.key] : []),
      ...[...turn.streams].map(nativeId => ({ sessionId, kind: 'reply' as const, nativeId }))] : [];
  }

  dispose(): void {
    this.#stopped = true;
    this.#turns.clear();
    this.#seen.clear();
  }

  observe({ sessionId, event }: NativeObservation): NotificationPreview[] {
    if (this.#stopped || !identity(sessionId) || !record(event) || !record(event.data) || !root(event, event.data)) return [];
    const data = event.data;
    if (!identity(event.id)) return [];
    const streaming = event.type === 'assistant.message_start' || event.type === 'assistant.message_delta';
    // Token callbacks only contribute a bounded message identity, not a retained token/event log.
    if (!streaming) {
      const eventId = JSON.stringify([sessionId, event.id]);
      if (this.#seen.has(eventId)) return [];
      if (this.#seen.size >= this.#maxEvidence) {
        this.#turns.clear();
        throw new BackendError('CLASSIFIER_CAPACITY', 'Live notification evidence capacity reached; restart required', 503);
      }
      this.#seen.add(eventId);
    }

    if (event.type === 'assistant.turn_start') {
      this.#turns.delete(sessionId);
      if (event.ephemeral !== true && identity(data.turnId)) {
        if (this.#turns.size >= MAX_ACTIVE_TURNS) {
          throw new BackendError('CLASSIFIER_ACTIVE_CAPACITY', 'Live reply evidence reached the active turn limit', 503);
        }
        this.#turns.set(sessionId, { turnId: data.turnId, closed: false, streams: new Set(), finals: new Map() });
      }
      return [];
    }
    const turn = this.#turns.get(sessionId);
    if (!turn) return [];
    if (['abort', 'session.error', 'assistant.error',
      'tool.execution_start', 'tool.execution_complete', 'user_input.requested'].includes(event.type)) {
      // Only turn_start creates evidence. An excluded turn needs no content or tombstone.
      return this.#discardTurn(sessionId);
    }
    if (streaming) {
      if (event.ephemeral !== true || !identity(data.messageId) ||
          (event.type === 'assistant.message_delta' && typeof data.deltaContent !== 'string')) return [];
      if (turn.closed || (data.turnId !== undefined && data.turnId !== turn.turnId)) {
        return this.#discardTurn(sessionId);
      }
      if (!turn.streams.has(data.messageId) && turn.streams.size >= MAX_BATCH) {
        this.#turns.delete(sessionId);
        throw new BackendError('CLASSIFIER_TURN_CAPACITY', 'Live reply turn exceeded the message evidence limit', 503);
      }
      turn.streams.add(data.messageId);
      return [];
    }
    if (event.type === 'assistant.idle') {
      this.#turns.delete(sessionId);
      if (event.ephemeral !== true || data.aborted === true || !turn.closed) return [];
      if (turn.finals.size) return [...turn.finals.values()];
      return turn.latest ? [turn.latest] : [];
    }
    if (event.type === 'assistant.turn_end') {
      if (event.ephemeral === true || data.turnId !== turn.turnId || data.aborted === true ||
          data.success === false || data.error != null) return this.#discardTurn(sessionId);
      turn.closed = true;
      return [];
    }
    if (event.type !== 'assistant.message' || event.ephemeral === true) return [];
    if (turn.closed || (data.turnId !== undefined && data.turnId !== turn.turnId)) {
      return this.#discardTurn(sessionId);
    }
    if (data.toolRequests !== undefined &&
        (!Array.isArray(data.toolRequests) || data.toolRequests.length > 0)) return this.#discardTurn(sessionId);
    if (data.apiCallId !== undefined) {
      if (typeof data.apiCallId !== 'string') return this.#discardTurn(sessionId);
      else {
        // Provider IDs are opaque SDK strings, not message keys; retain only a bounded, exact-code-unit digest.
        const hash = createHash('sha256').update(data.apiCallId, 'utf16le').digest('hex');
        if (turn.apiCallHash !== undefined && turn.apiCallHash !== hash) return this.#discardTurn(sessionId);
        else turn.apiCallHash = hash;
      }
    }
    const live = identity(data.messageId) && turn.streams.delete(data.messageId);
    if (typeof data.content !== 'string' || !data.content.trim()) return [];
    if (!identity(data.messageId)) {
      return this.#discardTurn(sessionId);
    }
    // Only the latest nonempty unphased message can be the fallback final.
    // Explicit finals remain distinct, but neither kind is confirmed before idle.
    turn.latest = undefined;
    if (!live || (data.phase !== undefined && data.phase !== 'final_answer')) return [];
    if (data.phase === undefined && turn.finals.size) return [];
    const preview = { key: { sessionId, kind: 'reply' as const, nativeId: data.messageId },
      summary: notificationExcerpt(data.content) };
    if (data.phase === undefined) {
      turn.latest = preview;
      return [];
    }
    if (!turn.finals.has(data.messageId) && turn.finals.size >= MAX_BATCH) {
      this.#turns.delete(sessionId);
      throw new BackendError('CLASSIFIER_TURN_CAPACITY', 'Live reply turn exceeded the final message evidence limit', 503);
    }
    turn.finals.set(data.messageId, preview);
    return [];
  }
}
