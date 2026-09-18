import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationExcerpt, notificationTitle, sessionTitle, MAX_PREVIEW_LENGTH } from './preview.ts';
import { key } from './native-fixtures.ts';
import { parsePayload } from '../shared/protocol.ts';

test('notification excerpts flatten common Markdown and whitespace without reading link targets', () => {
  assert.equal(notificationExcerpt('## 已完成\n\n- **保留已读**\n- 查看 [变更](https://example.test/private)\n\n`some_name`'),
    '已完成 保留已读 查看 变更 some_name');
  assert.equal(notificationExcerpt('```ts\nconst ready = true;\n```\n继续'), 'const ready = true; 继续');
  assert.equal(notificationExcerpt('选择\u202e哪个？\u0000\n\n允许\t继续'), '选择哪个？ 允许 继续');
  assert.equal(notificationExcerpt(' \n '), '');
});

test('excerpts and titles have explicit Unicode-safe bounds, including giant input', () => {
  for (const value of ['界'.repeat(10_000), '🙂'.repeat(10_000), 'line\n'.repeat(10_000)]) {
    const summary = notificationExcerpt(value);
    assert.equal(Array.from(summary).length <= MAX_PREVIEW_LENGTH, true);
    assert.doesNotMatch(summary, /[\ud800-\udfff]/u);
    assert.ok(summary.endsWith('…'));
  }
  assert.equal(notificationExcerpt('a'.repeat(119) + '🙂'), 'a'.repeat(119) + '🙂');
  assert.equal(notificationExcerpt('\ud800invalid\udfff'), '\ufffdinvalid\ufffd');
  assert.equal(Array.from(sessionTitle('🙂'.repeat(1000))).length, 64);
  const title = notificationTitle(key('message'), sessionTitle('🙂'.repeat(1000)));
  assert.ok(title.startsWith('新回复：'));
  assert.ok(title.length <= 160);
  assert.doesNotThrow(() => parsePayload({
    moduleId: 'cockpit-notification', generation: 'generation', key: key('message'),
    createdRevision: 1, revision: 1, total: 1, title, body: notificationExcerpt('🙂'.repeat(1000)),
    navigationTarget: 'session/session-a',
  }));
});

test('notification headings distinguish replies and asks and identify an unavailable session title', () => {
  assert.equal(notificationTitle(key('reply'), sessionTitle('  前端\n调优  ')), '新回复：前端 调优');
  assert.equal(notificationTitle(key('ask', 'session-a', 'ask'), '前端调优'), '待回答：前端调优');
  assert.equal(notificationTitle(key('reply')), '新回复：会话 session-');
});
