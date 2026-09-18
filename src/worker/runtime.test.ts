import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationWorker } from './runtime.ts';
import type { WindowClient, WorkerEnvironment } from './runtime.ts';
import { workerConfiguration } from './device.ts';
import type { DeviceState, VisibleNotification } from './device.ts';
import type { NotificationPayload, Snapshot } from '../shared/protocol.ts';

const configuration = workerConfiguration({ moduleId: 'cockpit-notification', digest: 'a'.repeat(64),
  apiBase: `../../cockpit-notification/${'a'.repeat(64)}/api` },
'https://host.test/deployment/_modules/workers/cockpit-notification/worker.js');
const payload = (generation = 'generation-a', revision = 1): NotificationPayload => ({
  moduleId: 'cockpit-notification', generation, revision, createdRevision: 1, total: 3,
  key: { sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' },
  title: '会话有新回复', body: '请打开会话查看', navigationTarget: 'session/session-a',
});
const empty = (generation = 'generation-a', revision = 2): Snapshot => ({
  generation, revision, total: 0, complete: true, sessions: [],
});
const bootstrap = (digest = 'a'.repeat(64)) => ({
  modules: [{ id: 'cockpit-notification', digest, apiBase: `/_modules/cockpit-notification/${digest}/api` }],
  active: [{ id: 'cockpit-notification', digest }], errors: [],
});
function fixture() {
  let state: DeviceState | null = { generation: 'generation-a', revision: 0, total: 0, retired: [] };
  let fetcher: (url: string, init: RequestInit) => Promise<Response> = async () => Response.json(empty());
  let bootstrapper = async () => Response.json(bootstrap());
  const calls: { url: string; init: RequestInit }[] = [];
  const badges: number[] = [];
  const navigation: string[] = [];
  const messages: unknown[] = [];
  const notifications: (VisibleNotification & { closed: boolean })[] = [];
  const shown: unknown[] = [];
  const client: WindowClient & { navigate(url: string): Promise<never> } = {
    id: 'client-a', url: 'https://host.test/deployment/session/previous', focused: true,
    postMessage: message => { messages.push(message); },
    async navigate(_url) { throw new TypeError("This service worker is not the client's active service worker."); },
    async focus() { navigation.push('focus'); return client; },
  };
  const environment: WorkerEnvironment = {
    storage: { async load() { return state && structuredClone(state); }, async save(next) { state = structuredClone(next); } },
    navigator: { async setAppBadge(total) { badges.push(total); }, async clearAppBadge() { badges.push(0); } },
    clients: {
      async get(id) { return id === client.id ? client : undefined; },
      async matchAll() { return [client]; },
      async openWindow(url) { navigation.push(url); return client; },
    },
    registration: {
      async getNotifications() { return notifications.filter(item => !item.closed); },
      async showNotification(_title, options) {
        shown.push(options?.data);
        notifications.push({ data: options?.data, closed: false, close() { this.closed = true; } });
      },
    },
    async fetch(url, init) {
      calls.push({ url, init });
      return url === new URL('_modules', configuration.appBase).href ? bootstrapper() : fetcher(url, init);
    },
  };
  return { environment, worker: new NotificationWorker(environment, configuration), badges, calls, messages,
    notifications, shown, navigation, client, state: () => state,
    fetch: (next: (url: string, init: RequestInit) => Promise<Response>) => { fetcher = next; },
    bootstrap: (next: () => Promise<Response>) => { bootstrapper = next; },
    setState: (next: DeviceState | null) => { state = next; } };
}

test('APPLY_STATE uses one serialized device path; same-generation complete authority causes no GET', async () => {
  const f = fixture();
  await f.worker.message({ type: 'APPLY_STATE', state: empty() }, f.client.id);
  assert.deepEqual(f.badges, [0]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state()?.revision, 2);
  assert.equal(f.state()?.total, 0);
});

test('ask resolution, deleted sessions and rewind retire notifications through snapshots without READ', async () => {
  const f = fixture();
  const ask = { ...payload(), key: { ...payload().key, kind: 'ask', nativeId: 'host-request-42' } };
  const deleted = { ...payload(), key: { ...payload().key, sessionId: 'deleted-session' },
    navigationTarget: 'session/deleted-session' };
  const rewound = { ...payload(), key: { ...payload().key, nativeId: 'rewound-reply' } };
  for (const data of [ask, deleted, rewound]) {
    await f.environment.registration.showNotification('旧提醒', { data });
  }
  await f.worker.message({ type: 'APPLY_STATE', state: empty() }, f.client.id);
  assert.equal(f.notifications.every(notification => notification.closed), true);
  assert.deepEqual(f.badges, [0]);
  assert.deepEqual(f.calls, []);
});

test('network failure preserves bound state, badge and visible unknown-generation notification', async () => {
  const f = fixture();
  f.setState({ generation: 'generation-a', revision: 20, total: 5, retired: [] });
  f.fetch(async () => { throw new Error('synthetic offline'); });
  await assert.rejects(f.worker.push(payload('generation-b')), /offline/);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0]?.closed, false);
  assert.deepEqual(f.badges, []);
  assert.equal(f.state()?.generation, 'generation-a');
  assert.equal(f.state()?.total, 5);
  assert.equal(f.calls[0]?.init.cache, 'no-store');
  assert.equal(f.calls[0]?.init.credentials, 'same-origin');
  assert.deepEqual(f.calls.at(-1)?.init.headers, { 'x-cockpit-module-digest': 'a'.repeat(64) });
});

