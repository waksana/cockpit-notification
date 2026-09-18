import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplyClassifier } from './classifier.ts';
import { key, message, observation, turn } from './native-fixtures.ts';
import type { NativeObservation } from '@cockpit/module-api';

function collect(events: NativeObservation[], classifier = new ReplyClassifier(() => 0)) {
  return events.flatMap(event => classifier.observe(event));
}

test('explicit final and unphased final require live message evidence, main start, end and nonaborted ephemeral idle', () => {
  for (const phase of [undefined, 'final_answer']) {
    const events = turn('reply', { phase });
    const classifier = new ReplyClassifier(() => 0);
    assert.deepEqual(collect(events.slice(0, -1), classifier), []);
    assert.deepEqual(classifier.observe(events.at(-1)!), [key('reply')]);
    assert.deepEqual(collect(events, classifier), []);
    assert.deepEqual(collect(events.slice(1)), []);
    assert.deepEqual(collect([...events.slice(0, -1), observation('assistant.idle')]), []);
  }
});

test('durable history replay followed by fresh idle never produces unread after restart', () => {
  for (const phase of [undefined, 'final_answer']) {
    const history = turn('history', { phase }).filter(event => event.event.ephemeral !== true);
    const replay = [...history, observation('assistant.idle', {}, { ephemeral: true })];
    assert.deepEqual(collect(replay), []);
    assert.deepEqual(collect(replay, new ReplyClassifier(() => 0)), []);
    const classifier = new ReplyClassifier(() => 0);
    assert.deepEqual(collect([...replay, ...turn('fresh', { phase })], classifier), [key('fresh')]);
  }
});

test('only matching root ephemeral start or delta in the current open turn supplies live evidence', () => {
  for (const type of ['assistant.message_start', 'assistant.message_delta']) {
    const live = turn().filter(event =>
      !['assistant.message_start', 'assistant.message_delta'].includes(event.event.type) || event.event.type === type);
    assert.deepEqual(collect(live), [key('reply-a')]);
    for (const changed of [
      live.map(event => event.event.type !== type ? event : { ...event, event: { ...event.event, ephemeral: false } }),
      live.map(event => event.event.type !== type ? event : { ...event, event: { ...event.event, agentId: 'child' } }),
      live.map(event => event.event.type !== type ? event : { ...event, event: {
        ...event.event, data: { ...event.event.data, messageId: 'unrelated-message' },
      } }),
      live.map(event => event.event.type !== type ? event : { ...event, event: {
        ...event.event, data: { ...event.event.data, turnId: 'other-turn' },
      } }),
    ]) assert.deepEqual(collect(changed), []);
  }
  const history = turn().filter(event => event.event.ephemeral !== true);
  assert.deepEqual(collect([message()[0]!, ...history, turn().at(-1)!]), []);
  assert.deepEqual(collect([...history, ...message().slice(0, -1), turn().at(-1)!]), []);
  assert.deepEqual(collect([turn()[0]!, message()[0]!, ...turn().filter(event =>
    !['assistant.message_start', 'assistant.message_delta'].includes(event.event.type))]), []);
});

test('commentary, unknown phase, whitespace and reasoning-only output never become NEW', () => {
  for (const data of [{ phase: 'commentary' }, { phase: 'future_final' }, { phase: null },
    { content: ' \n ', reasoningText: 'synthetic-private-reasoning' }, { content: undefined }]) {
    assert.deepEqual(collect(turn('reply', data)), []);
  }
});

test('unphased split output only promotes last nonempty message, distinct explicit finals retain IDs', () => {
  const split = [observation('assistant.turn_start', { turnId: '0' }),
    ...message('first', { content: 'progress' }),
    ...message('last', { content: 'reply' }),
    ...turn().slice(-2)];
  assert.deepEqual(collect(split), [key('last')]);
  const explicit = split.map(event => event.event.type !== 'assistant.message' ? event :
    { ...event, event: { ...event.event, data: { ...event.event.data, phase: 'final_answer' } } });
  assert.deepEqual(collect(explicit), [key('first'), key('last')]);
});

test('tool-bearing split turns invalidate earlier clean chunks and raw ask tool requests do not count', () => {
  for (const tool of [
    observation('assistant.message', { messageId: 'tool-message', content: 'tool', toolRequests: [{ name: 'view' }] }),
    observation('tool.execution_start', { toolName: 'ask_user', toolCallId: 'call' }),
    observation('tool.execution_complete', { toolCallId: 'call', success: true }),
    observation('user_input.requested', { requestId: 'native-request', question: 'private' }, { ephemeral: true }),
  ]) assert.deepEqual(collect([...turn().slice(0, -2), tool, ...turn().slice(-2)]), []);
  const progress = turn('progress', { toolRequests: [{ name: 'view' }] });
  assert.deepEqual(collect([...progress.slice(0, -1), ...turn('final')]), [key('final')]);
});

test('root ownership recognizes all modern and legacy agent markers', () => {
  for (const fields of [{ agentId: 'agent' }, { parentToolCallId: 'parent' }]) {
    assert.deepEqual(collect(turn().map(event => ({ ...event, event: { ...event.event, ...fields } }))), []);
    assert.deepEqual(collect(turn().map(event => ({ ...event, event: {
      ...event.event, data: { ...event.event.data, ...fields },
    } }))), []);
  }
  const events = turn();
  events.find(event => event.event.type === 'assistant.message')!.event.ephemeral = true;
  assert.deepEqual(collect(events), []);
});

