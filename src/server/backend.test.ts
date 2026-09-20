import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerEvent } from '@cockpit/module-api';
import { activate } from './index.ts';
import { applyUnreadDelta, parseReadResult, parseSnapshot, type NotificationPayload } from '../shared/protocol.ts';
import { ask, fixture, flush, invoke, key, message, subscription, turn, observation } from './test-fixtures.ts';
import type { SendOutcome } from './push.ts';

test('activation rejects a host without generic module events instead of accepting unsynchronized reads', t => {
  const f = fixture(t);
  const legacyContext = { ...f.context };
  Reflect.deleteProperty(legacyContext, 'publish');
  assert.throws(() => activate(legacyContext), {
    code: 'HOST_EVENTS_UNAVAILABLE',
    message: 'Notification deltas require the paired host module-event transport',
  });
});

test('state/read HTTP contracts publish contiguous atomic deltas and return compact idempotent receipts', async t => {
  const f = fixture(t);
  const first = await invoke(f.backend, 'GET', '/state');
  assert.equal(first.headers?.['cache-control'], 'private, no-store');
  const generation = parseSnapshot(first.body).generation;
  const early = await invoke(f.backend, 'POST', '/read', { generation, keys: [key('early')] });
  assert.deepEqual(parseReadResult(early.body), { generation, revision: 1, acknowledged: [key('early')] });
  assert.deepEqual(f.publications, [
    { type: 'unread/delta', generation, fromRevision: 0, revision: 1, added: [], removed: [key('early')] },
  ]);
  assert.equal(f.invalidations.length, 0);
  await f.emit(turn('early'));
  assert.equal((await f.state()).total, 0);
  const events = turn('new');
  await f.emit(events);
  await f.emit(events);
  assert.equal(f.publications.length, 2);
  assert.equal(f.publicationStates[1]!.total, 1);
  const before = await f.state();
  for (const body of [
    { generation, keys: [key('new'), key('bad id')] },
    { generation, keys: [] }, { generation, keys: Array.from({ length: 129 }, () => key('new')) },
    { generation, keys: [key('new')], extra: 'synthetic-secret-input' },
  ]) {
    const response = await invoke(f.backend, 'POST', '/read', body);
    assert.equal(response.status, 400);
    assert.ok(!JSON.stringify(response).includes('synthetic-secret-input'));
    assert.deepEqual(await f.state(), before);
  }
  const mismatch = await invoke(f.backend, 'POST', '/read', { generation: 'previous-generation', keys: [key('new')] });
  assert.equal(mismatch.status, 409);
  assert.equal((mismatch.body as { code: string }).code, 'GENERATION_MISMATCH');
  const results = await Promise.all([0, 1].map(() =>
    invoke(f.backend, 'POST', '/read', { generation, keys: [key('new'), key('new')] })));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(parseReadResult(results[0]!.body), { generation, revision: 3, acknowledged: [key('new')] });
  assert.equal((await f.state()).total, 0);
  assert.equal(f.invalidations.length, 0);
  assert.equal(f.publications.length, 3);
  let replica = parseSnapshot(first.body);
  for (const [index, event] of f.publications.entries()) {
    assert.equal(event.type, 'unread/delta');
    if (event.type !== 'unread/delta') throw new Error('Expected a delta');
    replica = applyUnreadDelta(replica, event);
    assert.deepEqual(replica, f.publicationStates[index]);
  }
  assert.deepEqual(replica, await f.state());
  assert.equal(f.errors.length, 0);
});

test('backend subscribes only to live assistant messages; restart starts empty without querying history', async t => {
  const f = fixture(t);
  assert.deepEqual(f.backend.events!.types, ['assistant.message']);
  await f.emit(turn('before-restart', { phase: 'final_answer' }));
  f.backend.dispose?.();
  const restarted = activate({ ...f.context, signal: new AbortController().signal, publish() {} },
    { clock: f.clock, sender: async () => 'ACCEPTED' });
  t.after(() => restarted.dispose?.());
  assert.equal(parseSnapshot((await invoke(restarted, 'GET', '/state')).body).total, 0);
  await restarted.events!.handle(message('fresh').at(-1)!);
  const state = parseSnapshot((await invoke(restarted, 'GET', '/state')).body);
  assert.equal(state.total, 1);
  assert.equal(state.sessions[0]!.items[0]!.nativeId, 'fresh');
});

