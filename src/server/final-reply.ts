import type { NativeObservation } from '@cockpit/module-api';
import { identity, record } from '../shared/protocol.ts';
import { BackendError } from './errors.ts';
import { notificationExcerpt, type NotificationPreview } from './preview.ts';

export function finalReply({ sessionId, event }: NativeObservation): NotificationPreview | undefined {
  if (!record(event) || event.type !== 'assistant.message' || event.ephemeral === true || !record(event.data)) return;
  const data = event.data;
  // One rule for every provider: a primary message without tool requests hands control back, so `phase` is ignored.
  if ([event.agentId, event.parentToolCallId, data.agentId, data.parentToolCallId]
    .some(value => value !== undefined && value !== null && value !== '')) return;
  if (data.toolRequests !== undefined && (!Array.isArray(data.toolRequests) || data.toolRequests.length > 0)) return;
  if (typeof data.content !== 'string' || !data.content.trim()) return;
  if (!identity(sessionId) || !identity(data.messageId)) {
    throw new BackendError('INVALID_REPLY_IDENTITY', 'Final reply has an invalid notification identity');
  }
  return { key: { sessionId, kind: 'reply', nativeId: data.messageId }, summary: notificationExcerpt(data.content) };
}
