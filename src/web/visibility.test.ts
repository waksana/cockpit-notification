import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleRegion } from './visibility.ts';

const rect = (top: number, bottom: number, left = 10, right = 290) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top });
const viewport = { top: 0, left: 0, height: 600, width: 300 };

test('native DOMRect prototype accessors remain available for hit testing', () => {
  const native = Object.create(Object.fromEntries(
    Object.entries(rect(10, 300)).map(([key, value]) => [key, value]),
  )) as ReturnType<typeof rect>;
  assert.deepEqual(Object.keys(native), [], 'DOM geometry need not expose enumerable own fields');
  const region = visibleRegion(native, rect(10, 300), viewport);
  assert.deepEqual(region, rect(10, 300));
  assert.ok(Number.isFinite((region!.left + region!.right) / 2));
});

test('short messages require the entire message, not merely an intersecting beginning or ending', () => {
  assert.notEqual(visibleRegion(rect(10, 300), rect(10, 300), viewport), null);
  assert.equal(visibleRegion(rect(-10, 300), rect(0, 300), viewport), null);
  assert.equal(visibleRegion(rect(400, 700), rect(400, 600), viewport), null);
  assert.equal(visibleRegion(rect(10, 300), rect(10, 300, 50, 290), viewport), null);
  assert.equal(visibleRegion(rect(10, 10), rect(10, 10), viewport), null);
});

test('a long message requires its final visible region, within the actual scroll viewport', () => {
  assert.deepEqual(visibleRegion(rect(-500, 500), rect(0, 500), viewport), rect(452, 500));
  assert.equal(visibleRegion(rect(-200, 800), rect(0, 600), viewport), null);
  assert.equal(visibleRegion(rect(-980, 20), rect(0, 20), viewport), null);
  const panel = { ...viewport, top: 100, height: 300 };
  assert.deepEqual(visibleRegion(rect(-300, 350), rect(100, 350), panel), rect(302, 350));
});

test('rounded client dimensions do not make a flush subpixel message permanently unread', () => {
  const panel = { top: 56, left: 0, height: 645, width: 390 };
  const message = rect(674.03125, 701.21875, 12, 378);
  assert.deepEqual(visibleRegion(message, rect(message.top, 701, 12, 378), panel), message);
  assert.equal(visibleRegion(rect(674, 703, 12, 378), rect(674, 701, 12, 378), panel), null);
});