test('long replies cross the former 15-minute boundary without losing unread, identity or push preview', async t => {
  for (const elapsed of [15 * 60_000 - 1, 15 * 60_000, 15 * 60_000 + 1, 24 * 60 * 60_000]) {
    for (const split of [1, 2, 3]) {
      const sent: NotificationPayload[] = [];
      const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
      await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
      const events = turn('long', { phase: 'final_answer', content: '**Long reply** completed' });
      await f.emit(events.slice(0, split));
      const before = await f.state();
      assert.equal(before.total, 0);
      assert.equal(f.clock.timers.size, 0, 'classification has no expiration timer');
      await f.clock.advance(elapsed);
      assert.deepEqual(await f.state(), before);
      await f.emit(events.slice(split, 4));
      assert.equal((await f.state()).total, 1);
      assert.equal(sent.length, 0, 'unread does not wait for the push window');
      await f.clock.advance(3000);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.body, 'Long reply completed');
      assert.deepEqual(sent[0]!.key, key('long'));
      assert.equal(sent[0]!.total, 1);
      const completed = await f.state();
      await f.clock.advance(elapsed);
      await f.emit([...events, ...message('late', { phase: undefined }), ...turn().slice(-2)]);
      assert.deepEqual(await f.state(), completed);
      await invoke(f.backend, 'POST', '/read', { generation: completed.generation, keys: [key('long'), key('early')] });
      await f.emit([...events, ...turn('early')]);
      assert.equal((await f.state()).total, 0);
      await f.emit(turn('next'));
      assert.equal((await f.state()).total, 1);
      assert.deepEqual(f.errors, []);
    }
  }
});

test('long ask waits and later abort/error never retract a published final or clear READ identities', async t => {
  for (const ending of ['abort', 'session.error', 'assistant.error', 'assistant.idle']) {
    const sent: NotificationPayload[] = [];
    const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
    await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
    await f.emit(turn('known-unread'));
    const generation = (await f.state()).generation;
    await invoke(f.backend, 'POST', '/read', { generation, keys: [key('already-read')] });
    const published = turn('published-before-stop');
    await f.emit(published.slice(0, -1));
    await f.clock.advance(15 * 60_000 + 1);
    await f.emit([observation(ending, { aborted: true }, { ephemeral: true })]);
    await f.emit([...published, ...message('late', { phase: undefined }), ...turn().slice(-2)]);
    assert.equal((await f.state()).total, 2);
    assert.deepEqual(sent.map(payload => payload.key.nativeId), ['known-unread', 'published-before-stop']);

    await f.emit(turn('before-ask', { phase: 'commentary' }).slice(0, -2));
    await f.emit([observation('user_input.requested', {}, { ephemeral: true })]);
    await f.control(ask('waiting'));
    await f.clock.advance(24 * 60 * 60_000);
    assert.equal((await f.state()).total, 3);
    assert.deepEqual(sent.map(payload => payload.key.nativeId), ['known-unread', 'published-before-stop', 'waiting']);
    await f.control(ask(null));
    await f.emit([observation('tool.execution_complete'), ...turn().slice(-2)]);
    assert.equal((await f.state()).total, 2);
    await f.emit([...turn('already-read'), ...turn('after-ask')]);
    assert.deepEqual((await f.state()).sessions[0]!.items.map(item => item.nativeId),
      ['after-ask', 'known-unread', 'published-before-stop']);
    await f.clock.advance(3000);
    assert.deepEqual(sent.map(payload => payload.key.nativeId), ['known-unread', 'published-before-stop', 'waiting', 'after-ask']);
    assert.deepEqual(f.errors, []);
  }
});

