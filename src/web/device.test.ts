import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ModuleFrontendContext } from '@cockpit/module-api';
import { DeviceBridge, sameKey, subscriptionId, vapidBytes } from './device.ts';
import type { Snapshot } from '../shared/protocol.ts';

const scope = 'https://host.test/deployment/_modules/workers/cockpit-notification/';
const entry = `${scope}worker.js`;
const key = Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : 0);
const vapidPublicKey = Buffer.from(key).toString('base64url');
const state: Snapshot = { generation: 'generation-a', revision: 0, total: 0, complete: true, sessions: [] };
function fixture(t: { after(fn: () => void): void }) {
  const restorers: (() => void)[] = [];
  const replace = (name: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restorers.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name);
    });
  };
  let permission: NotificationPermission = 'granted';
  let permissionRequests = 0;
  let registrations = 0;
  let updates = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  let installed = true;
  let registered = false;
  let rejectUnsubscribe = false;
  let updateError: Error | null = null;
  let authoritativeId: string | null = null;
  const posted: unknown[] = [];
  const requests: { path: string; init?: RequestInit }[] = [];
  const errors: unknown[] = [];
  let subscription: PushSubscription | null = null;
  const registrationListeners = new Set<() => void>();
  const workerListeners = new Set<() => void>();
  const createSubscription = (applicationServerKey = key): PushSubscription => ({
    endpoint: 'https://push.synthetic.test/device-only-fixture',
    options: { userVisibleOnly: true, applicationServerKey: applicationServerKey.buffer as ArrayBuffer },
    expirationTime: null,
    getKey() { return null; },
    toJSON() { return { endpoint: this.endpoint, expirationTime: null,
      keys: { p256dh: 'synthetic-public-key', auth: 'synthetic-auth' } }; },
    async unsubscribe() { unsubscriptions++; if (rejectUnsubscribe) return false; subscription = null; return true; },
  });
  const worker = {
    scriptURL: entry, state: 'activated',
    addEventListener(_type: string, listener: () => void) { workerListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { workerListeners.delete(listener); },
    postMessage(message: unknown, ports: MessagePort[]) {
      posted.push(message);
      ports[0]!.postMessage({ ok: true, badgeSupported: true });
      ports[0]!.close();
    },
  };
  const registration = {
    scope, active: worker, installing: null as typeof worker | null, waiting: null as typeof worker | null,
    addEventListener(_type: string, listener: () => void) { registrationListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { registrationListeners.delete(listener); },
    async update() { updates++; if (updateError) throw updateError; return registration; },
    pushManager: {
      async getSubscription() { return subscription; },
      async subscribe() { subscriptions++; subscription = createSubscription(); return subscription; },
    },
  };
  replace('location', new URL('https://host.test/deployment/session/session-a'));
  replace('isSecureContext', true);
  replace('PushManager', class {});
  replace('Notification', {
    get permission() { return permission; },
    async requestPermission() { permissionRequests++; permission = 'granted'; return permission; },
  });
  replace('navigator', { serviceWorker: {
    get controller() { throw new Error('The chat page is deliberately not worker-controlled'); },
    async getRegistration() { return installed ? registration : undefined; },
    async register(url: string, options: RegistrationOptions) {
      assert.equal(url, entry);
      assert.deepEqual(options, { scope, type: 'classic', updateViaCache: 'none' });
      registrations++; installed = true; return registration;
    },
  } });
  const controller = new AbortController();
  const context = {
    apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1, moduleId: 'cockpit-notification',
    apiBase: `https://host.test/deployment/_modules/cockpit-notification/${'a'.repeat(64)}/api`,
    config: { vapidPublicKey }, worker: { entry, scope }, signal: controller.signal,
    report: (error: unknown) => errors.push(error),
    request: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      if (init?.method === 'DELETE') { registered = false; return new Response(null, { status: 204 }); }
      if (init?.method === 'POST') {
        registered = true;
        return Response.json({ id: authoritativeId ?? await subscriptionId(subscription!), generation: state.generation, state });
      }
      return Response.json({ registered });
    },
  } as unknown as ModuleFrontendContext;
  const bridge = new DeviceBridge(context);
  t.after(() => { bridge.dispose(); controller.abort(); restorers.reverse().forEach(restore => restore()); });
  return { bridge, context, posted, requests, errors, worker, replace, updates: () => updates,
    failUpdate: (error: Error | null) => { updateError = error; },
    assignId: (id: string) => { authoritativeId = id; },
    startUpdate() {
      registration.waiting = { ...worker, state: 'installed' };
      for (const listener of [...registrationListeners]) listener();
    },
    activateUpdate() {
      registration.active = registration.waiting!;
      registration.active.state = 'activated';
      registration.waiting = null;
      for (const listener of [...workerListeners]) listener();
    },
    lifecycleListeners: () => registrationListeners.size + workerListeners.size,
    createSubscription, counts: () => ({ permissionRequests, registrations, subscriptions, unsubscriptions }),
    setPermission: (value: NotificationPermission) => { permission = value; },
    setInstalled: (value: boolean) => { installed = value; },
    setRegistered: (value: boolean) => { registered = value; },
    setSubscription: (value: PushSubscription | null) => { subscription = value; },
    rejectUnsubscribe: () => { rejectUnsubscribe = true; },
  };
}

