import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { checkedIntegrationHost } from './integration-host.mjs';
import { verifyPackage } from './verify-package.mjs';

const [hostDirectory, packageFile] = process.argv.slice(2);
if (!hostDirectory || !packageFile || process.argv.length !== 4) throw new Error('Usage: integration.mjs HOST_DIRECTORY ARCHIVE');
const hostSource = resolve(hostDirectory);
const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const pairing = await checkedIntegrationHost(moduleRoot, hostSource);
await verifyPackage(moduleRoot, resolve(packageFile));
const root = await mkdtemp(resolve('node_modules/.notification-integration-'));
const previous = {};
for (const [name, value] of Object.entries({
  HOME: root, COPILOT_HOME: join(root, 'copilot'), COCKPIT_HOME: join(root, 'host'), COCKPIT_NO_BOOT: '1',
})) {
  previous[name] = process.env[name]; process.env[name] = value;
}
const native = new Set(), controls = new Set(), changed = [];
const backendReports = [];
let app, host, frontend;
let now = Date.now();
const clock = mock.method(Date, 'now', () => now);
const restoreBrowser = [];
async function writable(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const entry of await readdir(path)) await writable(join(path, entry));
}
try {
  const { default: Fastify } = await import(pathToFileURL(join(hostSource, 'apps/server/node_modules/fastify/fastify.js')).href);
  const { ModuleHost } = await import(pathToFileURL(join(hostSource, 'apps/server/src/module-host.ts')).href);
  const { installLocalModule } = await import(pathToFileURL(join(hostSource, 'apps/server/src/module-install.ts')).href);
  await mkdir(process.env.COCKPIT_HOME, { recursive: true });
  const installed = await installLocalModule(resolve(packageFile), { hostRoot: process.env.COCKPIT_HOME, trustLocalCode: true, enable: true });
  host = new ModuleHost({ hostRoot: process.env.COCKPIT_HOME, observer: {
    onNativeEvent(handler) { native.add(handler); return () => native.delete(handler); },
    onEvent(handler) { controls.add(handler); return () => controls.delete(handler); },
  }, report: (id, error) => backendReports.push({ id, error }), onEvent: (moduleId, payload) => {
    changed.push({ moduleId, payload });
    frontend?.receiveEvent(moduleId, payload);
  } });
  app = Fastify();
  await host.register(app);
  const bootstrap = (await app.inject('/_modules')).json();
  assert.deepEqual(bootstrap.errors, []);
  const module = bootstrap.modules.find(item => item.id === 'cockpit-notification');
  assert.equal(module.digest, installed.digest);
  const worker = await app.inject(module.worker.entry);
  assert.equal(worker.statusCode, 200);
  assert.equal(worker.headers['service-worker-allowed'], './');
  // Activate the packaged browser entry through the real paired host registry.
  // This fixture intentionally has no PushManager/serviceWorker or real device.
  for (const [name, value] of Object.entries({
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    window: new EventTarget(), location: new URL('https://fixture.invalid/'),
    navigator: { onLine: true }, isSecureContext: true, Notification: undefined, PushManager: undefined,
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    restoreBrowser.push(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name));
  }
  const { ModuleRuntime } = await import(pathToFileURL(join(hostSource, 'apps/web/src/lib/moduleRuntime.ts')).href);
  const frontendReports = [];
  const fetchModule = async (url, init = {}) => {
    const resource = new URL(url);
    const response = await app.inject({ method: init.method ?? 'GET', url: resource.pathname + resource.search,
      headers: Object.fromEntries(new Headers(init.headers)), payload: init.body });
    return new Response(response.body, { status: response.statusCode,
      headers: { 'content-type': String(response.headers['content-type']) } });
  };
  const frontendOptions = {
    pageUrl: 'https://fixture.invalid/', fetch: fetchModule,
    style: () => () => {},
    load: async url => {
      const response = await fetchModule(url);
      assert.equal(response.status, 200);
      return import(`data:text/javascript;base64,${Buffer.from(await response.text()).toString('base64')}`);
    },
    report: error => frontendReports.push(error),
  };
  frontend = new ModuleRuntime(frontendOptions);
  await frontend.start();
  assert.deepEqual(frontendReports, []);
  assert.equal(frontend.getSnapshot().length, 1);
  assert.deepEqual(frontend.getSnapshot()[0].frontend.components.map(entry => entry.boundary), ['message', 'sessionStatus']);
  const menuSource = { isCurrent: () => true, subscribe: () => () => {} };
  const commands = frontend.menuItems({ menu: 'global' }, menuSource, () => true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].label, '开启通知（当前环境不支持）');
  assert.equal(commands[0].disabled, true);
  assert.deepEqual(frontend.menuItems({ menu: 'session', sessionId: 'synthetic-session' }, menuSource, () => true), []);
  const base = module.apiBase;
  const headers = { 'x-cockpit-module-digest': installed.digest };
  const first = (await app.inject(`${base}/state`)).json();
  assert.equal(first.total, 0);
  const sessionId = 'synthetic-session';
  const requestId = randomUUID();
  for (const listener of controls) await listener({ type: 'session/patch', sessionId,
    ask: { requestId, question: 'Synthetic request?', choices: ['yes'] } });
  const unread = (await app.inject(`${base}/state`)).json();
  assert.equal(unread.total, 1);
  assert.equal(unread.sessions[0].items[0].nativeId, requestId);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].moduleId, 'cockpit-notification');
  assert.deepEqual(changed[0].payload, {
    type: 'unread/delta', generation: first.generation, fromRevision: 0, revision: 1,
    added: [{ sessionId, kind: 'ask', nativeId: requestId, createdRevision: 1 }], removed: [],
  });
  const receipt = await app.inject({ method: 'POST', url: `${base}/read`, headers,
    payload: { generation: first.generation, keys: [{ sessionId, kind: 'ask', nativeId: requestId }] } });
  assert.equal(receipt.statusCode, 200);
  assert.deepEqual(receipt.json(), {
    generation: first.generation, revision: 2, acknowledged: [{ sessionId, kind: 'ask', nativeId: requestId }],
  });
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[1].payload, {
    type: 'unread/delta', generation: first.generation, fromRevision: 1, revision: 2, added: [],
    removed: [{ sessionId, kind: 'ask', nativeId: requestId }],
  });
  const again = await app.inject({ method: 'POST', url: `${base}/read`, headers,
    payload: { generation: first.generation, keys: [{ sessionId, kind: 'ask', nativeId: requestId }] } });
  assert.deepEqual(again.json(), receipt.json());
  assert.equal(changed.length, 2);
  const stale = await app.inject({ method: 'POST', url: `${base}/read`, headers,
    payload: { generation: 'obsolete-generation', keys: [{ sessionId, kind: 'ask', nativeId: requestId }] } });
  assert.equal(stale.statusCode, 409);
  for (const listener of controls) await listener({ type: 'session/patch', sessionId, ask: null });
  assert.equal((await app.inject(`${base}/state`)).json().total, 0);
  const messageId = randomUUID();
  const { foldEvent, newFoldState } = await import(pathToFileURL(join(hostSource, 'packages/protocol/src/chat.ts')).href);
  const projection = newFoldState();
  const emit = async (type, data, ephemeral = false) => {
    const event = {
      id: randomUUID(), type, data, ...(ephemeral ? { ephemeral: true } : {}),
    };
    foldEvent(projection, event);
    for (const listener of native) await listener({ sessionId, cwd: null, event });
  };
  await emit('assistant.turn_start', { turnId: '3' });
  await emit('assistant.message_start', { messageId }, true);
  now += 15 * 60_000 + 1;
  await emit('assistant.message_delta', { messageId, deltaContent: 'Synthetic final' }, true);
  await emit('assistant.message', { messageId, turnId: '3', phase: 'final_answer',
    content: 'Synthetic final', toolRequests: [], apiCallId: 'A'.repeat(488) });
  assert.equal((await app.inject(`${base}/state`)).json().total, 1, 'final is admitted before turn_end/idle');
  await emit('assistant.turn_end', { turnId: '3' });
  await emit('assistant.idle', {}, true);
  assert.equal((await app.inject(`${base}/state`)).json().total, 1);
  assert.deepEqual(changed.at(-1).payload.added, [{ sessionId, kind: 'reply', nativeId: messageId, createdRevision: 3 }]);
  assert.equal(projection.messages.find(message => message.id === messageId).content, 'Synthetic final');
  assert.ok(projection.completed.has(messageId), 'the unread key still names the completed native projection');
  await emit('assistant.turn_start', { turnId: 'ordinary' });
  for (let index = 0; index < 1000; index++) {
    const messageId = `ordinary-${index}`;
    await emit('assistant.message_start', { messageId }, true);
    await emit('assistant.message', { messageId, content: `Ordinary ${index}`, turnId: 'ordinary',
      toolRequests: [{ toolCallId: `tool-${index}`, name: 'view', arguments: {} }] });
  }
  await emit('assistant.turn_end', { turnId: 'ordinary' });
  await emit('assistant.idle', {}, true);
  assert.equal((await app.inject(`${base}/state`)).json().total, 1);
  await emit('assistant.turn_start', { turnId: 'explicit' });
  // Providers without phase (for example Claude) and with phase use the same tool-free rule.
  for (const [messageId, phase] of [['first-final', undefined], ['second-final', 'final_answer']]) {
    await emit('assistant.message_start', { messageId }, true);
    await emit('assistant.message', { messageId, content: messageId, turnId: 'explicit', ...(phase ? { phase } : {}) });
  }
  assert.equal((await app.inject(`${base}/state`)).json().total, 3);
  await emit('assistant.turn_end', { turnId: 'explicit' });
  await emit('assistant.idle', {}, true);
  assert.equal((await app.inject(`${base}/state`)).json().total, 3);
  assert.deepEqual(changed.slice(-2).flatMap(event => event.payload.added.map(item => item.nativeId)),
    ['first-final', 'second-final']);
  now += 24 * 60 * 60_000;
  await emit('assistant.turn_end', { turnId: '3' });
  await emit('assistant.idle', {}, true);
  await emit('abort', {});
  const beforeReopen = (await app.inject(`${base}/state`)).json();
  const reopen = async () => {
    frontend.stop();
    frontend = new ModuleRuntime(frontendOptions);
    await frontend.start();
    assert.equal(frontend.getSnapshot().length, 1);
  };
  for (let index = 0; index < 2; index++) {
    await reopen();
    assert.deepEqual((await app.inject('/_modules')).json().errors, []);
    assert.deepEqual((await app.inject(`${base}/state`)).json(), beforeReopen);
    assert.deepEqual(frontendReports, []);
  }
  assert.deepEqual(backendReports, []);

  // A genuine invalid identity is still reported. The pinned host retains it even
  // after subsequent successful turns; reopening is not a new backend failure.
  await emit('assistant.turn_start', { turnId: 'overflow' });
  for (let index = 0; index < 129; index++) await emit('assistant.message_start', { messageId: `overflow-${index}` }, true);
  assert.equal(backendReports.length, 0, 'stream events have no notification evidence quota');
  await emit('assistant.message', { messageId: 'bad id', content: 'Invalid final identity', phase: 'final_answer' });
  assert.equal(backendReports.length, 1);
  assert.equal(backendReports[0].error.code, 'INVALID_REPLY_IDENTITY');
  await emit('assistant.turn_end', { turnId: 'overflow' });
  await emit('assistant.idle', {}, true);
  assert.deepEqual((await app.inject(`${base}/state`)).json(), beforeReopen);
  await emit('assistant.turn_start', { turnId: 'recovered' });
  await emit('assistant.message_start', { messageId: 'recovered' }, true);
  await emit('assistant.message', { messageId: 'recovered', phase: 'final_answer', content: 'Recovered reply' });
  await emit('assistant.turn_end', { turnId: 'recovered' });
  await emit('assistant.idle', {}, true);
  const recovered = (await app.inject(`${base}/state`)).json();
  assert.equal(recovered.total, beforeReopen.total + 1);
  for (let index = 0; index < 2; index++) {
    await reopen();
    assert.equal(frontendReports.length, index + 1);
    assert.match(String(frontendReports.at(-1)), /cockpit-notification: Final reply has an invalid/);
    assert.deepEqual((await app.inject(`${base}/state`)).json(), recovered);
    assert.equal((await app.inject('/_modules')).json().errors[0].code, 'INVALID_REPLY_IDENTITY');
    assert.equal(backendReports.length, 1);
  }
  frontend.stop();
  assert.deepEqual(frontend.menuItems({ menu: 'global' }, menuSource, () => true), []);
  host.close();
  assert.equal(native.size, 0); assert.equal(controls.size, 0);
  console.log(JSON.stringify({ module: module.id, version: module.version, sourceBound: true, pairing,
    controlAskAndRead: true, compactReadReceipt: true, atomicModuleDeltas: true, opaqueProviderId: true,
    longTurnWithoutExpiry: true, nativeProjectionIdentity: true, pageReopenWithoutNewFailure: true,
    immediateToolFreeRepliesOnly: true, separateRepliesWithOrWithoutPhase: true,
    realErrorRetainedByPinnedHost: true,
    narrowWorker: true, packagedFrontendMenuRegistry: true, noNativeRuntimeOrPushService: true }));
} finally {
  frontend?.stop();
  host?.close();
  if (app) await app.close();
  await writable(root);
  await rm(root, { recursive: true });
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const restore of restoreBrowser.reverse()) restore();
  clock.mock.restore();
}
