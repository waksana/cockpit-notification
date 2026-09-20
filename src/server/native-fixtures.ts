import type { NativeChatEvent, NativeObservation } from '@cockpit/module-api';
import type { MessageKey } from '../shared/protocol.ts';

export const key = (nativeId: string, sessionId = 'session-a', kind: MessageKey['kind'] = 'reply'): MessageKey =>
  ({ sessionId, kind, nativeId });
let eventNumber = 0;
export function observation(type: string, data: Record<string, unknown> = {}, extra: Partial<NativeChatEvent> = {},
  sessionId = 'session-a'): NativeObservation {
  return { sessionId, cwd: null, event: { id: `event-${++eventNumber}`, type, data, ...extra } };
}
export function turn(nativeId = 'reply-a', data: Record<string, unknown> = {}, sessionId = 'session-a'): NativeObservation[] {
  return [
    observation('assistant.turn_start', { turnId: '0' }, {}, sessionId),
    ...message(nativeId, data, sessionId),
    observation('assistant.turn_end', { turnId: '0' }, {}, sessionId),
    observation('assistant.idle', {}, { ephemeral: true }, sessionId),
  ];
}
export function message(nativeId = 'reply-a', data: Record<string, unknown> = {}, sessionId = 'session-a'): NativeObservation[] {
  return [
    observation('assistant.message_start', { messageId: nativeId }, { ephemeral: true }, sessionId),
    observation('assistant.message_delta', { messageId: nativeId, deltaContent: 'synthetic-stream-text' }, { ephemeral: true }, sessionId),
    observation('assistant.message', { messageId: nativeId, turnId: '0', content: 'synthetic-secret-body',
      phase: 'final_answer', ...data }, {}, sessionId),
  ];
}