test('abort/error, unmatched end, api-call mismatch and post-end messages fail closed', () => {
  for (const type of ['abort', 'session.error', 'assistant.error']) {
    assert.deepEqual(collect([...turn().slice(0, -2), observation(type), ...turn().slice(-2)]), []);
  }
  assert.deepEqual(collect([...turn().slice(0, -1), observation('assistant.idle', { aborted: true }, { ephemeral: true })]), []);
  assert.deepEqual(collect([...turn().slice(0, -2),
    observation('assistant.turn_end', { turnId: 'wrong' }), turn().at(-1)!]), []);
  assert.deepEqual(collect([...turn().slice(0, -2),
    ...message('other', { content: 'text', apiCallId: 'api-two' }),
    ...message('last', { content: 'text', apiCallId: 'api-three' }),
    ...turn().slice(-2)]), []);
  assert.deepEqual(collect([...turn().slice(0, -1), ...message('late'), turn().at(-1)!]), []);
});

test('SDK opaque apiCallId strings accept 488 characters, long Unicode, whitespace and empty values', () => {
  for (const apiCallId of ['x'.repeat(488), '供應商🙂'.repeat(8_000), ' \t\n\r ', '', '\0']) {
    assert.deepEqual(collect(turn('reply', { phase: 'final_answer', apiCallId })), [key('reply')]);
    assert.deepEqual(collect([
      observation('assistant.turn_start', { turnId: '0' }),
      ...message('commentary', { phase: 'commentary', apiCallId }),
      ...message('reply', { phase: 'final_answer', apiCallId }),
      ...turn().slice(-2),
    ]), [key('reply')]);
    const history = turn('history', { phase: 'final_answer', apiCallId })
      .filter(event => event.event.ephemeral !== true);
    assert.deepEqual(collect([...history, observation('assistant.idle', {}, { ephemeral: true })]), []);
  }
});

test('opaque apiCallId comparison stays exact and nonstrings invalidate the turn', () => {
  for (const apiCallId of [null, 488, true, {}, [], { toString: () => 'api' }]) {
    assert.deepEqual(collect(turn('reply', { phase: 'final_answer', apiCallId })), []);
  }
  for (const [first, last] of [
    ['x'.repeat(488), `${'x'.repeat(487)}y`],
    ['供應商🙂'.repeat(8_000), `${'供應商🙂'.repeat(8_000)}a`],
    [' \n ', ' \t '], ['', 'a'], ['a', ''], ['\ud800', '\ud801'],
  ]) {
    assert.deepEqual(collect([
      observation('assistant.turn_start', { turnId: '0' }),
      ...message('commentary', { phase: 'commentary', apiCallId: first }),
      ...message('reply', { phase: 'final_answer', apiCallId: last }),
      ...turn().slice(-2),
    ]), []);
  }
});

test('new start replaces earlier turn and late idle cannot finalize an open turn', () => {
  assert.deepEqual(collect([...turn('old').slice(0, -1),
    ...turn('new').slice(0, -2), turn().at(-1)!, ...turn().slice(-2)]), []);
  assert.deepEqual(collect([...turn('old').slice(0, -1), ...turn('new')]), [key('new')]);
});

test('stream evidence is bounded by time, number of events and per-turn messages', () => {
  let now = 1_000;
  const classifier = new ReplyClassifier(() => now);
  classifier.observe(turn()[0]!);
  now += 15 * 60_000 + 1;
  assert.throws(() => classifier.observe(turn()[1]!), { code: 'CLASSIFIER_WINDOW_EXPIRED' });
  const bounded = new ReplyClassifier(() => 0, 1);
  bounded.observe(turn()[0]!);
  assert.throws(() => bounded.observe(message().at(-1)!), { code: 'CLASSIFIER_CAPACITY' });
  const many = new ReplyClassifier(() => 0);
  many.observe(turn()[0]!);
  for (let index = 0; index < 128; index++) collect(message(`message-${index}`), many);
  assert.throws(() => collect(message('overflow'), many), { code: 'CLASSIFIER_TURN_CAPACITY' });
  assert.deepEqual(collect(turn().slice(-2), many), []);
  const streams = new ReplyClassifier(() => 0);
  streams.observe(turn()[0]!);
  for (let index = 0; index < 128; index++) streams.observe(message(`stream-${index}`)[0]!);
  assert.throws(() => streams.observe(message('overflow')[0]!), { code: 'CLASSIFIER_TURN_CAPACITY' });
});

test('delta volume does not grow the durable event budget and disposal fences subsequent observations', () => {
  const classifier = new ReplyClassifier(() => 0, 4);
  const events = turn();
  collect(events.slice(0, 2), classifier);
  for (let index = 0; index < 1000; index++) classifier.observe(message()[1]!);
  assert.deepEqual(collect(events.slice(2), classifier), [key('reply-a')]);
  classifier.dispose();
  classifier.dispose();
  assert.deepEqual(collect(turn('after-stop'), classifier), []);
  assert.deepEqual(classifier.reset('session-a'), []);
});
