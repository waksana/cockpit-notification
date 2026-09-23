import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directory, subscription } from './test-fixtures.ts';
import { settings, SubscriptionStore, subscriptionId, validateEndpoint, validateSubscription, WSL2_GUIDE_URL } from './storage.ts';
import { publicAddress } from './push.ts';

test('VAPID keys and subscriptions persist privately and registration/update/delete are idempotent', t => {
  const root = directory(t);
  const store = new SubscriptionStore(root, settings({}));
  const first = subscription('a');
  const id = store.register(first, 0);
  assert.equal(id, subscriptionId(first));
  assert.equal(store.register(first, 0), id);
  assert.equal(store.active(0).length, 1);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, 'push-config.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root), ['push-config.json']);
  const restarted = new SubscriptionStore(root, settings({}));
  assert.deepEqual(restarted.vapid, store.vapid);
  assert.equal(restarted.registered(id, 0), true);
  restarted.remove(id);
  restarted.remove(id);
  assert.equal(new SubscriptionStore(root, settings({})).active(0).length, 0);
});

test('non-Linux platforms report the Linux/WSL2 requirement before any privacy check', t => {
  const root = directory(t);
  const target = join(root, 'data');
  for (const platform of ['win32', 'darwin'] as const) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      assert.throws(() => new SubscriptionStore(target, settings({})), (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'UNSUPPORTED_PLATFORM' &&
        error.message === `Cockpit Notification requires Linux (current platform: ${platform}). ` +
          `On Windows, run Cockpit inside WSL2: ${WSL2_GUIDE_URL}`);
    } finally { Object.defineProperty(process, 'platform', original); }
  }
  assert.deepEqual(readdirSync(root), []);
});

test('invalid existing secrets are never regenerated or exposed in errors', t => {
  const root = directory(t);
  const file = join(root, 'push-config.json');
  const invalid = '{"privateKey":"synthetic-secret-do-not-log"}';
  writeFileSync(file, invalid, { mode: 0o600 });
  assert.throws(() => new SubscriptionStore(root, settings({})), (error: unknown) =>
    error instanceof Error && !error.message.includes('synthetic-secret') &&
    'code' in error && error.code === 'INVALID_STORAGE');
  assert.equal(readFileSync(file, 'utf8'), invalid);
});

test('symlink roots/files, public modes and key mismatch fail safely', t => {
  const root = directory(t);
  const real = join(root, 'real');
  mkdirSync(real, { mode: 0o700 });
  const linked = join(root, 'linked');
  symlinkSync(real, linked);
  assert.throws(() => new SubscriptionStore(linked, settings({})), { code: 'UNSAFE_STORAGE' });
  chmodSync(real, 0o755);
  assert.throws(() => new SubscriptionStore(real, settings({})), { code: 'UNSAFE_STORAGE' });
  chmodSync(real, 0o700);
  new SubscriptionStore(real, settings({}));
  symlinkSync(join(real, 'push-config.json'), join(root, 'push-config.json'));
  assert.throws(() => new SubscriptionStore(root, settings({})));
  const file = join(real, 'push-config.json');
  chmodSync(file, 0o644);
  assert.throws(() => new SubscriptionStore(real, settings({})), { code: 'UNSAFE_STORAGE' });
  chmodSync(file, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { vapid: { privateKey: string } };
  saved.vapid.privateKey = Buffer.alloc(32, 1).toString('base64url');
  writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => new SubscriptionStore(real, settings({})), { code: 'INVALID_STORAGE' });
});