test('an offline old worker with a retired digest API shows the valid generic push and preserves its known badge', async () => {
  const f = fixture();
  f.setState({ generation: 'generation-a', revision: 20, total: 5, retired: [] });
  f.fetch(async () => Response.json({ code: 'MODULE_DIGEST_MISMATCH' }, { status: 409 }));
  const incoming = payload('generation-b');
  await assert.rejects(f.worker.push(incoming), /409/);
  assert.deepEqual(f.shown, [incoming]);
  assert.equal(f.notifications[0]?.closed, false);
  assert.deepEqual(f.badges, []);
  assert.equal(f.state()?.generation, 'generation-a');
  assert.equal(f.state()?.total, 5);
  assert.match(f.calls.at(-1)!.url, new RegExp(`/${'a'.repeat(64)}/api/state$`));
  assert.equal('apiBase' in incoming, false);
  assert.equal('apiUrl' in incoming, false);
});

test('ordinary and stale same-generation pushes do not fetch full state or restore an older badge', async () => {
  const f = fixture();
  f.setState({ generation: 'generation-a', revision: 2, total: 0, retired: [] });
  await f.worker.push(payload());
  assert.equal(f.shown.length, 1);
  assert.equal(f.notifications[0]?.closed, false, 'without exact read proof cleanup waits for foreground reconciliation');
  assert.deepEqual(f.badges, []);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.messages, [{ moduleId: 'cockpit-notification', type: 'unread/sync',
    generation: 'generation-a', revision: 1 }]);
  await f.worker.message({ type: 'APPLY_STATE', state: empty() }, f.client.id);
  assert.equal(f.notifications[0]?.closed, true);
  assert.deepEqual(f.badges, [0]);
  assert.equal(f.calls.length, 0);
  await f.worker.push(payload('generation-a', 3));
  assert.equal(f.badges.at(-1), 3);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.messages.at(-1), { moduleId: 'cockpit-notification', type: 'unread/sync',
    generation: 'generation-a', revision: 3 });
});

test('push displays the server title and excerpt without appending application attribution', async () => {
  const f = fixture();
  const shown: { title: string; options: NotificationOptions | undefined }[] = [];
  f.environment.registration.showNotification = async (title, options) => { shown.push({ title, options }); };
  for (const kind of ['reply', 'ask'] as const) {
    const notification = { ...payload(), key: { ...payload().key, kind },
      title: `${kind === 'reply' ? '新回复' : '待回答'}：前端调优`,
      body: kind === 'reply' ? '已更新通知内容，点击可进入会话。' : '是否继续使用当前配置？' };
    await f.worker.push(notification);
    const rendered = shown.at(-1)!;
    assert.equal(rendered.title, notification.title);
    assert.equal(rendered.options?.body, notification.body);
    assert.deepEqual(rendered.options?.data, notification);
  }
  assert.equal(f.calls.length, 0);
});