test('VAPID decoding and endpoint identity are exact without persistent browser subscription metadata', async t => {
  const f = fixture(t);
  assert.deepEqual(vapidBytes(vapidPublicKey), key);
  const sub = f.createSubscription();
  assert.equal(await subscriptionId(sub), createHash('sha256').update(sub.endpoint).digest('hex'));
  const endpoint = 'https://PUSH.synthetic.test:443/a/../device-only-fixture';
  assert.equal(await subscriptionId({ endpoint }), createHash('sha256').update(new URL(endpoint).href).digest('hex'));
  assert.equal(sameKey(sub, key), true);
  assert.equal(sameKey(sub, new Uint8Array(65)), false);
  for (const invalid of ['', 'not a key', Buffer.alloc(65).toString('base64url')]) assert.throws(() => vapidBytes(invalid));
});

test('activation bootstrap inspects an installed worker without permission, registration or subscription prompts', async t => {
  const f = fixture(t);
  f.setPermission('default');
  f.setSubscription(f.createSubscription());
  f.setRegistered(true);
  await f.bridge.bootstrap();
  assert.deepEqual(f.counts(), { permissionRequests: 0, registrations: 0, subscriptions: 0, unsubscriptions: 0 });
  assert.equal(f.bridge.getSnapshot().registered, true);
  assert.deepEqual(f.posted, [{ type: 'SYNC' }]);
  assert.match(f.requests[0]!.path, /^\/subscriptions\/[a-f0-9]{64}$/);
  assert.equal(f.requests[0]!.init?.cache, 'no-store');
  assert.equal(f.updates(), 1);
});

for (const operation of ['enable', 'disable'] as const) {
  test(`a late bootstrap subscription response cannot overwrite successful ${operation}`, async t => {
    const f = fixture(t);
    f.setSubscription(f.createSubscription());
    f.setRegistered(operation === 'disable');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const request = f.context.request;
    f.context.request = async (path, init) => {
      const response = await request(path, init);
      if (!init?.method || init.method === 'GET') { entered(); await gate; }
      return response;
    };
    const bootstrapping = f.bridge.bootstrap();
    await started;
    await f.bridge[operation]();
    const after = f.bridge.getSnapshot();
    assert.equal(after.registered, operation === 'enable');
    assert.equal(after.subscribed, operation === 'enable');
    release();
    await bootstrapping;
    assert.deepEqual(f.bridge.getSnapshot(), after);
  });
}

test('late worker lookup cannot detach a registration installed by explicit enable', async t => {
  const f = fixture(t);
  f.setInstalled(false);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const lookup = navigator.serviceWorker.getRegistration.bind(navigator.serviceWorker);
  navigator.serviceWorker.getRegistration = async clientURL => {
    const blocked = first;
    first = false;
    const result = await lookup(clientURL);
    if (blocked) await gate;
    return result;
  };
  const bootstrapping = f.bridge.bootstrap();
  await f.bridge.enable();
  release();
  await bootstrapping;
  assert.equal(f.bridge.getSnapshot().installed, true);
  assert.equal(f.bridge.getSnapshot().registered, true);
  await f.bridge.disable();
  assert.equal(f.bridge.getSnapshot().registered, false);
  assert.equal(f.requests.at(-1)?.init?.method, 'DELETE');
});

