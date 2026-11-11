import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from './ledger.ts';
import { PushScheduler, type SendResult } from './push.ts';
import { settings, SubscriptionStore } from './storage.ts';
import { sendResult, directory, FakeClock, flush, key, subscription } from './test-fixtures.ts';
import type { NotificationPayload } from '../shared/protocol.ts';
import { chmodSync } from 'node:fs';

test('each device attempt retains ACCEPTED, FAILED or UNKNOWN without changing ledger identity', async t => {
  for (const result of ['ACCEPTED', 'FAILED', 'UNKNOWN'] as const) {
    const store = new SubscriptionStore(directory(t), settings({}));
    const clock = new FakeClock();
    const id = store.register(subscription(result), clock.now());
    const ledger = new Ledger();
    const errors: unknown[] = [];
    let sends = 0;
    const scheduler = new PushScheduler(ledger, store, clock, async () => { sends++; return sendResult(result); },
      3000, error => errors.push(error));
    t.after(() => scheduler.stop());
    const entry = ledger.transition([key(result)]).added[0]!;
    scheduler.schedule(entry);
    scheduler.schedule(entry);
    assert.deepEqual(scheduler.inspect(entry.key), { state: 'WAITING', attempts: {} });
    await clock.advance(3000);
    assert.deepEqual(scheduler.inspect(entry.key), { state: 'DISPATCHED', attempts: { [id]: result } });
    assert.equal(ledger.snapshot().total, 1);
    assert.equal(ledger.snapshot().revision, 1);
    scheduler.schedule(entry);
    await clock.advance(30_000);
    assert.equal(sends, 1);
    assert.equal(errors.length, result === 'ACCEPTED' ? 0 : 1);
  }
});

test('each asynchronous send checks current revision, subscription membership and current subscription keys', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  for (const name of ['one', 'two', 'three']) store.register(subscription(name), clock.now());
  const devices = store.active(clock.now());
  const ledger = new Ledger();
  const payloads: NotificationPayload[] = [];
  const sentAuth: string[] = [];
  let complete!: (value: SendResult) => void;
  const scheduler = new PushScheduler(ledger, store, clock, async (device, payload) => {
    payloads.push(payload);
    sentAuth.push(device.subscription.keys.auth);
    return payloads.length === 1 ? new Promise(resolve => { complete = resolve; }) : sendResult('ACCEPTED');
  }, 3000, () => {});
  t.after(() => scheduler.stop());
  const entry = ledger.transition([key('first')]).added[0]!;
  scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(payloads.length, 1);
  store.remove(devices[1]!.id);
  const changedAuth = Buffer.alloc(16, 9).toString('base64url');
  store.register({ ...devices[2]!.subscription, keys: {
    ...devices[2]!.subscription.keys, auth: changedAuth,
  } }, clock.now());
  ledger.transition([key('second')]);
  complete(sendResult('ACCEPTED'));
  await flush();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0]!.revision, 1);
  assert.equal(payloads[1]!.revision, 2);
  assert.equal(payloads[1]!.total, 2);
  assert.equal(sentAuth[1], changedAuth);
  assert.equal(scheduler.inspect(entry.key)!.attempts[devices[1]!.id], 'CANCELLED');
});

test('no-target plans remain terminal; cancelled timer callback cannot send', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  const ledger = new Ledger();
  let sends = 0;
  const scheduler = new PushScheduler(ledger, store, clock, async () => { sends++; return sendResult('ACCEPTED'); },
    3000, () => {});
  t.after(() => scheduler.stop());
  const entry = ledger.transition([key('absent-device')]).added[0]!;
  scheduler.schedule(entry);
  await clock.advance(3000);
  assert.deepEqual(scheduler.inspect(entry.key), { state: 'NO_TARGETS', attempts: {} });
  store.register(subscription(), clock.now());
  scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(sends, 0);
  const waiting = ledger.transition([key('waiting')]).added[0]!;
  scheduler.schedule(waiting);
  const lateCallback = [...clock.timers.values()][0]!.callback;
  ledger.read(ledger.generation, [waiting.key]);
  scheduler.cancel(waiting.key);
  lateCallback();
  await flush();
  assert.equal(sends, 0);
});