test('HTTP acknowledgement identities cannot close a card newer than the accepted complete authority', async () => {
  const f = fixture();
  const card = { ...payload(), revision: 3, createdRevision: 3 };
  await f.environment.registration.showNotification('新回复', { data: card });
  await f.worker.message({ type: 'APPLY_STATE', state: empty('generation-a', 2),
    acknowledged: [card.key] }, f.client.id);
  assert.equal(f.notifications[0]?.closed, false);
  await f.worker.message({ type: 'APPLY_STATE', state: empty('generation-a', 3) }, f.client.id);
  assert.equal(f.notifications[0]?.closed, true);
  assert.deepEqual(f.calls, []);
});

test('unknown generation APPLY requires own fresh GET, not the incoming page snapshot', async () => {
  const f = fixture();
  f.fetch(async () => Response.json(empty('generation-c')));
  await f.worker.message({ type: 'APPLY_STATE', state: empty('generation-b') }, f.client.id);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]?.url, 'https://host.test/deployment/_modules');
  assert.equal(f.state()?.generation, 'generation-c');
});

test('new-generation push discovers the currently loaded digest while an older worker remains installed', async () => {
  const f = fixture();
  const digest = 'b'.repeat(64);
  f.setState({ generation: 'generation-a', revision: 20, total: 5, retired: [] });
  f.bootstrap(async () => Response.json(bootstrap(digest)));
  f.fetch(async () => Response.json({
    ...empty('generation-b'), total: 1,
    sessions: [{ sessionId: 'session-a', count: 1,
      items: [{ kind: 'reply', nativeId: 'reply-a', createdRevision: 1 }] }],
  }));
  await f.worker.push(payload('generation-b'));
  assert.deepEqual(f.calls.map(call => call.url), [
    'https://host.test/deployment/_modules',
    `https://host.test/deployment/_modules/cockpit-notification/${digest}/api/state`,
  ]);
  assert.deepEqual(f.calls[1]?.init.headers, { 'x-cockpit-module-digest': digest });
  assert.equal(f.calls.every(call => call.init.cache === 'no-store' &&
    call.init.credentials === 'same-origin' && call.init.redirect === 'error'), true);
  assert.deepEqual(f.badges, [1]);
  assert.equal(f.state()?.generation, 'generation-b');
  assert.equal(f.notifications[0]?.closed, false);
});

test('404 or digest mismatch triggers one bounded bootstrap resolution then uses the matching digest header', async () => {
  for (const status of [404, 409]) {
    const f = fixture();
    const digest = 'b'.repeat(64);
    f.bootstrap(async () => Response.json(bootstrap(digest)));
    f.fetch(async url => url.includes(`/${'a'.repeat(64)}/`) ?
      new Response(null, { status }) : Response.json(empty('generation-b')));
    await f.worker.sync();
    assert.deepEqual(f.calls.map(call => call.url), [
      `${configuration.apiBase}/state`, 'https://host.test/deployment/_modules',
      `https://host.test/deployment/_modules/cockpit-notification/${digest}/api/state`,
    ]);
    assert.deepEqual(f.calls.at(-1)?.init.headers, { 'x-cockpit-module-digest': digest });
    assert.equal(f.state()?.generation, 'generation-b');
  }
});

test('disabled module, failed bootstrap and unsafe discovery preserve state and do not fake unread zero', async () => {
  for (const response of [
    new Response(null, { status: 401 }),
    Response.json({ modules: [], active: [], errors: [] }),
    Response.json({ ...bootstrap(), modules: [{ ...bootstrap().modules[0], apiBase: 'https://outside.test/api' }] }),
    Response.json({ ...bootstrap(), modules: [], errors: [{ id: 'cockpit-notification', error: 'module failed' }] }),
  ]) {
    const f = fixture();
    f.setState({ generation: 'generation-a', revision: 20, total: 5, retired: [] });
    f.bootstrap(async () => response);
    await assert.rejects(f.worker.push(payload('generation-b')));
    assert.equal(f.notifications[0]?.closed, false);
    assert.deepEqual(f.badges, []);
    assert.equal(f.state()?.generation, 'generation-a');
    assert.equal(f.state()?.total, 5);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.url, 'https://host.test/deployment/_modules');
  }
});

