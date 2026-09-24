import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalReply } from './final-reply.ts';
import { key, observation } from './native-fixtures.ts';

const reply = (data: Record<string, unknown> = {}) =>
  observation('assistant.message', { messageId: 'reply', content: '## Ready\n**Final reply**', ...data });

test('one tool-free primary message is sufficient without start, stream, end or idle evidence', () => {
  assert.deepEqual(finalReply(reply()), { key: key('reply'), summary: 'Ready Final reply' });
  assert.deepEqual(finalReply(reply({ messageId: 'second' }))?.key, key('second'));
  for (const apiCallId of ['x'.repeat(488), '供應商🙂'.repeat(8000), '', null]) {
    assert.deepEqual(finalReply(reply({ apiCallId, turnId: 'unobserved' }))?.key, key('reply'));
  }
});

test('phase is ignored: providers with or without phase use the same tool-request rule', () => {
  for (const phase of [undefined, null, '', 'commentary', 'final_answer', 'future_final']) {
    assert.deepEqual(finalReply(reply({ phase }))?.key, key('reply'));
    assert.deepEqual(finalReply(reply({ phase, toolRequests: [] }))?.key, key('reply'));
    assert.equal(finalReply(reply({ phase, toolRequests: [{ name: 'view' }] })), undefined);
  }
  for (const content of ['', ' \n ', undefined]) assert.equal(finalReply(reply({ content })), undefined);
  for (const toolRequests of [[{ name: 'view' }], null, {}]) {
    assert.equal(finalReply(reply({ toolRequests })), undefined);
  }
});

test('only non-ephemeral primary assistant messages qualify', () => {
  for (const fields of [{ agentId: 'child' }, { parentToolCallId: 'tool' }]) {
    const event = reply();
    Object.assign(event.event, fields);
    assert.equal(finalReply(event), undefined);
    assert.equal(finalReply(reply(fields)), undefined);
  }
  const ephemeral = reply();
  ephemeral.event.ephemeral = true;
  assert.equal(finalReply(ephemeral), undefined);
  for (const type of ['assistant.message_delta', 'assistant.message_start', 'assistant.turn_end',
    'assistant.idle', 'abort', 'session.error', 'tool.execution_complete']) {
    const event = reply();
    event.event.type = type;
    assert.equal(finalReply(event), undefined);
  }
});

test('invalid final identity reports an error and cannot affect a later valid event', () => {
  for (const messageId of [undefined, '', 'bad id']) {
    assert.throws(() => finalReply(reply({ messageId })), { code: 'INVALID_REPLY_IDENTITY' });
  }
  const event = reply();
  event.sessionId = 'bad session';
  assert.throws(() => finalReply(event), { code: 'INVALID_REPLY_IDENTITY' });
  assert.ok(finalReply(reply()));
});

test('only bounded final text is retained in the preview, never token content or reasoning', () => {
  const result = finalReply(reply({ content: '🙂'.repeat(20000), reasoningText: 'private-reasoning' }))!;
  assert.equal(Array.from(result.summary).length, 120);
  assert.ok(result.summary.endsWith('…'));
  assert.deepEqual(Object.keys(result).sort(), ['key', 'summary']);
  assert.ok(!JSON.stringify(result).includes('private-reasoning'));
});