test('finals have no per-turn quota; invalid identity reports honestly and later valid events still work', async t => {
  const f = fixture(t);
  await f.emit(turn('known'));
  await f.emit([turn()[0]!]);
  for (let index = 0; index < 129; index++) await f.emit(message(`overflow-${index}`, { phase: 'final_answer' }));
  assert.equal((await f.state()).total, 130);
  assert.equal(f.errors.length, 0);
  const before = await f.state();
  await f.emit(message('bad id'));
  assert.equal(f.errors.length, 1);
  assert.equal((f.errors[0] as { code: string }).code, 'INVALID_REPLY_IDENTITY');
  await f.emit([...message('late', { phase: undefined }), ...turn().slice(-2)]);
  assert.deepEqual(await f.state(), before);
  await f.emit(turn('recovered'));
  assert.equal((await f.state()).total, 131);
  assert.equal(f.errors.length, 1, 'later success does not falsify or clear the host report history');
});

test('unphased messages are ignored and every explicit final enters unread immediately with its own preview', async t => {
  const sent: NotificationPayload[] = [];
  const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  await f.emit([turn()[0]!]);
  for (let index = 0; index < 1000; index++) await f.emit(message(`ordinary-${index}`,
    { content: `Ordinary ${index}`, phase: undefined }));
  assert.equal((await f.state()).total, 0);
  await f.emit(turn().slice(-2));
  assert.equal((await f.state()).total, 0);
  await f.clock.advance(3000);
  assert.equal(sent.length, 0);

  const generation = (await f.state()).generation;
  await invoke(f.backend, 'POST', '/read', { generation, keys: [key('read-final')] });
  await f.emit([
    turn()[0]!,
    ...message('read-final', { phase: 'final_answer', content: 'Already read' }),
    ...message('first-final', { phase: 'final_answer', content: 'First final' }),
    ...message('second-final', { phase: 'final_answer', content: 'Second final' }),
    ...message('trailing-commentary', { phase: 'commentary' }),
  ]);
  assert.equal((await f.state()).total, 2, 'explicit finals do not wait for turn_end or idle');
  await f.emit(turn().slice(-2));
  assert.equal((await f.state()).total, 2);
  await f.clock.advance(3000);
  assert.deepEqual(sent.map(payload => [payload.key.nativeId, payload.body]), [
    ['first-final', 'First final'], ['second-final', 'Second final'],
  ]);
  await f.emit([turn()[0]!, ...message('cancelled-final', { phase: 'final_answer' }), observation('abort'), ...turn().slice(-2)]);
  assert.equal((await f.state()).total, 3);
  assert.deepEqual(f.errors, []);
});

test('host ask add/null/replacement use requestId and retire instead of fabricating READ', async t => {
  const f = fixture(t);
  await f.control(ask('a'));
  await f.control(ask('a'));
  await f.backend.events!.handle(observation('user_input.requested', { requestId: 'native-other' }));
  assert.equal((await f.state()).total, 1);
  assert.equal((await f.state()).sessions[0]!.items[0]!.nativeId, 'a');
  const before = (await f.state()).revision;
  await f.control(ask('b'));
  assert.equal((await f.state()).revision, before + 1);
  assert.equal((await f.state()).total, 1);
  await f.control(ask(null));
  assert.equal((await f.state()).total, 0);
  await f.control(ask('a'));
  assert.equal((await f.state()).total, 0);
  assert.equal(f.publications.length, 3);
  assert.equal(f.invalidations.length, 0);
  assert.deepEqual(f.publications[1], {
    type: 'unread/delta', generation: (await f.state()).generation, fromRevision: 1, revision: 2,
    added: [{ ...key('b', 'session-a', 'ask'), createdRevision: 2 }], removed: [key('a', 'session-a', 'ask')],
  });
  await f.control({ type: 'session/added', session: {
    sessionId: 'added-session', ask: { requestId: 'added-ask', question: 'synthetic-secret-question' },
  } } as ServerEvent);
  assert.equal((await f.state()).total, 1);
  await f.control({ type: 'session/patch', sessionId: 'added-session', title: 'unchanged-ask' });
  assert.equal((await f.state()).total, 1);
});