test('another package race after bootstrap fails explicitly without discovery loops', async () => {
  const f = fixture();
  f.fetch(async () => new Response(null, { status: 404 }));
  await assert.rejects(f.worker.sync(), /404/);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(call => call.url.endsWith('/_modules')).length, 1);
  assert.deepEqual(f.badges, []);
});

test('pre-GET enumeration does not clear an unfamiliar notification which appeared during the GET', async () => {
  const f = fixture();
  await f.environment.registration.showNotification('旧提醒', { data: payload('generation-a') });
  f.fetch(async () => {
    await f.environment.registration.showNotification('新提醒', { data: payload('generation-c') });
    return Response.json(empty('generation-b'));
  });
  await f.worker.sync();
  assert.equal(f.notifications[0]?.closed, true);
  assert.equal(f.notifications[1]?.closed, false);
});

test('persisted versions reject old callbacks after worker recreation', async () => {
  const f = fixture();
  await f.worker.apply(empty('generation-a', 20), []);
  const restarted = new NotificationWorker(f.environment, configuration);
  await restarted.apply(empty('generation-a', 15), []);
  assert.deepEqual(f.badges, [0]);
  assert.equal(f.state()?.revision, 20);
});

test('serialized asynchronous badges cannot complete out of order, and failure does not poison the queue', async () => {
  const f = fixture();
  const completions: number[] = [];
  let release!: () => void;
  const firstBadge = new Promise<void>(resolve => { release = resolve; });
  f.environment.navigator.clearAppBadge = async () => { await firstBadge; completions.push(0); };
  f.environment.navigator.setAppBadge = async total => { completions.push(total); };
  const first = f.worker.serialized(() => f.worker.apply(empty(), []));
  const next: Snapshot = { generation: 'generation-a', revision: 3, complete: true, total: 1,
    sessions: [{ sessionId: 'session-a', count: 1, items: [{ kind: 'reply', nativeId: 'new', createdRevision: 3 }] }] };
  const second = f.worker.serialized(() => f.worker.apply(next, []));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(completions, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(completions, [0, 1]);
  await assert.rejects(f.worker.serialized(async () => { throw new Error('synthetic error'); }));
  assert.equal(await f.worker.serialized(async () => 'still works'), 'still works');
});

test('malformed payload and unsafe navigation show generic fallback, never navigate or set an invented badge', async () => {
  const f = fixture();
  for (const value of [null, { ...payload(), total: -1 }, { ...payload(), navigationTarget: 'https://outside.test/' }]) {
    await assert.rejects(f.worker.push(value));
  }
  assert.equal(f.shown.length, 3);
  assert.deepEqual(f.badges, []);
  assert.deepEqual(f.navigation, []);
  assert.equal(f.calls.length, 0);
});

test('notification click opens its target rather than navigating an uncontrolled chat, and never acknowledges', async () => {
  const f = fixture();
  await f.environment.registration.showNotification('新回复', { data: payload() });
  await f.environment.registration.showNotification('另一个提醒', { data: payload() });
  await f.worker.click(f.notifications[0]!);
  assert.equal(f.notifications[0]?.closed, true);
  assert.equal(f.notifications[1]?.closed, false);
  assert.deepEqual(f.navigation, ['https://host.test/deployment/session/session-a']);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.badges, []);
});

test('reply and ask notification clicks open their exact session when no app window exists', async () => {
  for (const kind of ['reply', 'ask'] as const) {
    const f = fixture();
    f.environment.clients.matchAll = async () => [];
    const notification = { ...payload(), key: { ...payload().key, kind, sessionId: 'session/a%value' },
      navigationTarget: 'session/session%2Fa%25value' };
    await f.environment.registration.showNotification('对应会话', { data: notification });
    await f.worker.click(f.notifications[0]!);
    assert.deepEqual(f.navigation, ['https://host.test/deployment/session/session%2Fa%25value']);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.badges, []);
  }
});

test('clicking a notification for the already open session only focuses the existing window', async () => {
  const f = fixture();
  f.client.url = 'https://host.test/deployment/session/session-a';
  await f.environment.registration.showNotification('新回复：对应会话', { data: payload() });
  await f.worker.click(f.notifications[0]!);
  assert.deepEqual(f.navigation, ['focus']);
  assert.deepEqual(f.calls, []);
});

