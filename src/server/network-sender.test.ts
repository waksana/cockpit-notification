import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { networkSender, retryAfter, type PushTransport } from './push.ts';
import { SubscriptionStore, settings } from './storage.ts';
import { directory, flush, key, subscription } from './test-fixtures.ts';
import type { NotificationPayload } from '../shared/protocol.ts';

const payload: NotificationPayload = {
  moduleId: 'cockpit-notification', generation: 'synthetic', key: key('synthetic'),
  createdRevision: 1, revision: 1, total: 1, title: 'synthetic-secret-title',
  body: 'synthetic-secret-body', navigationTarget: 'session/synthetic',
};
class Request extends EventEmitter {
  end() {}
  destroy(error?: Error) {
    if (error) this.emit('error', error);
    this.emit('close');
  }
}

test('network sender preserves every HTTP rejection and acceptance only after the request closes', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  store.register(subscription(), 0);
  for (const upstreamStatus of [200, 201, 202, 204, 301, 400, 401, 403, 404, 410, 413, 429, 500, 503]) {
    const request = new Request();
    const response = Object.assign(new EventEmitter(), { statusCode: upstreamStatus,
      headers: { 'retry-after': '120', 'x-secret': 'synthetic-secret-response' }, destroy() {} });
    const transport: PushTransport = (_endpoint, options, onResponse) => {
      assert.equal(options.agent, false);
      assert.equal(options.timeout, 10_000);
      queueMicrotask(() => onResponse(response));
      return request;
    };
    let settled = false;
    const flight = networkSender(store, transport)(store.active(0)[0]!, payload, new AbortController().signal)
      .then(result => { settled = true; return result; });
    await flush();
    assert.equal(settled, false);
    request.emit('error', new Error('synthetic-secret-error-after-response'));
    request.emit('close');
    assert.deepEqual(await flight, { outcome: upstreamStatus < 300 ? 'ACCEPTED' : 'FAILED',
      phase: 'response', upstreamStatus, retryAfterSeconds: 120 });
  }
});

test('network exceptions are bounded categories, not messages, endpoints or response bodies', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  store.register(subscription(), 0);
  for (const [code, category] of [
    ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['PUSH_DESTINATION_BLOCKED', 'destination-blocked'],
    ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ETIMEDOUT', 'timeout'], ['ECONNRESET', 'connection'], ['ECONNREFUSED', 'connection'],
    ['synthetic-secret-code', 'other'],
  ]) {
    const request = new Request();
    const transport: PushTransport = () => {
      queueMicrotask(() => request.destroy(Object.assign(new Error('synthetic-secret-network'), { code })));
      return request;
    };
    const result = await networkSender(store, transport)(store.active(0)[0]!, payload, new AbortController().signal);
    assert.deepEqual(result, { outcome: 'UNKNOWN', phase: 'transport', networkCategory: category });
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  }
});

test('preparation, cancellation, timeout and missing headers do not invent upstream statuses', async t => {
  const store = new SubscriptionStore(directory(t), settings({}));
  store.register(subscription(), 0);
  const device = store.active(0)[0]!;
  const controller = new AbortController();
  controller.abort();
  const never: PushTransport = () => { throw new Error('Transport must not be used'); };
  assert.deepEqual(await networkSender(store, never)(device, payload, controller.signal),
    { outcome: 'UNKNOWN', phase: 'cancelled', networkCategory: 'aborted' });
  assert.deepEqual(await networkSender(store, never)({ ...device,
    subscription: { ...device.subscription, keys: { p256dh: 'bad', auth: 'bad' } } }, payload, new AbortController().signal),
  { outcome: 'FAILED', phase: 'preparation' });
  assert.deepEqual(await networkSender(store, never)(device, payload, new AbortController().signal),
    { outcome: 'FAILED', phase: 'preparation' });
  for (const event of ['timeout', 'close', 'abort'] as const) {
    const controller = new AbortController();
    const request = new Request();
    const transport: PushTransport = () => {
      queueMicrotask(() => {
        if (event === 'abort') {
          controller.abort();
          request.destroy(Object.assign(new Error('synthetic-secret-abort'), { code: 'ABORT_ERR' }));
        } else request.emit(event);
      });
      return request;
    };
    assert.deepEqual(await networkSender(store, transport)(device, payload, controller.signal),
      { outcome: 'UNKNOWN', phase: event === 'abort' ? 'cancelled' : 'transport',
        networkCategory: event === 'timeout' ? 'timeout' : event === 'abort' ? 'aborted' : 'other' });
  }
});

test('Retry-After accepts bounded seconds or HTTP dates without retaining arbitrary header content', () => {
  const now = Date.parse('Wed, 11 Nov 2026 00:00:00 GMT');
  assert.equal(retryAfter('123', now), 123);
  assert.equal(retryAfter('99999999999', now), 86400);
  assert.equal(retryAfter('Wed, 11 Nov 2026 00:02:00 GMT', now), 120);
  assert.equal(retryAfter('Wed, 11 Nov 2026 00:00:00 GMT', now + 1000), 0);
  for (const value of ['-1', '1.2', 'secret', '2026-11-11', 'x'.repeat(129), ['1', '2'], undefined]) {
    assert.equal(retryAfter(value, now), undefined);
  }
});