test('publication failures are reported after commit while READ receipts remain usable for reconciliation', async t => {
  let sends = 0;
  const f = fixture(t, async () => { sends++; return 'ACCEPTED'; });
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  const publish = f.context.publish;
  let attempts = 0;
  f.context.publish = () => { attempts++; throw new Error('synthetic-secret-publisher-failure'); };
  await f.emit(turn('committed'));
  const before = await f.state();
  assert.equal(before.total, 1);
  assert.equal(before.revision, 1);
  const response = await invoke(f.backend, 'POST', '/read', { generation: before.generation, keys: [key('committed')] });
  const receipt = parseReadResult(response.body);
  assert.deepEqual(receipt, { generation: before.generation, revision: 2, acknowledged: [key('committed')] });
  assert.equal((await f.state()).total, 0);
  assert.equal((await f.state()).revision, receipt.revision);
  assert.deepEqual((await invoke(f.backend, 'POST', '/read', {
    generation: before.generation, keys: [key('committed')],
  })).body, receipt);
  assert.equal(attempts, 2);
  assert.equal(f.errors.length, 2);
  for (const error of f.errors) {
    assert.equal((error as { code: string }).code, 'PUBLICATION_FAILED');
    assert.ok(!String(error).includes('synthetic-secret'));
  }
  await f.clock.advance(3000);
  assert.equal(sends, 0);
  f.context.publish = publish;
  await f.emit(turn('after-gap'));
  assert.deepEqual(f.publications, [{
    type: 'unread/delta', generation: before.generation, fromRevision: 2, revision: 3,
    added: [{ ...key('after-gap'), createdRevision: 3 }], removed: [],
  }]);
  assert.equal(f.invalidations.length, 0);
});

test('finals publish individual contiguous deltas and oversized READ publishes one complete sync checkpoint', async t => {
  const f = fixture(t);
  const keys = Array.from({ length: 128 }, (_, index) => key(`${index}:${'界'.repeat(196)}`));
  await f.emit([
    observation('assistant.turn_start', { turnId: '0' }),
    ...keys.flatMap(item => message(item.nativeId, { phase: 'final_answer', apiCallId: 'x'.repeat(488) })),
    ...turn().slice(-2),
  ]);
  const snapshot = await f.state();
  assert.equal(snapshot.total, 128);
  assert.equal(snapshot.revision, 128);
  assert.equal(f.publications.length, 128);
  for (const [index, publication] of f.publications.entries()) {
    assert.deepEqual(publication, { type: 'unread/delta', generation: snapshot.generation,
      fromRevision: index, revision: index + 1, added: [{ ...keys[index], createdRevision: index + 1 }], removed: [] });
  }
  const read = await invoke(f.backend, 'POST', '/read', { generation: snapshot.generation, keys });
  assert.deepEqual(parseReadResult(read.body), { generation: snapshot.generation, revision: 129, acknowledged: keys });
  assert.deepEqual(f.publications[128], { type: 'unread/sync', generation: snapshot.generation, revision: 129 });
  assert.equal((await f.state()).total, 0);
  assert.equal(f.clock.timers.size, 0);
  await invoke(f.backend, 'POST', '/read', { generation: snapshot.generation, keys });
  assert.equal(f.publications.length, 129);
  assert.equal(f.invalidations.length, 0);
  assert.equal(f.errors.length, 0);
});

test('session deletion/rewind retire known reminders and prevent duplicate resurrection; compaction does not', async t => {
  const f = fixture(t);
  await f.emit(turn('readable'));
  await f.control(ask('ask'));
  await f.control({ type: 'chat/invalidated', sessionId: 'session-a', reason: 'compaction' });
  assert.equal((await f.state()).total, 2);
  await f.emit(message('published-before-rewind'));
  await f.control({ type: 'chat/invalidated', sessionId: 'session-a', reason: 'rewind' });
  await f.emit(message('published-before-rewind'));
  assert.equal((await f.state()).total, 0);
  await f.emit(turn('after-rewind'));
  assert.equal((await f.state()).total, 1);
  await f.control({ type: 'session/removed', sessionId: 'session-a' });
  await f.emit(turn('deleted-late'));
  await f.control(ask('deleted-late-ask'));
  assert.equal((await f.state()).total, 0);
});

