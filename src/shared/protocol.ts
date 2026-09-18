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
  state: Snapshot;
}
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
