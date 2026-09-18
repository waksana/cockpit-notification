import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceStorage } from './storage.ts';
import type { DeviceState } from './device.ts';

function factory() {
  const databases = new Map<string, Map<string, unknown>>();
  const names: string[] = [];
  let closes = 0;
  let blocked = false;
  let abort = false;
  const result = {
    open(name: string) {
      names.push(name);
      const upgrade = !databases.has(name);
      if (upgrade) databases.set(name, new Map());
      const values = databases.get(name)!;
      const database = {
        createObjectStore() {},
        close() { closes++; },
        transaction() {
          const transaction = {
            error: new Error('synthetic transaction abort'),
            oncomplete: undefined as (() => void) | undefined,
            onabort: undefined as (() => void) | undefined,
            onerror: undefined as (() => void) | undefined,
            objectStore() {
              return {
                get(key: string) {
                  const request = { result: structuredClone(values.get(key)) };
                  queueMicrotask(() => { if (abort) transaction.onabort?.(); else transaction.oncomplete?.(); });
                  return request;
                },
                put(value: unknown, key: string) {
                  queueMicrotask(() => {
                    if (abort) transaction.onabort?.();
                    else { values.set(key, structuredClone(value)); transaction.oncomplete?.(); }
                  });
                },
              };
            },
          };
          return transaction;
        },
      };
      const request = {
        result: database, error: null,
        onsuccess: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        onblocked: undefined as (() => void) | undefined,
        onupgradeneeded: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => {
        if (blocked) request.onblocked?.();
        if (upgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory: result as unknown as IDBFactory, names, databases, closes: () => closes,
    block: () => { blocked = true; }, abort: () => { abort = true; } };
}
const version: DeviceState = { generation: 'generation-a', revision: 19, total: 3, retired: ['old-generation'] };

test('IndexedDB persists only the version projection across storage instances and isolates deployment bases', async () => {
  const f = factory();
  const first = new DeviceStorage(f.factory, 'https://host.test/app-a/');
  assert.equal(await first.load(), null);
  await first.save(version);
  const restarted = new DeviceStorage(f.factory, 'https://host.test/app-a/');
  assert.deepEqual(await restarted.load(), version);
  assert.equal(await new DeviceStorage(f.factory, 'https://host.test/app-b/').load(), null);
  assert.notEqual(f.names[0], f.names.at(-1));
  assert.equal(f.closes(), 4);
  assert.deepEqual(Object.keys([...f.databases.values()][0]!.get('current') as object).sort(),
    ['generation', 'retired', 'revision', 'total']);
});

test('failed or blocked IndexedDB operations return errors and close every acquired database', async () => {
  const blocked = factory();
  blocked.block();
  await assert.rejects(new DeviceStorage(blocked.factory, '/base/').load(), /阻塞/);
  assert.equal(blocked.closes(), 1);
  const aborted = factory();
  aborted.abort();
  await assert.rejects(new DeviceStorage(aborted.factory, '/base/').save(version), /transaction abort/);
  assert.equal(aborted.closes(), 1);
  assert.equal([...aborted.databases.values()][0]!.get('current'), undefined);
});