test('rapid READ/retire cancels delayed sends and duplicate NEW cannot reschedule', async t => {
  const sent: NotificationPayload[] = [];
  const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  const events = turn('quick');
  await f.emit(events);
  await f.clock.advance(2999);
  assert.equal(sent.length, 0);
  await invoke(f.backend, 'POST', '/read', { generation: (await f.state()).generation, keys: [key('quick')] });
  await f.clock.advance(10);
  await f.emit(events);
  await f.control(ask('cancelled'));
  await f.control(ask(null));
  await f.clock.advance(3000);
  assert.equal(sent.length, 0);
  assert.equal(f.clock.timers.size, 0);
});

test('multiple devices get a reply excerpt and current session title while U and SSE retain only identities', async t => {
  const sent: { id: string; payload: NotificationPayload }[] = [];
  const f = fixture(t, async (device, payload) => { sent.push({ id: device.id, payload }); return 'ACCEPTED'; });
  for (const name of ['one', 'two']) await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription(name) });
  const sessionId = 'session/with-space%value';
  await f.control({ type: 'session/patch', sessionId, title: '更新前的标题' });
  const events = turn('new', { content: '## 通知更新完成\n\n**点击通知**可以直接打开对应会话。',
    reasoningText: 'synthetic-secret-reasoning', apiCallId: 'synthetic-secret-api-call' }, sessionId);
  await f.emit(events);
  await f.emit(events);
  await f.control({ type: 'session/patch', sessionId, title: '前端调优' });
  await f.clock.advance(3000);
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent.map(send => send.id)).size, 2);
  assert.equal((await f.state()).total, 1);
  for (const { payload } of sent) {
    assert.equal(payload.total, 1);
    assert.equal(payload.createdRevision, 1);
    assert.equal(payload.title, '新回复：前端调优');
    assert.equal(payload.body, '通知更新完成 点击通知可以直接打开对应会话。');
    assert.equal(payload.navigationTarget, 'session/session%2Fwith-space%25value');
    assert.ok(!JSON.stringify(payload).includes('synthetic-secret'));
  }
  assert.ok(!JSON.stringify(await f.state()).includes('通知更新完成'));
  assert.ok(!JSON.stringify(f.publications).includes('通知更新完成'));
  assert.ok(!JSON.stringify(f.publications).includes('前端调优'));
  await f.clock.advance(60_000);
  assert.equal(sent.length, 2);
});

test('ask push uses the native question excerpt without replaying historical asks from metadata snapshots', async t => {
  const sent: NotificationPayload[] = [];
  const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  await f.control({ type: 'snapshot', sessions: [{
    sessionId: 'session-a', title: '发布准备', ask: { requestId: 'historical', question: '不要补发的历史提问' },
  }] } as ServerEvent);
  assert.equal((await f.state()).total, 0);
  await f.control({ type: 'session/patch', sessionId: 'session-a',
    ask: { requestId: 'current-question', question: '**选择安装方式**\n继续使用当前配置吗？', choices: ['继续', '取消'] } });
  await f.clock.advance(3000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.title, '待回答：发布准备');
  assert.equal(sent[0]!.body, '选择安装方式 继续使用当前配置吗？');
  assert.equal(sent[0]!.key.kind, 'ask');
  assert.equal(sent[0]!.key.nativeId, 'current-question');
  assert.equal(sent[0]!.navigationTarget, 'session/session-a');
  assert.ok(!JSON.stringify(f.publications).includes('选择安装方式'));
  assert.ok(!JSON.stringify(await f.state()).includes('选择安装方式'));
  await f.control(ask(null));
  assert.equal((await f.state()).total, 0);
  assert.equal(f.errors.length, 0);
});

