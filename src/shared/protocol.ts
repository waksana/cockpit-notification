export const MAX_BATCH = 128;
export const MAX_UNREAD = 10_000;
export const MAX_IDENTITIES = 100_000;

export interface MessageKey {
  sessionId: string;
  kind: 'reply' | 'ask';
  nativeId: string;
}
export interface UnreadItem {
  kind: MessageKey['kind'];
  nativeId: string;
  createdRevision: number;
}
export interface Snapshot {
  generation: string;
  revision: number;
  complete: true;
  total: number;
  sessions: { sessionId: string; count: number; items: UnreadItem[] }[];
}
export interface ReadResult {
  acknowledged: MessageKey[];
  generation: string;
  revision: number;
}
export interface UnreadDelta {
  type: 'unread/delta';
  generation: string;
  fromRevision: number;
  revision: number;
  added: (MessageKey & { createdRevision: number })[];
  removed: MessageKey[];
}
export interface UnreadSyncHint {
  type: 'unread/sync';
  generation: string;
  revision: number;
}
export type UnreadEvent = UnreadDelta | UnreadSyncHint;
export interface NotificationPayload {
  moduleId: 'cockpit-notification';
  generation: string;
  key: MessageKey;
  createdRevision: number;
  revision: number;
  total: number;
  title: string;
  body: string;
  navigationTarget: string;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value);
}
export function keyId(key: MessageKey): string {
  return JSON.stringify([key.sessionId, key.kind, key.nativeId]);
}
export function parseKey(value: unknown): MessageKey {
  if (!record(value) || !identity(value.sessionId) || !identity(value.nativeId) ||
      !['reply', 'ask'].includes(String(value.kind)) ||
      Object.keys(value).some(key => !['sessionId', 'kind', 'nativeId'].includes(key))) {
    throw new Error('Invalid message identity');
  }
  return { sessionId: value.sessionId, kind: value.kind as MessageKey['kind'], nativeId: value.nativeId };
}
export function parseKeys(value: unknown): MessageKey[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH) throw new Error('Invalid read batch');
  const keys = value.map(parseKey);
  return [...new Map(keys.map(key => [keyId(key), key])).values()];
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
export function parseReadResult(value: unknown): ReadResult {
  if (!record(value) || !identity(value.generation) || !integer(value.revision) ||
      Object.keys(value).some(key => !['generation', 'revision', 'acknowledged'].includes(key))) {
    throw new Error('Invalid read receipt');
  }
  const acknowledged = parseKeys(value.acknowledged);
  if (!Array.isArray(value.acknowledged) || acknowledged.length !== value.acknowledged.length) {
    throw new Error('Duplicate read acknowledgement');
  }
  return { generation: value.generation, revision: value.revision, acknowledged };
}
export function parseUnreadEvent(value: unknown): UnreadEvent {
  if (!record(value) || !identity(value.generation) || !integer(value.revision)) {
    throw new Error('Invalid unread event version');
  }
  const { generation, revision } = value;
  if (value.type === 'unread/sync') {
    if (Object.keys(value).some(key => !['type', 'generation', 'revision'].includes(key))) {
      throw new Error('Invalid unread synchronization hint');
    }
    return { type: 'unread/sync', generation, revision };
  }
  if (value.type !== 'unread/delta' || !integer(value.fromRevision) ||
      value.fromRevision === Number.MAX_SAFE_INTEGER || revision !== value.fromRevision + 1 ||
      !Array.isArray(value.added) || !Array.isArray(value.removed) ||
      value.added.length + value.removed.length > MAX_UNREAD ||
      Object.keys(value).some(key => !['type', 'generation', 'fromRevision', 'revision', 'added', 'removed'].includes(key))) {
    throw new Error('Invalid unread delta');
  }
  const seen = new Set<string>();
  const unique = (key: MessageKey) => {
    const id = keyId(key);
    if (seen.has(id)) throw new Error('Conflicting unread delta identity');
    seen.add(id);
    return key;
  };
  const added = value.added.map(item => {
    if (!record(item) || item.createdRevision !== revision) throw new Error('Invalid added unread revision');
    const { createdRevision, ...rest } = item;
    return { ...unique(parseKey(rest)), createdRevision: revision };
  });
  const removed = value.removed.map(item => unique(parseKey(item)));
  return { type: 'unread/delta', generation, fromRevision: value.fromRevision, revision, added, removed };
}

