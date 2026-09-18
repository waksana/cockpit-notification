import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageKey, Snapshot, UnreadDelta } from '../shared/protocol.ts';
import { keyId } from '../shared/protocol.ts';
import { UnreadStore } from './store.ts';
import type { StoreOptions } from './store.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const key = (nativeId: string): MessageKey => ({ sessionId: 'session-a', kind: 'reply', nativeId });
function snapshot(revision = 0, names: string[] = [], generation = 'generation-a'): Snapshot {
  return { generation, revision, complete: true, total: names.length,
    sessions: names.length ? [{ sessionId: 'session-a', count: names.length,
      items: names.map(nativeId => ({ nativeId, kind: 'reply', createdRevision: 1 })) }] : [] };
}
const receipt = (names: string[], revision: number, generation = 'generation-a') => ({
  acknowledged: names.map(key), generation, revision,
});
function delta(fromRevision: number, added: string[] = [], removed: string[] = [], generation = 'generation-a'): UnreadDelta {
  return { type: 'unread/delta', generation, fromRevision, revision: fromRevision + 1,
    added: added.map(name => ({ ...key(name), createdRevision: fromRevision + 1 })), removed: removed.map(key) };
}
function fixture(t: { after(fn: () => void): void },
  options: Pick<StoreOptions, 'barrierMs' | 'maxBufferedEvents'> = {}) {
  const calls: { path: string; init?: RequestInit; resolve(response: Response): void; reject(error: Error): void }[] = [];
  const applied: { state: Snapshot; acknowledged: MessageKey[] }[] = [];
  const errors: unknown[] = [];
  const store = new UnreadStore({ batchMs: 60_000, barrierMs: 60_000, ...options,
    request: (path, init) => new Promise<Response>((resolve, reject) => calls.push({ path, init, resolve, reject })),
    report: error => { errors.push(error); },
    apply: (state, acknowledged) => applied.push({ state, acknowledged }),
  });
  t.after(() => store.dispose());
  const respond = async (index: number, body: unknown, status = 200) => {
    calls[index]!.resolve(Response.json(body, { status }));
    await settle();
  };
  const foreground = (sessionId = 'session-a') => store.setActivity({ sessionId, visible: true, connected: true });
  return { store, calls, errors, applied, respond, foreground };
}

test('initial, reconnect and foreground sync are no-store; errors are never fake zero', async t => {
  const f = fixture(t);
  assert.equal(f.store.getSnapshot().snapshot, null);
  f.foreground();
  assert.equal(f.calls[0]!.init?.cache, 'no-store');
  await f.respond(0, snapshot(1, ['a', 'b', 'c']));
  assert.equal(f.store.getSnapshot().snapshot?.total, 3);
  f.store.setActivity({ sessionId: 'session-a', visible: true, connected: false });
  assert.equal(f.store.getSnapshot().status, 'disconnected');
  f.store.refresh();
  assert.equal(f.calls.length, 1);
  f.foreground();
  f.calls[1]!.reject(new Error('synthetic network failure'));
  await settle();
  assert.equal(f.store.getSnapshot().status, 'stale');
  assert.equal(f.store.getSnapshot().snapshot?.total, 3);
  assert.match(f.store.getSnapshot().error!, /network failure/);
  assert.equal(f.store.canPresent(), false);
});

test('dirty refresh triggers coalesce and a hidden obsolete GET cannot publish', async t => {
  const f = fixture(t);
  f.foreground();
  for (let i = 0; i < 10; i++) f.store.refresh();
  assert.equal(f.calls.length, 1);
  await f.respond(0, snapshot());
  assert.equal(f.calls.length, 2);
  f.store.setActivity({ sessionId: 'session-a', visible: false, connected: true });
  assert.equal(f.calls[1]!.init?.signal?.aborted, true);
  f.foreground('session-b');
  assert.equal(f.calls.length, 3);
  await f.respond(2, snapshot(2, ['new']));
  await f.respond(1, snapshot(1, ['old']));
  assert.equal(f.store.getSnapshot().snapshot?.revision, 2);
  assert.equal(f.store.getSnapshot().status, 'ready');
});