test('sender concurrency is bounded to four across all messages and devices', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  store.register(subscription('one'), clock.now());
  store.register(subscription('two'), clock.now());
  const ledger = new Ledger();
  let active = 0;
  let peak = 0;
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const scheduler = new PushScheduler(ledger, store, clock, async (device, payload) => {
    active++;
    peak = Math.max(peak, active);
    sent.push(`${payload.key.nativeId}:${device.id}`);
    return new Promise(resolve => { pending.push(() => { active--; resolve(sendResult('ACCEPTED')); }); });
  }, 3000, () => {});
  t.after(() => scheduler.stop());
  const entries = ledger.transition(Array.from({ length: 8 }, (_, index) => key(`message-${index}`))).added;
  for (const entry of entries) scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(sent.length, 4);
  assert.equal(active, 4);
  for (let batch = 0; batch < 8 && pending.length; batch++) {
    for (const complete of pending.splice(0)) complete();
    await flush();
  }
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(sent.length, 16);
  assert.equal(new Set(sent).size, 16);
  assert.equal(ledger.snapshot().total, 8);
});

test('queued READ cancels unsent work and the next acquired slot uses the current ledger snapshot', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  store.register(subscription(), clock.now());
  const ledger = new Ledger();
  const payloads: NotificationPayload[] = [];
  const pending: (() => void)[] = [];
  const scheduler = new PushScheduler(ledger, store, clock, async (_device, payload) => {
    payloads.push(payload);
    return new Promise(resolve => { pending.push(() => resolve(sendResult('ACCEPTED'))); });
  }, 3000, () => {});
  t.after(() => scheduler.stop());
  const entries = ledger.transition(Array.from({ length: 6 }, (_, index) => key(`message-${index}`))).added;
  for (const entry of entries) scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(payloads.length, 4);
  ledger.read(ledger.generation, [entries[4]!.key]);
  scheduler.cancel(entries[4]!.key);
  pending.shift()!();
  await flush();
  assert.equal(payloads.length, 5);
  assert.equal(payloads[4]!.key.nativeId, 'message-5');
  assert.equal(payloads[4]!.revision, 2);
  assert.equal(payloads[4]!.total, 5);
  for (const complete of pending.splice(0)) complete();
  await flush();
  assert.ok(!payloads.some(payload => payload.key.nativeId === 'message-4'));
});

test('queued subscription removal and reserved-slot READ are rechecked before the sender starts', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  const id = store.register(subscription(), clock.now());
  const ledger = new Ledger();
  let sends = 0;
  const pending: (() => void)[] = [];
  const scheduler = new PushScheduler(ledger, store, clock, async () => {
    sends++;
    return new Promise(resolve => { pending.push(() => resolve(sendResult('ACCEPTED'))); });
  }, 3000, () => {});
  t.after(() => scheduler.stop());
  const raced = ledger.transition([key('reserved')]).added[0]!;
  scheduler.schedule(raced);
  const timer = [...clock.timers.values()][0]!;
  timer.callback();
  ledger.read(ledger.generation, [raced.key]);
  scheduler.cancel(raced.key);
  await flush();
  assert.equal(sends, 0);
  const entries = ledger.transition(Array.from({ length: 6 }, (_, index) => key(`message-${index}`))).added;
  for (const entry of entries) scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(sends, 4);
  store.remove(id);
  for (const complete of pending.splice(0)) complete();
  await flush();
  assert.equal(sends, 4);
  for (const entry of entries.slice(4)) assert.equal(scheduler.inspect(entry.key)!.attempts[id], 'CANCELLED');
});

test('STOP releases queued sends, aborts active ones, and late results cannot start more work', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  store.register(subscription(), clock.now());
  const ledger = new Ledger();
  const signals: AbortSignal[] = [];
  const pending: (() => void)[] = [];
  const errors: unknown[] = [];
  const scheduler = new PushScheduler(ledger, store, clock, async (_device, _payload, signal) => {
    signals.push(signal);
    return new Promise(resolve => { pending.push(() => resolve(sendResult('UNKNOWN'))); });
  }, 3000, error => errors.push(error));
  const entries = ledger.transition(Array.from({ length: 10 }, (_, index) => key(`message-${index}`))).added;
  for (const entry of entries) scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(signals.length, 4);
  scheduler.stop();
  ledger.dispose();
  await flush();
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(clock.timers.size, 0);
  for (const entry of entries) assert.equal(scheduler.inspect(entry.key), undefined);
  for (const complete of pending.splice(0)) complete();
  await flush();
  await clock.advance(30_000);
  assert.equal(signals.length, 4);
  assert.deepEqual(errors, []);
  assert.equal(ledger.get(entries[0]!.key), undefined);
});

