import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleRegion } from './visibility.ts';

const rect = (top: number, bottom: number, left = 10, right = 290) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top });
const viewport = { top: 0, left: 0, height: 600, width: 300 };

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
