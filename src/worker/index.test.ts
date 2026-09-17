import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = (await build({ entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2023' })).outputFiles[0]!.text;
interface Event {
  data?: unknown;
  source?: unknown;
  ports?: unknown[];
  waitUntil(promise: Promise<unknown>): void;
}
function fixture() {
  const listeners = new Map<string, (event: Event) => void>();
  const shown: unknown[] = [];
  const broadcasts: unknown[] = [];
  const calls: string[] = [];
  const scope = {
    __cockpitModuleWorker: { moduleId: 'cockpit-notification', digest: 'a'.repeat(64),
      apiBase: `../../cockpit-notification/${'a'.repeat(64)}/api` },
    location: { href: 'https://host.test/deployment/_modules/workers/cockpit-notification/worker.js' },
    navigator: {}, indexedDB: {},
    clients: {
      async get(id: string) { return id === 'client-a' ? { id, url: 'https://host.test/deployment/' } : undefined; },
      async matchAll() { return [{ url: 'https://host.test/deployment/', postMessage: (value: unknown) => broadcasts.push(value) }]; },
    },
    registration: { async showNotification(title: string, options: unknown) { shown.push({ title, options }); } },
    async fetch() { calls.push('fetch'); throw new Error('Unexpected network request'); },
    addEventListener(type: string, handler: (event: Event) => void) { listeners.set(type, handler); },
    skipWaiting() { throw new Error('Unexpected lifecycle takeover'); },
    URL, AbortSignal,
  };
  runInNewContext(compiled, scope);
  return { listeners, shown, broadcasts, calls };
}

test('classic standalone worker registers only explicit events, with no fetch cache or forced activation', () => {
  const f = fixture();
  assert.deepEqual([...f.listeners.keys()].sort(), ['message', 'notificationclick', 'push']);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.shown, []);
  assert.doesNotMatch(compiled, /^\s*(?:import|export)\s/m);
});

test('worker MessagePort gets explicit source/operation failures and is always closed', async () => {
  const f = fixture();
  for (const id of ['unknown', 'client-a']) {
    const replies: { ok: boolean; error: string }[] = [];
    let closed = false;
    let completion!: Promise<unknown>;
    f.listeners.get('message')!({
      source: { id }, data: { type: 'UNKNOWN' },
      ports: [{ postMessage: (value: { ok: boolean; error: string }) => replies.push(value), close() { closed = true; } }],
      waitUntil(promise) { completion = promise; },
    });
    await completion;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.ok, false);
    assert.match(replies[0]!.error, id === 'unknown' ? /来源/ : /不支持/);
    assert.equal(closed, true);
  }
});

test('invalid push JSON still shows a generic visible fallback and reports an explicit failure', async () => {
  const f = fixture();
  let completion!: Promise<unknown>;
  f.listeners.get('push')!({
    data: { text: () => '{invalid synthetic payload' },
    waitUntil(promise) { completion = promise; },
  });
  await assert.rejects(completion, /Invalid push payload/);
  assert.equal(f.shown.length, 1);
  assert.equal(f.broadcasts.length, 1);
  assert.deepEqual(f.calls, []);
});