test('a matching background session wins over a focused different session without redirecting either', async () => {
  const f = fixture();
  const target: WindowClient = { ...f.client, id: 'matching-client',
    url: 'https://host.test/deployment/session/session-a', focused: false,
    async focus() { f.navigation.push('focus-matching'); return target; } };
  f.environment.clients.matchAll = async () => [f.client, target];
  await f.environment.registration.showNotification('新回复', { data: payload() });
  await f.worker.click(f.notifications[0]!);
  assert.deepEqual(f.navigation, ['focus-matching']);
  assert.deepEqual(f.calls, []);
});

test('among already matching sessions prefer the focused one and do not focus an unrelated deployment', async () => {
  const f = fixture();
  f.client.url = 'https://host.test/deployment/session/session-a';
  const background: WindowClient = { ...f.client, id: 'background', focused: false,
    async focus() { throw new Error('Do not steal focus for a duplicate background window'); } };
  const outside: WindowClient = { ...background, id: 'outside', focused: true,
    url: 'https://host.test/different-app/session/session-a' };
  f.environment.clients.matchAll = async () => [outside, background, f.client];
  await f.environment.registration.showNotification('新回复', { data: payload() });
  await f.worker.click(f.notifications[0]!);
  assert.deepEqual(f.navigation, ['focus']);
});

test('click navigation failures remain explicit and never clear unread or retry opening blindly', async () => {
  for (const outcome of ['null', 'rejected'] as const) {
    const f = fixture();
    let opens = 0;
    f.environment.clients.openWindow = async () => {
      opens++;
      if (outcome === 'rejected') throw new Error('synthetic browser denied opening');
      return null;
    };
    await f.environment.registration.showNotification('新回复', { data: payload() });
    await assert.rejects(f.worker.click(f.notifications[0]!),
      outcome === 'null' ? /浏览器未能打开/ : /browser denied/);
    assert.equal(opens, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.badges, []);
  }
  const f = fixture();
  f.client.url = 'https://host.test/deployment/session/session-a';
  f.client.focus = async () => { throw new Error('synthetic focus rejected'); };
  await f.environment.registration.showNotification('新回复', { data: payload() });
  await assert.rejects(f.worker.click(f.notifications[0]!), /focus rejected/);
  assert.deepEqual(f.navigation, [], 'focus failure is not permission to open another window');
});

test('untrusted click targets never navigate or open a window', async () => {
  const f = fixture();
  for (const data of [
    { ...payload(), navigationTarget: 'https://outside.test/' },
    { ...payload(), navigationTarget: 'session/session-b' },
    { moduleId: 'another-module' },
  ]) {
    await f.environment.registration.showNotification('不受信任的目标', { data });
    await assert.rejects(f.worker.click(f.notifications.at(-1)!));
  }
  assert.deepEqual(f.navigation, []);
  assert.deepEqual(f.calls, []);
});

test('messages from unknown or out-of-base clients are rejected, and HTTP/login failures are explicit', async () => {
  const f = fixture();
  await assert.rejects(f.worker.message({ type: 'SYNC' }, 'unknown'), /来源/);
  f.client.url = 'https://host.test/different-app/';
  await assert.rejects(f.worker.message({ type: 'SYNC' }, f.client.id), /来源/);
  f.client.url = 'https://host.test/deployment/';
  f.fetch(async () => new Response(null, { status: 401 }));
  await assert.rejects(f.worker.message({ type: 'SYNC' }, f.client.id), /401/);
  assert.equal(f.state()?.revision, 0);
  await assert.rejects(f.worker.message({ type: 'UNKNOWN' }, f.client.id), /不支持/);
});

test('a badge API failure cannot reverse authoritative snapshot cleanup; unsupported API remains graceful', async () => {
  const f = fixture();
  await f.environment.registration.showNotification('新回复', { data: payload() });
  f.environment.navigator.clearAppBadge = async () => { throw new Error('synthetic platform denial'); };
  await assert.rejects(f.worker.apply(empty(), []), /系统角标/);
  assert.equal(f.notifications[0]?.closed, true);
  assert.equal(f.state()?.revision, 2);
  delete f.environment.navigator.clearAppBadge;
  delete f.environment.navigator.setAppBadge;
  assert.equal((await f.worker.apply(empty(), [])).badgeSupported, false);
});
