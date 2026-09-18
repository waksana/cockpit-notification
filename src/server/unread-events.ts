import type { ModuleEventPayload } from '@cockpit/module-api';
import { MAX_UNREAD, type UnreadDelta } from '../shared/protocol.ts';

// Paired with the host's MAX_MODULE_EVENT_BYTES; keep SDK imports type-only in the backend bundle.
export const MAX_UNREAD_EVENT_BYTES = 64 * 1024;

export function unreadEvent(delta: UnreadDelta): ModuleEventPayload {
  if (delta.added.length + delta.removed.length > MAX_UNREAD ||
      Buffer.byteLength(JSON.stringify(delta), 'utf8') > MAX_UNREAD_EVENT_BYTES) {
    return { type: 'unread/sync' as const, generation: delta.generation, revision: delta.revision };
  }
  return { ...delta, added: delta.added.map(key => ({ ...key })), removed: delta.removed.map(key => ({ ...key })) };
}
