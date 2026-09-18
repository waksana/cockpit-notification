import assert from 'node:assert/strict';
import test from 'node:test';
import { applyUnreadDelta, keyId, parseKeys, parsePayload, parseReadResult, parseSnapshot,
  parseUnreadEvent, snapshotKeys } from './protocol.ts';

const key = { sessionId: 'session-a', kind: 'reply' as const, nativeId: 'message-a' };
const snapshot = { generation: 'fixture-generation', revision: 3, complete: true,
  total: 1, sessions: [{ sessionId: key.sessionId, count: 1,
    items: [{ kind: key.kind, nativeId: key.nativeId, createdRevision: 1 }] }] };

test('snapshots require a complete unique set and exact derived totals', () => {
  const result = parseSnapshot(snapshot);
  assert.equal(snapshotKeys(result).get(keyId(key))?.nativeId, key.nativeId);
  for (const bad of [
    { ...snapshot, complete: false }, { ...snapshot, total: 0 },
    { ...snapshot, sessions: [...snapshot.sessions, ...snapshot.sessions], total: 2 },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], count: 2 }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], items: [{ kind: 'reply', nativeId: 'a', createdRevision: 4 }] }] },
  ]) assert.throws(() => parseSnapshot(bad));
});

test('read keys are namespaced, bounded and deduplicated before atomic processing', () => {
  assert.deepEqual(parseKeys([key, key]), [key]);
  assert.notEqual(keyId(key), keyId({ ...key, kind: 'ask' }));
  assert.notEqual(keyId(key), keyId({ ...key, sessionId: 'session-b' }));
  for (const bad of [[], [null], [{ ...key, nativeId: '' }], Array(129).fill(key), [{ ...key, extra: true }]]) {
    assert.throws(() => parseKeys(bad));
  }
});

test('push payload retains identity and version coverage without becoming a full snapshot', () => {
  const push = { moduleId: 'cockpit-notification', generation: snapshot.generation, key,
    createdRevision: 1, revision: 3, total: 1, title: '新回复', body: '会话有新回复', navigationTarget: 'session/session-a' };
  assert.deepEqual(parsePayload(push), push);
  assert.throws(() => parseSnapshot(push));
  for (const bad of [{ ...push, total: -1 }, { ...push, moduleId: 'another-module' },
    { ...push, createdRevision: 4 }, { ...push, key: { ...key, kind: 'tool' } }]) {
    assert.throws(() => parsePayload(bad));
  }
});

test('delta versions form one atomic transition and update identity sets without mutating the base', () => {
  const before = parseSnapshot(snapshot);
  const other = { ...key, sessionId: 'session-b', nativeId: 'message-b' };
  const delta = parseUnreadEvent({ type: 'unread/delta', generation: before.generation,
    fromRevision: 3, revision: 4, added: [{ ...other, createdRevision: 4 }], removed: [key] });
  assert.equal(delta.type, 'unread/delta');
  if (delta.type !== 'unread/delta') return assert.fail('Expected delta');
  const after = applyUnreadDelta(before, delta);
  assert.equal(after.revision, 4);
  assert.equal(after.total, 1);
  assert.deepEqual([...snapshotKeys(after).values()], [other]);
  assert.equal(before.sessions[0]!.sessionId, 'session-a');
  assert.throws(() => applyUnreadDelta(after, delta), /continue/);
  assert.throws(() => applyUnreadDelta({ ...before, generation: 'another' }, delta), /continue/);
});

test('duplicate identities, conflicting actions and gaps are invalid delta payloads', () => {
  const delta = { type: 'unread/delta', generation: 'fixture-generation', fromRevision: 0, revision: 1,
    added: [{ ...key, createdRevision: 1 }], removed: [] };
  for (const bad of [
    { ...delta, revision: 2 }, { ...delta, fromRevision: -1 },
    { ...delta, added: [delta.added[0], delta.added[0]] },
    { ...delta, removed: [key] }, { ...delta, added: [{ ...key, createdRevision: 0 }] },
    { ...delta, added: [], removed: [key, key] }, { ...delta, added: Array(10_001).fill(delta.added[0]) },
    { ...delta, extra: true },
  ]) assert.throws(() => parseUnreadEvent(bad));
  assert.deepEqual(parseUnreadEvent({ type: 'unread/sync', generation: 'new-generation', revision: 0 }),
    { type: 'unread/sync', generation: 'new-generation', revision: 0 });
});

test('early acknowledgements may advance an empty set and receipts never contain unread state', () => {
  const empty = parseSnapshot({ generation: 'fixture-generation', revision: 0, complete: true, total: 0, sessions: [] });
  const delta = parseUnreadEvent({ type: 'unread/delta', generation: empty.generation,
    fromRevision: 0, revision: 1, added: [], removed: [key] });
  if (delta.type !== 'unread/delta') return assert.fail('Expected delta');
  assert.deepEqual(applyUnreadDelta(empty, delta), { ...empty, revision: 1 });
  const receipt = { generation: empty.generation, revision: 1, acknowledged: [key] };
  assert.deepEqual(parseReadResult(receipt), receipt);
  assert.throws(() => parseReadResult({ ...receipt, state: empty }));
  assert.throws(() => parseReadResult({ ...receipt, acknowledged: [key, key] }));
});