test('same-generation revisions reject regression and equivalent array orders are accepted', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(5, ['a', 'b']));
  f.store.refresh();
  await f.respond(1, snapshot(4, ['old']));
  assert.equal(f.store.getSnapshot().snapshot?.revision, 5);
  f.store.refresh();
  await f.respond(2, snapshot(5, ['b', 'a']));
  assert.equal(f.store.getSnapshot().status, 'ready');
  f.store.refresh();
  await f.respond(3, snapshot(5, ['wrong']));
  assert.equal(f.store.getSnapshot().status, 'stale');
  assert.equal(f.store.getSnapshot().snapshot?.total, 2);
});

test('early reads survive empty snapshots, deduplicate, and their receipts do not start another GET', async t => {
  const f = fixture(t);
  f.foreground();
  f.store.present(key('before-binding'), 'generation-a');
  assert.equal(f.store.getSnapshot().pending, 0);
  await f.respond(0, snapshot());
  f.store.present(key('early'), 'generation-a');
  f.store.present(key('early'), 'generation-a');
  assert.equal(f.store.getSnapshot().pending, 1);
  const reading = f.store.flush();
  assert.equal(f.calls[1]!.path, '/read');
  assert.equal(f.calls[1]!.init?.cache, 'no-store');
  f.store.refresh();
  await f.respond(2, snapshot());
  assert.equal(f.store.getSnapshot().pending, 1);
  await f.respond(1, receipt(['early'], 1));
  await reading;
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.calls.length, 3);
  f.store.present(key('early'), 'generation-a');
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.store.getSnapshot().snapshot?.revision, 0, 'receipt cannot advance authority');
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});

test('lost READ response retains identities absent from later snapshots and retries the same generation', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.present(key('early'), 'generation-a');
  const first = f.store.flush();
  f.calls[1]!.reject(new Error('response lost'));
  await first;
  assert.equal(f.store.getSnapshot().pending, 1);
  f.store.refresh();
  await f.respond(2, snapshot(1));
  const second = f.store.flush();
  assert.deepEqual(JSON.parse(String(f.calls[3]!.init?.body)), JSON.parse(String(f.calls[1]!.init?.body)));
  await f.respond(3, receipt(['early'], 1));
  await second;
  assert.equal(f.store.getSnapshot().pending, 0);
});

test('READ batch is bounded to 128 and acknowledgements must exactly match the sent keys', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  for (let i = 0; i < 129; i++) f.store.present(key(`new-${i}`), 'generation-a');
  const first = f.store.flush();
  const sent = JSON.parse(String(f.calls[1]!.init?.body)).keys as MessageKey[];
  assert.equal(sent.length, 128);
  await f.respond(1, { acknowledged: sent, generation: 'generation-a', revision: 1 });
  await first;
  assert.equal(f.store.getSnapshot().pending, 1);
  const second = f.store.flush();
  assert.deepEqual(JSON.parse(String(f.calls[2]!.init?.body)).keys.map(keyId), [keyId(key('new-128'))]);
  await f.respond(2, receipt(['unrelated'], 2));
  await second;
  assert.equal(f.store.getSnapshot().pending, 1);
  assert.match(f.store.getSnapshot().error!, /身份/);
});

test('successful READ while hidden clears only request pending, never unread state', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  f.store.setActivity({ sessionId: 'session-a', visible: false, connected: true });
  f.store.present(key('b'), 'generation-a');
  await f.respond(1, receipt(['a'], 2));
  await reading;
  assert.equal(f.store.getSnapshot().status, 'suspended');
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.applied.length, 1);
  assert.equal(f.calls.length, 2);
});

