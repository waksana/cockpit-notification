import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from './ledger.ts';
import { BackendError } from './errors.ts';
import { applyUnreadDelta, parseReadResult, parseSnapshot, parseUnreadEvent } from '../shared/protocol.ts';
import { key } from './native-fixtures.ts';

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
  assert.equal(parseReadResult(first.result).revision, 1);
  assert.equal(first.result.acknowledged.length, 1);
  assert.equal(ledger.transition([key('early')]).changed, false);
  ledger.transition([key('a'), key('b'), key('c')]);
  const left = ledger.read(ledger.generation, [key('a'), key('b')]);
  const right = ledger.read(ledger.generation, [key('a'), key('b')]);
  assert.deepEqual(left.result, right.result);
  assert.equal(ledger.snapshot().total, 1);
  assert.equal(right.result.revision, 3);
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

test('each committed transition carries its exact contiguous delta, including early READ and retirement', () => {
  const ledger = new Ledger();
  let replica = ledger.snapshot();
  const changes = [
    ledger.read(ledger.generation, [key('early')]).change,
    ledger.transition([key('a'), key('b'), key('early')]),
    ledger.transition([key('new')], [key('a'), key('staged')]),
    ledger.read(ledger.generation, [key('b'), key('early'), key('staged')]).change,
  ];
  for (const change of changes) {
    assert.equal(change.changed, true);
    if (!change.changed) throw new Error('Expected a ledger change');
    assert.deepEqual(parseUnreadEvent(change.delta), change.delta);
    replica = applyUnreadDelta(replica, change.delta);
  }
  assert.deepEqual(replica, ledger.snapshot());
  assert.equal(replica.revision, 4);
  assert.deepEqual(changes[0]!.removed, [key('early')]);
  assert.deepEqual(changes[2]!.removed, [key('a'), key('staged')]);
  assert.deepEqual(changes[3]!.removed, [key('b')]);
  const duplicate = ledger.read(ledger.generation, [key('a'), key('staged')]);
  assert.deepEqual(duplicate.change, { changed: false, added: [], removed: [] });
  assert.deepEqual(duplicate.result, {
    generation: ledger.generation, revision: 4, acknowledged: [key('a'), key('staged')],
  });
  assert.deepEqual(ledger.transition([key('a'), key('new')]), { changed: false, added: [], removed: [] });
  assert.deepEqual(ledger.transition([]), { changed: false, added: [], removed: [] });
  assert.deepEqual(ledger.snapshot(), replica);
});

test('delta and read receipt mutation cannot change retained identities or versions', () => {
  const ledger = new Ledger();
  const change = ledger.transition([key('a')]);
  assert.equal(change.changed, true);
  if (!change.changed) throw new Error('Expected a ledger change');
  change.delta.added[0]!.nativeId = 'changed';
  change.delta.revision = 100;
  change.added[0]!.key.nativeId = 'changed-again';
  assert.equal(ledger.get(key('a'))!.createdRevision, 1);
  const receipt = ledger.read(ledger.generation, [key('a')]);
  receipt.result.acknowledged[0]!.nativeId = 'other';
  receipt.result.revision = 200;
  assert.equal(ledger.transition([key('a')]).changed, false);
  assert.equal(ledger.snapshot().revision, 2);
});

test('retiring an unseen key does not free unread capacity or partially install a tombstone', () => {
  const ledger = new Ledger({ unread: 1, identities: 10 });
  ledger.transition([key('existing')]);
  const before = ledger.snapshot();
  assert.throws(() => ledger.transition([key('extra')], [key('unseen')]), { code: 'UNREAD_CAPACITY' });
  assert.deepEqual(ledger.snapshot(), before);
  assert.equal(ledger.transition([key('unseen')], [key('existing')]).added.length, 1);
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
