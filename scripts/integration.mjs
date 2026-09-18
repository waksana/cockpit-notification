import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const [hostDirectory, packageFile] = process.argv.slice(2);
if (!hostDirectory || !packageFile || process.argv.length !== 4) throw new Error('Usage: integration.mjs HOST_DIRECTORY ARCHIVE');
const hostSource = resolve(hostDirectory);
const root = await mkdtemp(resolve('node_modules/.notification-integration-'));
const previous = {};
for (const [name, value] of Object.entries({ HOME: root, COCKPIT_HOME: join(root, 'host'), COCKPIT_NO_BOOT: '1' })) {
  previous[name] = process.env[name]; process.env[name] = value;
}
const native = new Set(), controls = new Set(), changed = [];
let app, host;
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
  }, onInvalidate: id => changed.push(id) });
  app = Fastify();
  await host.register(app);
  const bootstrap = (await app.inject('/_modules')).json();
  assert.deepEqual(bootstrap.errors, []);
  const module = bootstrap.modules.find(item => item.id === 'cockpit-notification');
  assert.equal(module.digest, installed.digest);
  const worker = await app.inject(module.worker.entry);
  assert.equal(worker.statusCode, 200);
  assert.equal(worker.headers['service-worker-allowed'], './');
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
  const receipt = await app.inject({ method: 'POST', url: `${base}/read`, headers,
    payload: { generation: first.generation, keys: [{ sessionId, kind: 'ask', nativeId: requestId }] } });
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.json().state.total, 0);
  const again = await app.inject({ method: 'POST', url: `${base}/read`, headers,
    payload: { generation: first.generation, keys: [{ sessionId, kind: 'ask', nativeId: requestId }] } });
  assert.deepEqual(again.json(), receipt.json());
  const stale = await app.inject({ method: 'POST', url: `${base}/read`, headers,
    payload: { generation: 'obsolete-generation', keys: [{ sessionId, kind: 'ask', nativeId: requestId }] } });
  assert.equal(stale.statusCode, 409);
  for (const listener of controls) await listener({ type: 'session/patch', sessionId, ask: null });
  assert.equal((await app.inject(`${base}/state`)).json().total, 0);
  host.close();
  assert.equal(native.size, 0); assert.equal(controls.size, 0);
  console.log(JSON.stringify({ module: module.id, version: module.version, sourceBound: true,
    controlAskAndRead: true, narrowWorker: true, noNativeRuntimeOrPushService: true }));
} finally {
  host?.close();
  if (app) await app.close();
  await writable(root);
  await rm(root, { recursive: true });
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