test('known push endpoints use exact host/suffix guards and forbid ports and credentials', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/synthetic', 'https://updates.push.services.mozilla.com/wpush/synthetic',
    'https://web.push.apple.com/synthetic',
    'https://wns2-synthetic.notify.windows.com/w/?token=synthetic-only',
    'https://future-region.notify.windows.com/synthetic',
  ]) assert.equal(validateEndpoint(endpoint, []), endpoint);
  for (const endpoint of [
    'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:443/x', 'https://fcm.googleapis.com:8443/x',
    'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com/x#', 'https://fcm.googleapis.com.evil.com/x',
    'https://notpush.apple.com/x', 'https://push.apple.com/x', 'https://web.push.apple.com.evil.com/x',
    'https://notify.windows.com/x', 'https://notnotify.windows.com/x',
    'https://wns2-synthetic.notify.windows.com.evil.com/x', 'https://wns2-synthetic.notify.windows.com./x',
    'https://wns2-synthetic.notify.windows.com:443/x', 'https://wns2-synthetic.notify.windows.com:8443/x',
    'http://wns2-synthetic.notify.windows.com/x', 'https://user@wns2-synthetic.notify.windows.com/x',
    'https://wns2-synthetic.notify.windows.com/x#fragment', 'https://windows.com/x',
    'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://fcm.googleapis.com./x',
    'https://fcm.googleapis.com\\@evil.com/x', `https://fcm.googleapis.com/${'x'.repeat(2048)}`,
    `https://fcm.googleapis.com/${'界'.repeat(500)}`,
  ]) assert.throws(() => validateEndpoint(endpoint, []), { code: 'INVALID_PUSH_ENDPOINT' });
  assert.equal(validateEndpoint('https://push.example.org/synthetic', ['push.example.org']),
    'https://push.example.org/synthetic');
});

test('Edge WNS subscriptions register and reload without enabling arbitrary public hosts', t => {
  const root = directory(t);
  const store = new SubscriptionStore(root, settings({}));
  const endpoint = 'https://wns2-synthetic.notify.windows.com/w/?token=synthetic-only';
  const device = { ...subscription(), endpoint };
  const id = store.register(device, 0);
  assert.equal(store.register(device, 0), id);
  const restarted = new SubscriptionStore(root, settings({}));
  assert.deepEqual(restarted.active(0).map(value => value.subscription.endpoint), [endpoint]);
  assert.equal(restarted.registered(id, 0), true);
  assert.throws(() => restarted.register({ ...device, endpoint: 'https://arbitrary.example.org/synthetic' }, 0),
    { code: 'INVALID_PUSH_ENDPOINT' });
  restarted.remove(id);
  assert.equal(restarted.active(0).length, 0);
});

test('public-address guard blocks private, loopback, mapped and reserved DNS answers', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254',
    '100.100.100.100', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '64:ff9b::7f00:1', 'invalid']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
});

test('subscription validation bounds keys, expiry and 64-device capacity', t => {
  const valid = subscription();
  for (const bad of [
    { ...valid, keys: { ...valid.keys, auth: 'bad' } },
    { ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65).toString('base64url') } },
    { ...valid, expirationTime: -1 }, { ...valid, unexpected: true },
  ]) assert.throws(() => validateSubscription(bad, []));
  const store = new SubscriptionStore(directory(t), settings({}));
  assert.throws(() => store.register({ ...valid, expirationTime: 100 }, 100), { code: 'EXPIRED_SUBSCRIPTION' });
  const id = store.register({ ...valid, expirationTime: 100 }, 0);
  assert.equal(store.registered(id, 101), false);
  for (let i = 1; i < 64; i++) store.register({ ...valid, endpoint: `https://fcm.googleapis.com/synthetic-${i}` }, 0);
  assert.throws(() => store.register(subscription('overflow'), 0), { code: 'SUBSCRIPTION_CAPACITY' });
  assert.equal(store.active(0).length, 64);
});

test('configuration rejects unbounded delays and wildcard/private extra hosts', () => {
  assert.equal(settings({}).pushDelayMs, 3000);
  assert.throws(() => settings({ pushDelay: 3000 }), { code: 'INVALID_CONFIG' });
  assert.equal(settings({ pushDelayMs: 0 }).pushDelayMs, 0);
  for (const config of [{ pushDelayMs: -1 }, { pushDelayMs: 60_001 }, { pushDelayMs: 0.5 },
    { vapidSubject: 'synthetic-secret-invalid' }, { extraPushHosts: ['*.example.com'] },
    { extraPushHosts: ['127.0.0.1'] }, { extraPushHosts: ['example.local'] },
    { extraPushHosts: ['https://push.example.com'] }, { extraPushHosts: ['push.example.com:443'] }]) {
    assert.throws(() => settings(config), { code: 'INVALID_CONFIG' });
  }
});
