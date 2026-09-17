import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageKey, Snapshot } from '../shared/protocol.ts';
import { keyId } from '../shared/protocol.ts';
import { UnreadStore } from './store.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const key = (nativeId: string): MessageKey => ({ sessionId: 'session-a', kind: 'reply', nativeId });
function snapshot(revision = 0, names: string[] = [], generation = 'generation-a'): Snapshot {
  return { generation, revision, complete: true, total: names.length,
    sessions: names.length ? [{ sessionId: 'session-a', count: names.length,
      items: names.map(nativeId => ({ nativeId, kind: 'reply', createdRevision: 1 })) }] : [] };
}
function fixture(t: { after(fn: () => void): void }) {
  const calls: { path: string; init?: RequestInit; resolve(response: Response): void; reject(error: Error): void }[] = [];
  const applied: { state: Snapshot; acknowledged: MessageKey[] }[] = [];
  const errors: unknown[] = [];
  const store = new UnreadStore({ batchMs: 60_000,
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
  await f.respond(1, { acknowledged: [key('early')], state: snapshot(1) });
  await reading;
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.equal(f.calls.length, 3);
  f.store.present(key('early'), 'generation-a');
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.deepEqual(f.applied.at(-1)?.acknowledged, [key('early')]);
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
  await f.respond(3, { acknowledged: [key('early')], state: snapshot(1) });
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
  await f.respond(1, { acknowledged: sent, state: snapshot(1) });
  await first;
  assert.equal(f.store.getSnapshot().pending, 1);
  const second = f.store.flush();
  assert.deepEqual(JSON.parse(String(f.calls[2]!.init?.body)).keys.map(keyId), [keyId(key('new-128'))]);
  await f.respond(2, { acknowledged: [key('unrelated')], state: snapshot(2) });
  await second;
  assert.equal(f.store.getSnapshot().pending, 1);
  assert.match(f.store.getSnapshot().error!, /身份/);
});

test('successful READ while hidden applies same-generation receipt without activating the page', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot(1, ['a']));
  f.store.present(key('a'), 'generation-a');
  const reading = f.store.flush();
  f.store.setActivity({ sessionId: 'session-a', visible: false, connected: true });
  f.store.present(key('b'), 'generation-a');
  await f.respond(1, { acknowledged: [key('a')], state: snapshot(2) });
  await reading;
  assert.equal(f.store.getSnapshot().status, 'suspended');
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
  assert.equal(f.calls.length, 2);
});

test('old READ snapshot still acknowledges keys but cannot overwrite a newer full snapshot', async t => {
  const f = fixture(t);
  f.foreground();
  await f.respond(0, snapshot());
  f.store.present(key('early'), 'generation-a');
  const reading = f.store.flush();
  f.store.refresh();
  await f.respond(2, snapshot(3, ['other']));
  await f.respond(1, { acknowledged: [key('early')], state: snapshot(1) });
  await reading;
  assert.equal(f.store.getSnapshot().snapshot?.revision, 3);
  assert.equal(f.store.getSnapshot().pending, 0);
  assert.deepEqual(f.applied.at(-1)?.acknowledged, [key('early')]);
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
  await f.respond(1, { acknowledged: [key('old')], state: snapshot(1) });
  await reading;
  assert.equal(f.store.getSnapshot().snapshot?.generation, 'generation-b');
  f.store.refresh();
  f.store.dispose();
  await f.respond(3, snapshot(1, ['late'], 'generation-b'));
  assert.equal(f.store.getSnapshot().status, 'stopped');
  assert.equal(f.store.getSnapshot().snapshot?.total, 0);
});