test('early READ prevents reply excerpts from creating a push, and missing titles use session identity', async t => {
  const sent: NotificationPayload[] = [];
  const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  await invoke(f.backend, 'POST', '/read', { generation: (await f.state()).generation, keys: [key('early')] });
  await f.emit(turn('early', { content: '已经读过，不应推送这段摘要' }));
  await f.emit(turn('new', { content: '可以阅读的新内容' }));
  await f.clock.advance(3000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.title, '新回复：会话 session-');
  assert.equal(sent[0]!.body, '可以阅读的新内容');
  assert.equal(sent[0]!.key.nativeId, 'new');
});

test('no targets at due time means no backfill after device registration', async t => {
  let sends = 0;
  const f = fixture(t, async () => { sends++; return 'ACCEPTED'; });
  await f.emit(turn('no-targets'));
  await f.clock.advance(3000);
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  await f.clock.advance(3000);
  assert.equal(sends, 0);
  assert.equal((await f.state()).total, 1);
  await f.emit(turn('new-after-registration'));
  await f.clock.advance(3000);
  assert.equal(sends, 1);
});

test('DELETE then re-registering the same endpoint cannot revive queued delivery attempts', async t => {
  const sent: NotificationPayload[] = [];
  const pending: (() => void)[] = [];
  const f = fixture(t, async (_device, payload) => {
    sent.push(payload);
    return new Promise(resolve => { pending.push(() => resolve('ACCEPTED')); });
  });
  const device = subscription();
  const registration = await invoke(f.backend, 'POST', '/subscriptions', { subscription: device });
  const { id } = registration.body as { id: string };
  for (let index = 0; index < 6; index++) await f.emit(turn(`queued-${index}`));
  await f.clock.advance(3000);
  assert.equal(sent.length, 4);
  assert.equal((await invoke(f.backend, 'DELETE', '/subscriptions/:id', undefined, { id })).status, 204);
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: device });
  for (const complete of pending.splice(0)) complete();
  await flush();
  assert.equal(sent.length, 4);
  await f.emit(turn('after-reenable'));
  await f.clock.advance(3000);
  assert.equal(sent.length, 5);
  assert.equal(sent[4]!.key.nativeId, 'after-reenable');
  assert.equal((await f.state()).total, 7);
  for (const complete of pending.splice(0)) complete();
  await flush();
});

test('READ during first send stops unsent devices; started completion cannot resurrect entry', async t => {
  let complete!: (value: SendOutcome) => void;
  let sends = 0;
  const f = fixture(t, async () => { sends++; return new Promise(resolve => { complete = resolve; }); });
  for (const name of ['one', 'two']) await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription(name) });
  await f.emit(turn('during-send'));
  await f.clock.advance(3000);
  assert.equal(sends, 1);
  await invoke(f.backend, 'POST', '/read', { generation: (await f.state()).generation, keys: [key('during-send')] });
  complete('ACCEPTED');
  await flush();
  assert.equal(sends, 1);
  assert.equal((await f.state()).total, 0);
});

test('failed and unknown push outcomes preserve unread and never retry or expose provider errors', async t => {
  for (const outcome of ['FAILED', 'UNKNOWN', 'throw'] as const) {
    let sends = 0;
    const f = fixture(t, async () => {
      sends++;
      if (outcome === 'throw') throw new Error('synthetic-secret-provider-response');
      return outcome;
    });
    await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription(outcome) });
    await f.emit(turn(outcome));
    await f.clock.advance(3000);
    await f.clock.advance(60_000);
    assert.equal(sends, 1);
    assert.equal((await f.state()).total, 1);
    assert.equal(f.errors.length, 1);
    assert.ok(!String(f.errors[0]).includes('synthetic-secret'));
  }
});