test('old READ receipt acknowledges keys but cannot overwrite or reapply a newer full snapshot', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.present(key('early'), 'generation-a');
  const reading = f.store.flush();
  f.store.refresh();
  await f.respond(2, snapshot(3, ['other']));
  await f.respond(1, receipt(['early'], 1));
  await reading;
  assert.equal(f.store.getSnapshot().snapshot?.revision, 3);
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.applied.length, 2);
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});

test('generation mismatch fences the old GET and never copies old read identities into the new generation', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.present(key('old'), 'generation-a');
  const reading = f.store.flush();
  f.store.refresh();
  await f.respond(1, { code: 'GENERATION_MISMATCH', message: 'reset' }, 409);
  await reading;
  assert.equal(f.calls[2]!.init?.signal?.aborted, true);
  await f.respond(3, snapshot(0, [], 'generation-b'));
  await f.respond(2, snapshot(8, ['late'], 'generation-a'));
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-b');
  assert.equal(f.store.getSnapshot().pending, 0);
  f.store.present(key('old'), 'generation-a');
  await f.store.flush();
  assert.equal(f.calls.length, 4);
});

test('old read callbacks and callbacks after dispose cannot revive a binding', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.present(key('old'), 'generation-a');
  const reading = f.store.flush();
  f.store.refresh();
  await f.respond(2, snapshot(0, [], 'generation-b'));
  assert.equal(f.calls[1]!.init?.signal?.aborted, true);
  await f.respond(1, receipt(['old'], 1));
  await reading;
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-b');
  f.store.refresh();
  f.store.dispose();
  await f.respond(3, snapshot(1, ['late'], 'generation-b'));
  assert.equal(f.store.getSnapshot().status, 'stopped');
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
});

test('contiguous add, remove and early ACK transitions update authority with no GET or receipt proof', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.onEvent(delta(0, ['a']));
  f.store.onEvent(delta(1, ['b']));
  assert.equal(f.store.getSnapshot().snapshot?.total, 2);
  assert.deepEqual(f.store.getSnapshot().snapshot?.sessions[0]?.items.map(item => item.createdRevision), [1, 2]);
  f.store.onEvent(delta(2, [], ['a']));
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
  f.store.present(key('early'), 'generation-a');
  const reading = f.store.flush();
  f.store.onEvent(delta(3));
  assert.equal(f.store.getSnapshot().pending, 1, 'an early READ transition is not an HTTP receipt');
  await f.respond(1, receipt(['early'], 4));
  await reading;
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.store.getSnapshot().snapshot?.revision, 4);
  f.store.onEvent(delta(4, [], ['b']));
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
  assert.equal(f.calls.length, 2, 'removal does not cause a POST or GET');
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});

test('duplicate events and covered sync hints do not reapply or fetch', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.onEvent(delta(0, ['a']));
  for (let i = 0; i < 10; i++) {
    f.store.onEvent(delta(0, ['a']));
    f.store.onEvent({ type: 'unread/sync', generation: 'generation-a', revision: 1 });
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.applied.length, 2);
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
});

test('initial GET buffers out-of-order deltas, discards covered events and applies one complete result', async t => {
  const f = fixture(t);
  f.foreground();
  f.store.onEvent(delta(2, [], ['a']));
  f.store.onEvent(delta(0, ['a']));
  f.store.onEvent({ type: 'unread/sync', generation: 'generation-a', revision: 3 });
  f.store.onEvent(delta(1, ['b']));
  assert.equal(f.store.getSnapshot().snapshot, null);
  await f.respond(0, snapshot(1, ['a']));
  assert.equal(f.calls.length, 1);
  assert.equal(f.applied.length, 1);
  assert.equal(f.store.getSnapshot().snapshot?.revision, 3);
  assert.deepEqual(f.store.getSnapshot().snapshot?.sessions[0]?.items,
    [{ kind: 'reply', nativeId: 'b', createdRevision: 2 }]);
  assert.equal(f.store.getSnapshot().status, 'ready');
});