test('an explicit enable retry reuses the browser subscription after server registration was rejected', async t => {
  const f = fixture(t);
  const request = f.context.request;
  let rejectRegistration = true;
  const bodies: string[] = [];
  f.context.request = async (path, init) => {
    if (path === '/subscriptions' && init?.method === 'POST') {
      bodies.push(String(init.body));
      if (rejectRegistration) return Response.json({
        code: 'INVALID_PUSH_ENDPOINT', message: 'Push endpoint is not an allowed HTTPS service',
      }, { status: 400 });
    }
    return request(path, init);
  };
  await f.bridge.enable();
  assert.equal(f.bridge.getSnapshot().subscribed, true);
  assert.equal(f.bridge.getSnapshot().registered, false);
  assert.match(f.bridge.getSnapshot().error!, /400/);
  assert.equal(f.counts().subscriptions, 1);
  rejectRegistration = false;
  await f.bridge.enable();
  assert.equal(f.bridge.getSnapshot().registered, true);
  assert.equal(f.bridge.getSnapshot().subscribed, true);
  assert.equal(f.bridge.getSnapshot().error, null);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'retry uses the existing subscription, not a new permission request or endpoint');
  assert.equal(f.counts().subscriptions, 1);
  assert.equal(f.counts().unsubscriptions, 0);
  assert.equal(f.counts().permissionRequests, 0);
});

test('an obsolete subscription lookup failure cannot replace the successful mutation status', async t => {
  const f = fixture(t);
  f.setSubscription(f.createSubscription());
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const request = f.context.request;
  f.context.request = async (path, init) => {
    if (!init?.method || init.method === 'GET') {
      entered();
      await gate;
      return Response.json({ code: 'SYNTHETIC_ERROR', message: 'obsolete lookup' }, { status: 503 });
    }
    return request(path, init);
  };
  const bootstrapping = f.bridge.bootstrap();
  await started;
  await f.bridge.enable();
  release();
  await bootstrapping;
  assert.equal(f.bridge.getSnapshot().registered, true);
  assert.equal(f.bridge.getSnapshot().error, null);
  assert.deepEqual(f.errors, []);
});

test('installed worker updates on next use, exposes waiting activation and reapplies state after activation', async t => {
  const f = fixture(t);
  await f.bridge.bootstrap();
  f.bridge.apply(state, []);
  await new Promise(resolve => setTimeout(resolve, 20));
  f.startUpdate();
  assert.equal(f.bridge.getSnapshot().updatePending, true);
  await f.bridge.refreshWorker();
  assert.equal(f.updates(), 2);
  assert.equal(f.bridge.getSnapshot().updatePending, true);
  const previous = f.posted.length;
  f.activateUpdate();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.bridge.getSnapshot().updatePending, false);
  assert.equal(f.posted.length, previous + 1);
  assert.deepEqual(f.posted.at(-1), { type: 'APPLY_STATE', state, acknowledged: [] });
  assert.equal(f.counts().registrations, 0);
  assert.equal(f.counts().permissionRequests, 0);
  f.bridge.dispose();
  assert.equal(f.lifecycleListeners(), 0);
});

test('offline worker update failure remains explicit without replacing registration or claiming a subscription', async t => {
  const f = fixture(t);
  f.failUpdate(new Error('synthetic offline worker update'));
  await f.bridge.bootstrap();
  assert.match(f.bridge.getSnapshot().error!, /offline worker update/);
  assert.equal(f.bridge.getSnapshot().installed, true);
  assert.equal(f.bridge.getSnapshot().registered, false);
  assert.equal(f.counts().registrations, 0);
  f.failUpdate(null);
  f.bridge.apply(state, []);
  await f.bridge.refreshWorker();
  assert.equal(f.bridge.getSnapshot().error, null);
  assert.equal(f.updates(), 2);
});

