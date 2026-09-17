import assert from 'node:assert/strict';
import test from 'node:test';
import { keyId, parseKeys, parsePayload, parseSnapshot, snapshotKeys } from './protocol.ts';

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
