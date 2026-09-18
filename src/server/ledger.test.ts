import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from './ledger.ts';
import { BackendError } from './errors.ts';
import { parseSnapshot } from '../shared/protocol.ts';
import { key } from './test-fixtures.ts';

test('ledger snapshots are deterministic, exact and isolated from caller mutation', () => {
  const ledger = new Ledger();
  ledger.transition([key('z', 'z'), key('z'), key('a', 'session-a', 'ask'), key('a')]);
  const snapshot = parseSnapshot(ledger.snapshot());
  assert.equal(snapshot.total, 4);
  assert.deepEqual(snapshot.sessions.map(session => session.sessionId), ['session-a', 'z']);
  assert.deepEqual(snapshot.sessions[0]!.items.map(item => [item.kind, item.nativeId]),
    [['ask', 'a'], ['reply', 'a'], ['reply', 'z']]);
  assert.equal(snapshot.revision, 1);
  snapshot.sessions[0]!.items[0]!.nativeId = 'mutated';
  assert.equal(ledger.snapshot().sessions[0]!.items[0]!.nativeId, 'a');
  const supplied = key('copied');
  ledger.transition([supplied]);
  supplied.nativeId = 'changed';
  assert.ok(ledger.get(key('copied')));
});

test('early read, duplicate NEW and two-client batch acknowledgments are idempotent', () => {
  const ledger = new Ledger();
  const first = ledger.read(ledger.generation, [key('early'), key('early')]);
  assert.equal(first.result.state.revision, 1);
  assert.equal(first.result.acknowledged.length, 1);
  assert.equal(ledger.transition([key('early')]).changed, false);
  ledger.transition([key('a'), key('b'), key('c')]);
  const left = ledger.read(ledger.generation, [key('a'), key('b')]);
  const right = ledger.read(ledger.generation, [key('a'), key('b')]);
  assert.deepEqual(left.result, right.result);
  assert.equal(right.result.state.total, 1);
  assert.equal(right.result.state.revision, 3);
  assert.equal(ledger.transition([key('a'), key('b'), key('c')]).changed, false);
});

test('identity and unread capacity reject entire batches without evicting', () => {
  const ledger = new Ledger({ unread: 2, identities: 3 });
  ledger.transition([key('a'), key('b')]);
  const before = ledger.snapshot();
  assert.throws(() => ledger.transition([key('c')]), { code: 'UNREAD_CAPACITY' });
  assert.deepEqual(ledger.snapshot(), before);
  assert.throws(() => ledger.read(ledger.generation, [key('a'), key('c'), key('d')]), { code: 'IDENTITY_CAPACITY' });
  assert.deepEqual(ledger.snapshot(), before);
  ledger.read(ledger.generation, [key('a')]);
  ledger.transition([key('c')]);
  assert.equal(ledger.snapshot().total, 2);
  ledger.read(ledger.generation, [key('b'), key('c')]);
  assert.throws(() => ledger.transition([key('d')]), { code: 'IDENTITY_CAPACITY' });
  assert.equal(ledger.snapshot().total, 0);
});

test('retirement plus replacement is atomic and keeps acknowledged tombstones', () => {
  const ledger = new Ledger({ unread: 1, identities: 3 });
  ledger.transition([key('old', 's', 'ask')]);
  const change = ledger.transition([key('new', 's', 'ask')], [key('old', 's', 'ask')]);
  assert.equal(change.added.length, 1);
  assert.equal(change.removed.length, 1);
  assert.equal(ledger.snapshot().revision, 2);
  assert.equal(ledger.transition([key('old', 's', 'ask')]).changed, false);
});

test('generation mismatch and malformed trailing identity cannot partially mutate', () => {
  const ledger = new Ledger();
  ledger.transition([key('a')]);
  const before = ledger.snapshot();
  assert.throws(() => ledger.read('old-generation', [key('a')]), (error: unknown) =>
    error instanceof BackendError && error.code === 'GENERATION_MISMATCH' && error.status === 409);
  assert.throws(() => ledger.transition([], [key('a'), key('bad id')]), { code: 'INVALID_IDENTITY' });
  assert.deepEqual(ledger.snapshot(), before);
  assert.notEqual(new Ledger().generation, ledger.generation);
});

test('disposal clears retained unread/tombstones and refuses all later mutations and snapshots', () => {
  const ledger = new Ledger();
  ledger.transition([key('unread')]);
  ledger.read(ledger.generation, [key('tombstone')]);
  ledger.dispose();
  ledger.dispose();
  assert.equal(ledger.get(key('unread')), undefined);
  assert.deepEqual(ledger.keysForSession('session-a'), []);
  assert.throws(() => ledger.snapshot(), { code: 'STOPPED' });
  assert.throws(() => ledger.transition([key('late')]), { code: 'STOPPED' });
  assert.throws(() => ledger.read(ledger.generation, [key('late')]), { code: 'STOPPED' });
});