test('an uncontrolled foreground page sends snapshots to the active registration without taking control', async t => {
  const f = fixture(t);
  await f.bridge.bootstrap();
  f.bridge.apply(state, []);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.posted, [{ type: 'SYNC' }, { type: 'APPLY_STATE', state, acknowledged: [] }]);
  assert.deepEqual(f.counts(), { permissionRequests: 0, registrations: 0, subscriptions: 0, unsubscriptions: 0 });
});

test('host worker scope cannot be widened to the application or origin root', t => {
  const f = fixture(t);
  for (const widened of ['https://host.test/', 'https://host.test/deployment/', 'https://host.test/deployment/_modules/workers/']) {
    const invalid = new DeviceBridge({ ...f.context, worker: { entry, scope: widened } });
    assert.equal(invalid.getSnapshot().supported, false);
    assert.match(invalid.getSnapshot().error!, /路径无效/);
    invalid.dispose();
  }
  assert.equal(f.counts().registrations, 0);
});

test('without an existing worker bootstrap never installs; only explicit enable asks and registers', async t => {
  const f = fixture(t);
  f.setInstalled(false);
  f.setPermission('default');
  await f.bridge.bootstrap();
  assert.deepEqual(f.counts(), { permissionRequests: 0, registrations: 0, subscriptions: 0, unsubscriptions: 0 });
  await f.bridge.enable();
  assert.deepEqual(f.counts(), { permissionRequests: 1, registrations: 1, subscriptions: 1, unsubscriptions: 0 });
  assert.equal(f.bridge.getSnapshot().registered, true);
  assert.equal(f.requests[0]?.path, '/subscriptions');
  assert.equal(f.requests[0]?.init?.method, 'POST');
  assert.deepEqual(f.posted, [{ type: 'SYNC' }], 'subscription POST state is not worker read authority');
});

test('subscription receipt never supplies authority, and explicit enable requests an independent worker GET', async t => {
  const f = fixture(t);
  await f.bridge.bootstrap();
  const request = f.context.request;
  f.context.request = async (path, init) => {
    if (path === '/subscriptions' && init?.method === 'POST') {
      return Response.json({ id: 'synthetic-device-id', generation: 'generation-b',
        state: { unexpected: 'POST snapshots are not authority' } });
    }
    return request(path, init);
  };
  await f.bridge.enable();
  assert.equal(f.bridge.getSnapshot().registered, true);
  assert.deepEqual(f.posted, [{ type: 'SYNC' }, { type: 'SYNC' }]);
  assert.deepEqual(f.errors, []);
});

