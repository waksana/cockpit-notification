import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from './ledger.ts';
import { MAX_UNREAD_EVENT_BYTES, unreadEvent } from './unread-events.ts';
import { MAX_UNREAD, parseUnreadEvent, type MessageKey, type UnreadDelta } from '../shared/protocol.ts';

const key = (nativeId: string): MessageKey => ({ sessionId: 's', kind: 'reply', nativeId });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('normal publication contains the whole atomic delta and its captured version, never a snapshot hint', () => {
  const ledger = new Ledger();
  ledger.transition([key('old')]);
  const change = ledger.transition([key('new')], [key('old'), key('staged')]);
  if (!change.changed) throw new Error('Expected a ledger change');
  ledger.read(ledger.generation, [key('later')]);
  const payload = unreadEvent(change.delta);
  assert.deepEqual(parseUnreadEvent(payload), {
    type: 'unread/delta', generation: ledger.generation, fromRevision: 1, revision: 2,
    added: [{ ...key('new'), createdRevision: 2 }], removed: [key('old'), key('staged')],
  });
  assert.equal(ledger.snapshot().revision, 3);
});

test('the host 64 KiB boundary includes an exact-size delta and replaces an oversized one atomically', () => {
  const delta: UnreadDelta = {
    type: 'unread/delta', generation: 'generation', fromRevision: 0, revision: 1, added: [],
    removed: Array.from({ length: 256 }, (_, index) => key(`${index}:`)),
  };
  let remaining = MAX_UNREAD_EVENT_BYTES - bytes(delta);
  for (const entry of delta.removed) {
    for (const field of ['sessionId', 'nativeId'] as const) {
      const count = Math.min(remaining, 200 - entry[field].length);
      entry[field] += 'x'.repeat(count);
      remaining -= count;
    }
  }
  assert.equal(remaining, 0);
  assert.equal(bytes(delta), MAX_UNREAD_EVENT_BYTES);
  assert.deepEqual(parseUnreadEvent(unreadEvent(delta)), delta);
  delta.generation += 'x';
  assert.equal(bytes(delta), MAX_UNREAD_EVENT_BYTES + 1);
  assert.deepEqual(parseUnreadEvent(unreadEvent(delta)), {
    type: 'unread/sync', generation: delta.generation, revision: 1,
  });
});

test('budget measures UTF-8 bytes, not JavaScript characters, without truncation or chunks', () => {
  const ledger = new Ledger();
  const change = ledger.transition(Array.from({ length: 128 }, (_, index) => key(`${index}:${'界'.repeat(196)}`)));
  if (!change.changed) throw new Error('Expected a ledger change');
  assert.ok(JSON.stringify(change.delta).length < MAX_UNREAD_EVENT_BYTES);
  assert.ok(bytes(change.delta) > MAX_UNREAD_EVENT_BYTES);
  assert.deepEqual(unreadEvent(change.delta), {
    type: 'unread/sync', generation: ledger.generation, revision: 1,
  });
  assert.equal(ledger.snapshot().total, 128);
});

test('a retirement beyond the 10000-entry parser cap publishes only its committed synchronization checkpoint', () => {
  const ledger = new Ledger();
  const keys = Array.from({ length: MAX_UNREAD }, (_, index) => key(String(index)));
  ledger.transition(keys);
  const change = ledger.transition([], [...keys, key('staged')]);
  if (!change.changed) throw new Error('Expected a ledger change');
  assert.equal(change.delta.removed.length, MAX_UNREAD + 1);
  assert.deepEqual(unreadEvent(change.delta), {
    type: 'unread/sync', generation: ledger.generation, revision: 2,
  });
  assert.equal(ledger.snapshot().total, 0);
  assert.equal(ledger.transition([key('staged')]).changed, false);
});