test('a gap triggers a bounded fresh GET and remains stale if the target is still missing', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.onEvent(delta(3, ['d']));
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
  await f.respond(1, snapshot(1, ['a']));
  assert.equal(f.calls.length, 3);
  await f.respond(2, snapshot(1, ['a']));
  assert.equal(f.store.getSnapshot().status, 'stale');
  assert.equal(f.store.canPresent(), false);
  for (let i = 0; i < 10; i++) f.store.onEvent(delta(3, ['d']));
  assert.equal(f.calls.length, 3, 'an unresolved gap must not create a hot retry loop');
  f.store.refresh();
  await f.respond(3, snapshot(4, ['d']));
  assert.equal(f.store.getSnapshot().status, 'ready');
});

test('oversized sync hint fetches once when new and never binds a generation from the hint', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.onEvent({ type: 'unread/sync', generation: 'generation-b', revision: 1 });
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-a');
  await f.respond(1, snapshot(1, ['b'], 'generation-b'));
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-b');
  f.store.onEvent(delta(1, ['old'], [], 'generation-a'));
  f.store.onEvent({ type: 'unread/sync', generation: 'generation-a', revision: 999 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
});

test('new generation during GET forces fresh recovery and retires the old read binding', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  f.store.refresh();
  f.store.onEvent(delta(0, ['b'], [], 'generation-b'));
  await f.respond(2, snapshot(1, ['a']));
  assert.equal(f.calls.length, 4);
  await f.respond(3, snapshot(1, ['b'], 'generation-b'));
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-b');
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.calls[1]!.init?.signal?.aborted, true);
  await f.respond(1, receipt(['a'], 2));
  await reading;
  assert.equal(f.applied.at(-1)?.state.generation, 'generation-b');
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});

test('GET event buffer overflow requires a fresh checkpoint rather than dropping events as success', async t => {
  const f = fixture(t, { maxBufferedEvents: 2 });
  f.foreground();
  for (let revision = 0; revision < 3; revision++) f.store.onEvent(delta(revision));
  await f.respond(0, snapshot());
  assert.equal(f.calls.length, 2);
  await f.respond(1, snapshot(3));
  assert.equal(f.store.getSnapshot().status, 'ready');
  assert.equal(f.store.getSnapshot().snapshot?.revision, 3);
});

test('session A/B and continuous hidden SSE preserve one global state without GET on visibility alone', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.foreground('session-b');
  f.foreground('session-a');
  f.store.setActivity({ sessionId: 'session-b', visible: false, connected: true });
  f.store.onEvent(delta(1, ['b'], ['a']));
  assert.equal(f.store.getSnapshot().snapshot?.revision, 2);
  assert.equal(f.store.getSnapshot().status, 'suspended');
  assert.equal(f.store.canPresent(), false);
  f.foreground('session-b');
  assert.equal(f.store.getSnapshot().status, 'ready');
  assert.equal(f.calls.length, 1);
});

test('hidden disconnected gaps do not poll; visibility plus connection performs one recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.setActivity({ sessionId: 'session-a', visible: false, connected: false });
  f.store.onEvent(delta(2, ['c']));
  t.mock.timers.tick(120_000);
  assert.equal(f.calls.length, 1);
  f.store.setActivity({ sessionId: 'session-a', visible: true, connected: false });
  assert.equal(f.calls.length, 1);
  f.foreground();
  await f.respond(1, snapshot(3, ['c']));
  assert.equal(f.store.getSnapshot().status, 'ready');
  assert.equal(f.calls.length, 2);
});

test('HTTP receipt before removal leaves UI and worker authority untouched, including a pre-barrier GET', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  const authority = f.store.getSnapshot().snapshot;
  await f.respond(1, receipt(['a'], 3));
  await reading;
  assert.equal(f.store.getSnapshot().snapshot, authority);
  assert.equal(f.applied.length, 1);
  f.store.refresh();
  await f.respond(2, snapshot(2, ['a']));
  assert.equal(f.store.getSnapshot().status, 'ready', 'receipt ACK is not a proof of absence before its target revision');
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
  f.store.onEvent(delta(2, [], ['a']));
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});