test('device APPLY never forwards HTTP acknowledgement identities as cleanup proof', async t => {
  const f = fixture(t);
  await f.bridge.bootstrap();
  f.bridge.apply(state, [{ sessionId: 'session-a', kind: 'reply', nativeId: 'early-http-ack' }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.posted.at(-1), { type: 'APPLY_STATE', state, acknowledged: [] });
});

test('explicit registration uses the authoritative POST id for later removal, without re-deriving it', async t => {
  const f = fixture(t);
  f.assignId('authoritative-synthetic-device-id');
  await f.bridge.bootstrap();
  await f.bridge.enable();
  assert.equal(f.bridge.getSnapshot().registered, true);
  await f.bridge.disable();
  assert.equal(f.requests.at(-1)?.path, '/subscriptions/authoritative-synthetic-device-id');
  assert.equal(f.requests.at(-1)?.init?.method, 'DELETE');
});

test('VAPID change is displayed, not silently resubscribed; explicit action renews the device', async t => {
  const f = fixture(t);
  const old = Uint8Array.from(key);
  old[1] = 9;
  f.setSubscription(f.createSubscription(old));
  f.setRegistered(true);
  await f.bridge.bootstrap();
  assert.equal(f.bridge.getSnapshot().needsResubscribe, true);
  assert.equal(f.counts().subscriptions, 0);
  await f.bridge.enable();
  assert.equal(f.bridge.getSnapshot().needsResubscribe, false);
  assert.equal(f.counts().unsubscriptions, 1);
  assert.equal(f.counts().subscriptions, 1);
  assert.deepEqual(f.requests.map(request => request.init?.method ?? 'GET'), ['GET', 'DELETE', 'POST']);
});

test('unsubscribe error is honest and does not unregister the known worker or claim browser success', async t => {
  const f = fixture(t);
  f.setSubscription(f.createSubscription());
  f.setRegistered(true);
  await f.bridge.bootstrap();
  f.rejectUnsubscribe();
  await f.bridge.disable();
  assert.equal(f.bridge.getSnapshot().registered, false);
  assert.equal(f.bridge.getSnapshot().subscribed, true);
  assert.match(f.bridge.getSnapshot().error!, /服务端已停用/);
  assert.equal(f.bridge.getSnapshot().installed, true);
  await f.bridge.bootstrap();
  assert.equal(f.bridge.getSnapshot().registered, false);
  assert.equal(f.requests.some(request => request.init?.method === 'POST'), false, 'bootstrap must not silently re-enable the server record');
});

test('unknown worker, malformed host path, and permission denial are explicit, never replaced or hidden', async t => {
  const f = fixture(t);
  f.worker.scriptURL = 'https://host.test/unrelated-worker.js';
  await f.bridge.bootstrap();
  assert.match(f.bridge.getSnapshot().error!, /其他 worker/);
  assert.equal(f.counts().registrations, 0);
  f.setPermission('denied');
  await f.bridge.enable();
  assert.match(f.bridge.getSnapshot().error!, /权限未允许/);
  assert.equal(f.counts().permissionRequests, 0);
  const invalid = new DeviceBridge({ ...f.context, worker: { entry: 'https://outside.test/worker.js', scope } });
  assert.equal(invalid.getSnapshot().supported, false);
  assert.match(invalid.getSnapshot().error!, /路径无效/);
  invalid.dispose();
});

test('worker-reported device failures remain visible while unsupported Web Push does not disable webpage state', async t => {
  const f = fixture(t);
  await f.bridge.bootstrap();
  assert.equal(f.bridge.handleMessage({ source: f.worker, data: {
    moduleId: 'cockpit-notification', type: 'ERROR', error: 'synthetic permission failure',
  } } as unknown as MessageEvent), false);
  assert.match(f.bridge.getSnapshot().error!, /permission failure/);
  assert.equal(f.bridge.handleMessage({ source: {}, data: {
    moduleId: 'cockpit-notification', type: 'INVALIDATE',
  } } as unknown as MessageEvent), false);
  f.replace('PushManager', undefined);
  const unsupported = new DeviceBridge(f.context);
  assert.equal(unsupported.getSnapshot().supported, false);
  unsupported.dispose();
});

test('only the active module worker can forward validated version hints; old invalidations do not request GET', async t => {
  const f = fixture(t);
  await f.bridge.bootstrap();
  const hint = { type: 'unread/sync', generation: 'generation-a', revision: 12 } as const;
  const message = (source: unknown, data: unknown) => ({ source, data } as MessageEvent);
  assert.deepEqual(f.bridge.handleMessage(message(f.worker, { moduleId: 'cockpit-notification', ...hint })), hint);
  assert.equal(f.bridge.handleMessage(message({}, { moduleId: 'cockpit-notification', ...hint })), false);
  assert.equal(f.bridge.handleMessage(message(f.worker, { moduleId: 'cockpit-notification', type: 'INVALIDATE' })), false);
  assert.equal(f.bridge.handleMessage(message(f.worker, {
    moduleId: 'cockpit-notification', ...hint, revision: '12',
  })), false);
  assert.match(f.bridge.getSnapshot().error!, /Invalid unread event version/);
  assert.deepEqual(f.requests, []);
});

test('disposing while the permission gesture is pending cannot later install or subscribe a device', async t => {
  const f = fixture(t);
  f.setInstalled(false);
  let release!: (permission: NotificationPermission) => void;
  f.replace('Notification', {
    permission: 'default',
    requestPermission: () => new Promise<NotificationPermission>(resolve => { release = resolve; }),
  });
  const enabling = f.bridge.enable();
  f.bridge.dispose();
  release('granted');
  await enabling;
  assert.equal(f.counts().registrations, 0);
  assert.equal(f.counts().subscriptions, 0);
  assert.equal(f.requests.length, 0);
});
