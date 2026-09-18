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
const MAX_TURN_AGE_MS = 15 * 60_000;

interface Turn {
  startId: string;
  turnId: string;
  startedAt: number;
  closed: boolean;
  invalid: boolean;
  tool: boolean;
  apiCallHash?: string;
  streams: Set<string>;
  messages: (NotificationPreview & { phase: 'final_answer' | 'excluded' | undefined; live: boolean })[];
}

function root(event: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return ![event.agentId, event.parentToolCallId, data.agentId, data.parentToolCallId]
    .some(value => value !== undefined && value !== null && value !== '');
}

export class ReplyClassifier {
  #turns = new Map<string, Turn>();
  #seen = new Set<string>();
  #now: () => number;
  #maxEvidence: number;
  #stopped = false;

  constructor(now: () => number, maxEvidence = MAX_IDENTITIES) {
    this.#now = now;
    this.#maxEvidence = maxEvidence;
  }

  reset(sessionId: string): MessageKey[] {
    const turn = this.#turns.get(sessionId);
    this.#turns.delete(sessionId);
    return turn ? [...turn.messages.map(message => message.key),
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
        this.#turns.set(sessionId, { startId: event.id, turnId: data.turnId, startedAt: this.#now(),
          closed: false, invalid: false, tool: false, streams: new Set(), messages: [] });
      }
      return [];
    }
    const turn = this.#turns.get(sessionId);
    if (!turn) return [];
    if (this.#now() - turn.startedAt > MAX_TURN_AGE_MS) {
      this.#turns.delete(sessionId);
      throw new BackendError('CLASSIFIER_WINDOW_EXPIRED', 'Live reply completion exceeded the evidence window', 503);
    }
    if (['abort', 'session.error', 'assistant.error'].includes(event.type)) {
      this.#turns.delete(sessionId);
      return [];
    }
    if (streaming) {
      if (event.ephemeral !== true || !identity(data.messageId) ||
          (event.type === 'assistant.message_delta' && typeof data.deltaContent !== 'string')) return [];
      if (turn.closed || (data.turnId !== undefined && data.turnId !== turn.turnId)) {
        turn.invalid = true;
        return [];
      }
      if (!turn.streams.has(data.messageId) && turn.streams.size >= MAX_BATCH) {
        turn.invalid = true;
        throw new BackendError('CLASSIFIER_TURN_CAPACITY', 'Live reply turn exceeded the message evidence limit', 503);
      }
      turn.streams.add(data.messageId);
      return [];
    }
    if (event.type === 'assistant.idle') {
      this.#turns.delete(sessionId);
      if (event.ephemeral !== true || data.aborted === true || !turn.closed || turn.invalid || turn.tool) return [];
      const explicit = turn.messages.filter(message => message.live && message.phase === 'final_answer')
        .map(({ key, summary }) => ({ key, summary }));
      if (explicit.length) return explicit;
      const last = turn.messages.at(-1);
      return last?.live && last.phase === undefined ? [{ key: last.key, summary: last.summary }] : [];
    }
    if (['tool.execution_start', 'tool.execution_complete', 'user_input.requested'].includes(event.type)) {
      turn.tool = true;
      return [];
    }
    if (event.type === 'assistant.turn_end') {
      if (event.ephemeral === true || data.turnId !== turn.turnId || data.aborted === true ||
          data.success === false || data.error != null) turn.invalid = true;
      turn.closed = true;
      return [];
    }
    if (event.type !== 'assistant.message' || event.ephemeral === true) return [];
    if (turn.closed || (data.turnId !== undefined && data.turnId !== turn.turnId)) {
      turn.invalid = true;
      return [];
    }
    if (data.toolRequests !== undefined && !Array.isArray(data.toolRequests)) turn.invalid = true;
    if (Array.isArray(data.toolRequests) && data.toolRequests.length > 0) turn.tool = true;
    if (data.apiCallId !== undefined) {
      if (typeof data.apiCallId !== 'string') turn.invalid = true;
      else {
        // Provider IDs are opaque SDK strings, not message keys; retain only a bounded, exact-code-unit digest.
        const hash = createHash('sha256').update(data.apiCallId, 'utf16le').digest('hex');
        if (turn.apiCallHash !== undefined && turn.apiCallHash !== hash) turn.invalid = true;
        else turn.apiCallHash = hash;
      }
    }
    if (typeof data.content !== 'string' || !data.content.trim()) return [];
    if (!identity(data.messageId)) {
      turn.invalid = true;
      return [];
    }
    if (turn.messages.length >= MAX_BATCH) {
      turn.invalid = true;
      throw new BackendError('CLASSIFIER_TURN_CAPACITY', 'Live reply turn exceeded the message evidence limit', 503);
    }
    const phase = data.phase === undefined ? undefined : data.phase === 'final_answer' ? 'final_answer' : 'excluded';
    const live = turn.streams.delete(data.messageId);
    turn.messages.push({ key: { sessionId, kind: 'reply', nativeId: data.messageId },
      summary: live && phase !== 'excluded' ? notificationExcerpt(data.content) : '', phase, live });
    return [];
  }
}
