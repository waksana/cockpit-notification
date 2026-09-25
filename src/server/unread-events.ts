import type { ModuleEventPayload } from '@waksana/cockpit-module-sdk';
import { MAX_MODULE_EVENT_BYTES } from '@waksana/cockpit-module-sdk/runtime';
import { MAX_UNREAD, type UnreadDelta } from '../shared/protocol.ts';

export const MAX_UNREAD_EVENT_BYTES = MAX_MODULE_EVENT_BYTES;

export function unreadEvent(delta: UnreadDelta): ModuleEventPayload {
  if (delta.added.length + delta.removed.length > MAX_UNREAD ||
      Buffer.byteLength(JSON.stringify(delta), 'utf8') > MAX_UNREAD_EVENT_BYTES) {
    return { type: 'unread/sync' as const, generation: delta.generation, revision: delta.revision };
  }
  return { ...delta, added: delta.added.map(key => ({ ...key })), removed: delta.removed.map(key => ({ ...key })) };
}