test('subscription cancellation is terminal for READY attempts without cancelling other devices', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  const first = subscription('first');
  const firstId = store.register(first, clock.now());
  const secondId = store.register(subscription('second'), clock.now());
  const ledger = new Ledger();
  const sent: { id: string; message: string }[] = [];
  const pending: (() => void)[] = [];
  const scheduler = new PushScheduler(ledger, store, clock, async (device, payload) => {
    sent.push({ id: device.id, message: payload.key.nativeId });
    return new Promise(resolve => { pending.push(() => resolve(sendResult('ACCEPTED'))); });
  }, 3000, () => {});
  t.after(() => scheduler.stop());
  const entries = ledger.transition(Array.from({ length: 5 }, (_, index) => key(`message-${index}`))).added;
  for (const entry of entries) scheduler.schedule(entry);
  await clock.advance(3000);
  assert.equal(sent.length, 4);
  assert.equal(scheduler.inspect(entries[4]!.key)!.attempts[firstId], 'READY');
  store.remove(firstId);
  scheduler.cancelSubscription(firstId);
  assert.equal(scheduler.inspect(entries[4]!.key)!.attempts[firstId], 'CANCELLED');
  assert.equal(store.register(first, clock.now()), firstId);
  for (let batch = 0; batch < 8 && pending.length; batch++) {
    for (const complete of pending.splice(0)) complete();
    await flush();
  }
  assert.equal(sent.filter(send => send.id === firstId).length, 4);
  assert.equal(sent.filter(send => send.id === secondId).length, 5);
  assert.equal(scheduler.inspect(entries[4]!.key)!.attempts[firstId], 'CANCELLED');
  assert.equal(ledger.snapshot().total, 5);
});

test('404/410 retire only the sent registration, cancel queued sends and preserve unread plus diagnostics', async t => {
  for (const upstreamStatus of [404, 410]) {
    const root = directory(t);
    const store = new SubscriptionStore(root, settings({}));
    const clock = new FakeClock();
    const id = store.register(subscription(), clock.now());
    const ledger = new Ledger();
    const pending: ((result: SendResult) => void)[] = [];
    const errors: Error[] = [];
    const scheduler = new PushScheduler(ledger, store, clock, async () =>
      new Promise(resolve => pending.push(resolve)), 0, error => errors.push(error));
    t.after(() => scheduler.stop());
    const entries = ledger.transition(Array.from({ length: 6 }, (_, index) => key(`expired-${index}`))).added;
    for (const entry of entries) scheduler.schedule(entry);
    await clock.advance(0);
    assert.equal(pending.length, 4);
    pending[0]!({ outcome: 'FAILED', phase: 'response', upstreamStatus });
    await flush();
    assert.equal(store.registered(id, clock.now()), false);
    assert.equal(new SubscriptionStore(root, settings({})).registered(id, clock.now()), false);
    assert.equal(scheduler.delivery(id)!.lastFailure!.invalidation, 'removed');
    for (const entry of entries.slice(4)) assert.equal(scheduler.inspect(entry.key)!.attempts[id], 'CANCELLED');
    assert.equal(pending.length, 4);
    for (const resolve of pending.slice(1)) resolve(sendResult('ACCEPTED'));
    await flush();
    assert.equal(scheduler.delivery(id)!.lastFailure!.result.upstreamStatus, upstreamStatus);
    assert.equal(scheduler.delivery(id)!.latest.result.outcome, 'ACCEPTED');
    assert.equal(ledger.snapshot().total, 6);
    assert.ok(errors[0]!.message.includes(`upstreamStatus=${upstreamStatus}`));
  }
});

test('old in-flight rejection cannot remove identical or changed-key re-registration or cancel its new plans', async t => {
  for (const changedKeys of [false, true]) {
    const store = new SubscriptionStore(directory(t), settings({}));
    const clock = new FakeClock();
    const sub = subscription();
    const id = store.register(sub, clock.now());
    const ledger = new Ledger();
    const pending: ((result: SendResult) => void)[] = [];
    const scheduler = new PushScheduler(ledger, store, clock, async () =>
      new Promise(resolve => pending.push(resolve)), 0, () => {});
    t.after(() => scheduler.stop());
    scheduler.schedule(ledger.transition([key('old')]).added[0]!);
    await clock.advance(0);
    store.register(changedKeys ? { ...sub, keys: { ...sub.keys, auth: Buffer.alloc(16, 8).toString('base64url') } } : sub, clock.now());
    const entries = ledger.transition(Array.from({ length: 4 }, (_, i) => key(`new-${i}`))).added;
    for (const entry of entries) scheduler.schedule(entry);
    await clock.advance(0);
    assert.equal(pending.length, 4);
    pending[0]!({ outcome: 'FAILED', phase: 'response', upstreamStatus: 410 });
    await flush();
    assert.equal(pending.length, 5);
    assert.equal(store.registered(id, clock.now()), true);
    assert.equal(scheduler.delivery(id)!.latest.invalidation, 'superseded');
    for (const resolve of pending.slice(1)) resolve(sendResult('ACCEPTED'));
    await flush();
    assert.equal(scheduler.delivery(id)!.lastFailure!.invalidation, 'superseded');
  }
});