test('READ failure after authoritative removal keeps pending honest and retries only after recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  f.store.onEvent(delta(1, [], ['a']));
  f.calls[1]!.reject(new Error('lost committed READ response'));
  await reading;
  f.store.onEvent(delta(2));
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
  assert.equal(f.store.getSnapshot().pending, 1);
  assert.equal(f.store.getSnapshot().status, 'stale');
  t.mock.timers.tick(120_000);
  assert.equal(f.calls.length, 2);
  f.store.refresh();
  await f.respond(2, snapshot(3));
  const retry = f.store.flush();
  assert.equal(f.calls[3]?.init?.body, f.calls[1]?.init?.body);
  await f.respond(3, receipt(['a'], 3));
  await retry;
  assert.equal(f.store.getSnapshot().pending, 0);
});

test('receipt barriers merge target revisions, wait once, and recover without perpetual retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, { barrierMs: 3000 });
  f.foreground();
  await f.respond(0, snapshot(1, ['a', 'b']));
  for (const [name, revision] of [['a', 2], ['b', 3]] as const) {
    f.store.present(key(name), 'generation-a');
    const reading = f.store.flush();
    await f.respond(f.calls.length - 1, receipt([name], revision));
    await reading;
  }
  t.mock.timers.tick(2999);
  assert.equal(f.calls.length, 3);
  t.mock.timers.tick(1);
  assert.equal(f.calls.length, 4);
  await f.respond(3, snapshot(2, ['b']));
  assert.equal(f.store.getSnapshot().status, 'stale', 'GET must cover the highest receipt barrier');
  t.mock.timers.tick(120_000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
});

test('SSE before or after receipts cancels their fallback and never forwards HTTP acknowledgements', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, { barrierMs: 3000 });
  f.foreground();
  await f.respond(0, snapshot(1, ['a', 'b']));
  f.store.present(key('a'), 'generation-a');
  const first = f.store.flush();
  await f.respond(1, receipt(['a'], 2));
  await first;
  f.store.onEvent(delta(1, [], ['a']));
  f.store.present(key('b'), 'generation-a');
  const second = f.store.flush();
  f.store.onEvent(delta(2, [], ['b']));
  await f.respond(2, receipt(['b'], 3));
  await second;
  t.mock.timers.tick(120_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});

test('barrier fallback is paused while hidden or disconnected and disposal cancels it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, { barrierMs: 3000 });
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  await f.respond(1, receipt(['a'], 2));
  await reading;
  f.store.setActivity({ sessionId: 'session-a', visible: false, connected: true });
  t.mock.timers.tick(10_000);
  assert.equal(f.calls.length, 2);
  f.store.setActivity({ sessionId: 'session-a', visible: true, connected: false });
  t.mock.timers.tick(10_000);
  assert.equal(f.calls.length, 2);
  f.foreground();
  t.mock.timers.tick(1);
  assert.equal(f.calls.length, 3);
  await f.respond(2, snapshot(2));
  f.store.hint({ type: 'unread/sync', generation: 'generation-a', revision: 3 });
  f.store.dispose();
  t.mock.timers.tick(10_000);
  assert.equal(f.calls.length, 3);
});

test('worker version hints are deduplicated barriers, not unconditional push GETs or polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, { barrierMs: 3000 });
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  for (let i = 0; i < 10; i++) f.store.hint({ type: 'unread/sync', generation: 'generation-a', revision: 1 });
  t.mock.timers.tick(10_000);
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 10; i++) f.store.hint({ type: 'unread/sync', generation: 'generation-a', revision: 2 });
  f.store.onEvent(delta(1, ['b']));
  t.mock.timers.tick(10_000);
  assert.equal(f.calls.length, 1);
  f.store.hint({ type: 'unread/sync', generation: 'generation-a', revision: 3 });
  t.mock.timers.tick(3000);
  await f.respond(1, snapshot(3, ['a', 'b', 'c']));
  t.mock.timers.tick(120_000);
  assert.equal(f.calls.length, 2);
});