test('subscription routes return only opaque identity and snapshot; lifecycle restart forgets U', async t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.backend.publicConfig!).sort(), ['maxBatch', 'pushDelayMs', 'readDelayMs', 'vapidPublicKey']);
  const registered = await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  const body = registered.body as { id: string; generation: string; state: unknown };
  assert.match(body.id, /^[a-f0-9]{64}$/);
  assert.equal(parseSnapshot(body.state).generation, body.generation);
  assert.deepEqual((await invoke(f.backend, 'GET', '/subscriptions/:id', undefined, { id: body.id })).body,
    { registered: true });
  await f.emit(turn('restart-unread'));
  await invoke(f.backend, 'POST', '/read', { generation: body.generation, keys: [key('early-tombstone')] });
  const persisted = readFileSync(join(f.dataRoot, 'push-config.json'), 'utf8');
  assert.ok(!persisted.includes('restart-unread'));
  assert.ok(!persisted.includes('early-tombstone'));
  assert.ok(!persisted.includes('synthetic-secret-body'));
  f.backend.dispose?.();
  const restarted = activate({ ...f.context, signal: new AbortController().signal, publish() {} },
    { clock: f.clock, sender: async () => 'ACCEPTED' });
  t.after(() => restarted.dispose?.());
  const state = parseSnapshot((await invoke(restarted, 'GET', '/state')).body);
  assert.notEqual(state.generation, body.generation);
  assert.equal(state.revision, 0);
  assert.equal(state.total, 0);
  assert.equal(restarted.publicConfig!.vapidPublicKey, f.backend.publicConfig!.vapidPublicKey);
  assert.deepEqual((await invoke(restarted, 'GET', '/subscriptions/:id', undefined, { id: body.id })).body, { registered: true });
  assert.equal((await invoke(restarted, 'DELETE', '/subscriptions/:id', undefined, { id: body.id })).status, 204);
  assert.deepEqual((await invoke(restarted, 'GET', '/subscriptions/:id', undefined, { id: body.id })).body, { registered: false });
});

test('Edge WNS endpoints pass the actual subscription route without disclosing channel URLs or keys', async t => {
  const sent: NotificationPayload[] = [];
  const f = fixture(t, async (_device, payload) => { sent.push(payload); return 'ACCEPTED'; });
  const subscriptionValue = { ...subscription(), endpoint: 'https://wns2-fixture.notify.windows.com/w/?token=synthetic-channel' };
  const response = await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscriptionValue });
  assert.equal(response.status ?? 200, 200);
  const { id } = response.body as { id: string };
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.deepEqual((await invoke(f.backend, 'GET', '/subscriptions/:id', undefined, { id })).body, { registered: true });
  await f.emit(turn('edge-reply', { content: 'Synthetic notification for a WNS subscription.' }));
  await f.clock.advance(3000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.key.nativeId, 'edge-reply');
  for (const value of [response.body, sent, f.publications, f.errors]) {
    assert.ok(!JSON.stringify(value).includes('synthetic-channel'));
    assert.ok(!JSON.stringify(value).includes(subscriptionValue.keys.auth));
  }
});

test('abort clears pending work, aborts started send, and fences late callbacks and route requests', async t => {
  let signal: AbortSignal | undefined;
  let complete!: (value: SendOutcome) => void;
  let sends = 0;
  const f = fixture(t, async (_device, _payload, value) => {
    signal = value;
    sends++;
    return new Promise(resolve => { complete = resolve; });
  });
  await invoke(f.backend, 'POST', '/subscriptions', { subscription: subscription() });
  await f.emit(turn('in-flight'));
  await f.clock.advance(3000);
  await f.emit(turn('waiting'));
  f.controller.abort();
  assert.equal(signal!.aborted, true);
  assert.equal(f.clock.timers.size, 0);
  complete('UNKNOWN');
  await flush();
  await f.emit(turn('late'));
  await f.control(ask('late'));
  await f.clock.advance(3000);
  assert.equal(sends, 1);
  assert.equal(f.errors.length, 0);
  const response = await invoke(f.backend, 'GET', '/state');
  assert.equal(response.status, 503);
  assert.equal((response.body as { code: string }).code, 'STOPPED');
});