export function applyUnreadDelta(snapshot: Snapshot, delta: UnreadDelta): Snapshot {
  if (snapshot.generation !== delta.generation || snapshot.revision !== delta.fromRevision) {
    throw new Error('Unread delta does not continue the current snapshot');
  }
  const entries = new Map(snapshot.sessions.flatMap(session => session.items.map(item => {
    const key = { sessionId: session.sessionId, kind: item.kind, nativeId: item.nativeId };
    return [keyId(key), { ...key, createdRevision: item.createdRevision }] as const;
  })));
  for (const item of delta.removed) entries.delete(keyId(item));
  for (const item of delta.added) {
    const id = keyId(item);
    if (entries.has(id)) throw new Error('Unread delta re-adds an existing identity');
    entries.set(id, item);
  }
  if (entries.size > MAX_UNREAD) throw new Error('Unread delta exceeds capacity');
  const sessions = new Map<string, Snapshot['sessions'][number]>();
  for (const item of [...entries.values()].sort((a, b) => keyId(a).localeCompare(keyId(b)))) {
    let session = sessions.get(item.sessionId);
    if (!session) {
      session = { sessionId: item.sessionId, count: 0, items: [] };
      sessions.set(item.sessionId, session);
    }
    session.items.push({ kind: item.kind, nativeId: item.nativeId, createdRevision: item.createdRevision });
    session.count++;
  }
  return { generation: delta.generation, revision: delta.revision, complete: true,
    total: entries.size, sessions: [...sessions.values()] };
}
export function parseSnapshot(value: unknown): Snapshot {
  if (!record(value) || !identity(value.generation) || !integer(value.revision) ||
      value.complete !== true || !integer(value.total, MAX_UNREAD) ||
      !Array.isArray(value.sessions) || value.sessions.length > MAX_UNREAD) throw new Error('Invalid unread snapshot');
  const seenSessions = new Set<string>();
  let total = 0;
  const sessions = value.sessions.map(session => {
    if (!record(session) || !identity(session.sessionId) || seenSessions.has(session.sessionId) ||
        !integer(session.count, MAX_UNREAD) || session.count === 0 ||
        !Array.isArray(session.items) || session.items.length !== session.count) throw new Error('Invalid session summary');
    seenSessions.add(session.sessionId);
    const seen = new Set<string>();
    const items = session.items.map((item): UnreadItem => {
      if (!record(item) || !identity(item.nativeId) ||
          (item.kind !== 'reply' && item.kind !== 'ask') || !integer(item.createdRevision) ||
          item.createdRevision === 0 || item.createdRevision > Number(value.revision)) throw new Error('Invalid unread item');
      const id = JSON.stringify([item.kind, item.nativeId]);
      if (seen.has(id)) throw new Error('Duplicate unread item');
      seen.add(id);
      return { kind: item.kind, nativeId: item.nativeId, createdRevision: item.createdRevision };
    });
    total += session.count;
    if (total > MAX_UNREAD) throw new Error('Unread snapshot exceeds capacity');
    return { sessionId: session.sessionId, count: session.count, items };
  });
  if (total !== value.total) throw new Error('Unread snapshot totals disagree');
  return { generation: value.generation, revision: value.revision, complete: true, total, sessions };
}
export function snapshotKeys(snapshot: Snapshot): Map<string, MessageKey> {
  return new Map(snapshot.sessions.flatMap(session => session.items.map(item => {
    const key: MessageKey = { sessionId: session.sessionId, kind: item.kind, nativeId: item.nativeId };
    return [keyId(key), key] as const;
  })));
}
export function parsePayload(value: unknown): NotificationPayload {
  if (!record(value) || value.moduleId !== 'cockpit-notification' || !identity(value.generation) ||
      !integer(value.revision) || !integer(value.createdRevision) || value.createdRevision === 0 ||
      value.createdRevision > value.revision || !integer(value.total, MAX_UNREAD) ||
      typeof value.title !== 'string' || value.title.length > 160 || !value.title ||
      typeof value.body !== 'string' || value.body.length > 512 ||
      typeof value.navigationTarget !== 'string' || value.navigationTarget.length > 1024) throw new Error('Invalid push payload');
  const key = parseKey(value.key);
  return { moduleId: 'cockpit-notification', generation: value.generation, key,
    createdRevision: value.createdRevision, revision: value.revision, total: value.total,
    title: value.title, body: value.body, navigationTarget: value.navigationTarget };
}