test('a later fresh checkpoint can supersede an unfamiliar old-generation push hint without a resync loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, { barrierMs: 3000 });
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.hint({ type: 'unread/sync', generation: 'unknown-old-generation', revision: 99 });
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-a');
  t.mock.timers.tick(3000);
  await f.respond(1, snapshot(1, ['a']));
  assert.equal(f.store.getSnapshot().status, 'ready');
  f.store.hint({ type: 'unread/sync', generation: 'unknown-old-generation', revision: 100 });
  f.store.onEvent(delta(99, [], [], 'unknown-old-generation'));
  t.mock.timers.tick(120_000);
  assert.equal(f.calls.length, 2);
});

test('unknown generation observed during a GET cannot be retired by that older response', async t => {
  const f = fixture(t);
  f.foreground();
  f.store.onEvent(delta(0, ['b'], [], 'generation-b'));
  await f.respond(0, snapshot(1, ['a']));
  assert.equal(f.calls.length, 2);
  f.store.onEvent(delta(1, ['c'], [], 'generation-b'));
  await f.respond(1, snapshot(1, ['a']));
  assert.equal(f.store.getSnapshot().status, 'stale');
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-a');
  f.store.refresh();
  await f.respond(2, snapshot(2, ['b', 'c'], 'generation-b'));
  assert.equal(f.store.getSnapshot().status, 'ready');
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-b');
});

test('malformed GET, event and receipt errors preserve last authority visibly', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.onEvent({ ...delta(1), revision: '2' });
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
  await f.respond(1, { ...snapshot(2), total: 99 });
  assert.equal(f.store.getSnapshot().status, 'stale');
  assert.equal(f.errors.length, 2);
  f.store.refresh();
  await f.respond(2, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  await f.respond(3, { ...receipt(['a'], 2), state: snapshot(2) });
  await reading;
  assert.equal(f.store.getSnapshot().snapshot?.total, 1);
  assert.equal(f.store.getSnapshot().pending, 1);
  assert.match(f.store.getSnapshot().error!, /Invalid read receipt/);
});

test('READ receipts must acknowledge exactly the sent identities and generation', async t => {
  for (const result of [
    receipt(['a', 'a'], 2),
    receipt(['a', 'unrelated'], 2),
    receipt(['a'], 2, 'generation-b'),
    { acknowledged: [], generation: 'generation-a', revision: 2 },
  ]) {
    const f = fixture(t);
    f.foreground();
    await f.respond(0, snapshot(1, ['a']));
    f.store.present(key('a'), 'generation-a');
    const reading = f.store.flush();
    await f.respond(1, result);
    await reading;
    assert.equal(f.store.getSnapshot().pending, 1);
    assert.equal(f.store.getSnapshot().snapshot?.total, 1);
    assert.equal(f.store.getSnapshot().status, 'stale');
    assert.equal(f.applied.length, 1);
    f.store.dispose();
  }
});

test('an invalid delta cannot partially mutate the complete authority or worker cleanup', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a', 'b']));
  const before = f.store.getSnapshot().snapshot;
  f.store.onEvent(delta(1, ['a'], ['b']));
  assert.equal(f.store.getSnapshot().snapshot, before);
  assert.equal(f.applied.length, 1);
  assert.match(f.store.getSnapshot().error!, /re-adds/);
  await f.respond(1, snapshot(2, ['a']));
  assert.equal(f.store.getSnapshot().status, 'ready');
  assert.equal(f.applied.at(-1)?.state.total, 1);
  assert.equal(f.applied.every(application => application.acknowledged.length === 0), true);
});