test('failed durable invalidation quarantines only in memory and reports the persistence failure', async t => {
  const root = directory(t);
  const store = new SubscriptionStore(root, settings({}));
  const clock = new FakeClock();
  const id = store.register(subscription(), clock.now());
  const ledger = new Ledger();
  const errors: { code: string; message: string }[] = [];
  let sends = 0;
  const scheduler = new PushScheduler(ledger, store, clock, async () => {
    sends++;
    return { outcome: 'FAILED', phase: 'response', upstreamStatus: 410 };
  }, 0, error => errors.push(error));
  t.after(() => scheduler.stop());
  chmodSync(root, 0o755);
  try {
    scheduler.schedule(ledger.transition([key('failed-write')]).added[0]!);
    await clock.advance(0);
    assert.equal(store.registered(id, clock.now()), false);
    assert.equal(scheduler.delivery(id)!.latest.invalidation, 'persistence-failed');
    assert.deepEqual(errors.map(error => error.code), ['PUSH_HTTP_REJECTED', 'PUSH_INVALIDATION_PERSIST_FAILED']);
    scheduler.schedule(ledger.transition([key('quarantined')]).added[0]!);
    await clock.advance(0);
    assert.equal(sends, 1);
    assert.equal(ledger.snapshot().total, 2);
  } finally { chmodSync(root, 0o700); }
  assert.equal(new SubscriptionStore(root, settings({})).registered(id, clock.now()), true);
});

test('non-expiry failures and unknown outcomes never remove, retry or acknowledge unread', async t => {
  for (const result of [
    ...[401, 403, 429, 500, 503].map(upstreamStatus =>
      ({ outcome: 'FAILED', phase: 'response', upstreamStatus, retryAfterSeconds: 30 } as const)),
    { outcome: 'FAILED', phase: 'preparation' } as const,
    { outcome: 'UNKNOWN', phase: 'transport', networkCategory: 'timeout' } as const,
  ]) {
    const store = new SubscriptionStore(directory(t), settings({}));
    const clock = new FakeClock();
    const id = store.register(subscription(), clock.now());
    const ledger = new Ledger();
    let sends = 0;
    const scheduler = new PushScheduler(ledger, store, clock, async () => { sends++; return result; }, 0, () => {});
    t.after(() => scheduler.stop());
    const entry = ledger.transition([key('once')]).added[0]!;
    scheduler.schedule(entry);
    await clock.advance(0);
    scheduler.schedule(entry);
    await clock.advance(86400_000);
    assert.equal(sends, 1);
    assert.equal(store.registered(id, clock.now()), true);
    assert.deepEqual(scheduler.delivery(id)!.lastFailure!.result, result);
    assert.equal(ledger.snapshot().total, 1);
    ledger.read(ledger.generation, [entry.key]);
    scheduler.cancel(entry.key);
    assert.equal(ledger.snapshot().total, 0);
    assert.deepEqual(scheduler.delivery(id)!.lastFailure!.result, result);
  }
});

test('STOP ignores late expiry responses without persisting or reporting changes', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  const clock = new FakeClock();
  const id = store.register(subscription(), clock.now());
  const ledger = new Ledger();
  let complete!: (result: SendResult) => void;
  const errors: unknown[] = [];
  const scheduler = new PushScheduler(ledger, store, clock,
    async () => new Promise(resolve => { complete = resolve; }), 0, error => errors.push(error));
  scheduler.schedule(ledger.transition([key('stopped')]).added[0]!);
  await clock.advance(0);
  scheduler.stop();
  complete({ outcome: 'FAILED', phase: 'response', upstreamStatus: 410 });
  await flush();
  assert.equal(store.registered(id, clock.now()), true);
  assert.equal(scheduler.delivery(id), undefined);
  assert.deepEqual(errors, []);
});
