import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSendResult, parseDeliveryStatus } from './delivery.ts';

test('diagnostic parsers whitelist bounded primitive facts and reject contradictory status/phase data', () => {
  const valid = { outcome: 'FAILED', phase: 'response', upstreamStatus: 401, retryAfterSeconds: 30 };
  assert.deepEqual(parseSendResult({ ...valid, endpoint: 'secret', response: { body: 'secret' } }), valid);
  for (const value of [
    { ...valid, outcome: { toString: () => 'FAILED', secret: true } },
    { ...valid, phase: ['response'] },
    { ...valid, upstreamStatus: '401' }, { ...valid, upstreamStatus: 999 },
    { ...valid, outcome: 'ACCEPTED' }, { ...valid, phase: 'preparation' },
    { ...valid, retryAfterSeconds: 86401 }, { ...valid, retryAfterSeconds: -1 },
    { ...valid, networkCategory: 'dns' },
    { outcome: 'UNKNOWN', phase: 'transport', networkCategory: { toString: () => 'dns' } },
    { outcome: 'UNKNOWN', phase: 'response' },
  ]) assert.throws(() => parseSendResult(value));
  assert.deepEqual(parseDeliveryStatus({ latest: { at: 1, result: valid, secret: 'secret' }, secret: 'secret' }),
    { latest: { at: 1, result: valid } });
  assert.throws(() => parseDeliveryStatus({ latest: { at: 1, result: valid, invalidation: 'secret' } }));
  assert.throws(() => parseDeliveryStatus({ latest: { at: 1, result: valid }, lastAcceptedAt: -1 }));
});
