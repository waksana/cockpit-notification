import { workerConfiguration } from './device.ts';
import type { VisibleNotification } from './device.ts';
import { NotificationWorker } from './runtime.ts';
import type { WorkerEnvironment } from './runtime.ts';
import { DeviceStorage } from './storage.ts';

interface LifetimeEvent { waitUntil(promise: Promise<unknown>): void }
interface WorkerScope extends Omit<WorkerEnvironment, 'storage'> {
  __cockpitModuleWorker: unknown;
  location: { href: string };
  indexedDB: IDBFactory;
  addEventListener(type: 'message', listener: (event: LifetimeEvent & {
    data: unknown; source: { id?: string } | null; ports: MessagePort[];
  }) => void): void;
  addEventListener(type: 'push', listener: (event: LifetimeEvent & { data: { text(): string } | null }) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: LifetimeEvent & { notification: VisibleNotification }) => void): void;
}
const scope = globalThis as unknown as WorkerScope;
const configuration = workerConfiguration(scope.__cockpitModuleWorker, scope.location.href);
const worker = new NotificationWorker({
  registration: scope.registration, clients: scope.clients, navigator: scope.navigator,
  storage: new DeviceStorage(scope.indexedDB, configuration.appBase), fetch: scope.fetch.bind(scope),
}, configuration);

scope.addEventListener('message', event => {
  const port = event.ports[0];
  if (!port) return;
  event.waitUntil(worker.serialized(async () => {
    try {
      const result = await worker.message(event.data, event.source?.id ?? '');
      port.postMessage({ ok: true, ...result });
    } catch (error) {
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally { port.close(); }
  }));
});
scope.addEventListener('push', event => {
  event.waitUntil(worker.serialized(async () => {
    let value: unknown;
    try { value = JSON.parse(event.data?.text() ?? 'null'); }
    catch { value = null; }
    try { await worker.push(value); }
    catch (error) { await worker.broadcast('ERROR', error); throw error; }
  }));
});
scope.addEventListener('notificationclick', event => {
  event.waitUntil(worker.serialized(async () => {
    try { await worker.click(event.notification); }
    catch (error) { await worker.broadcast('ERROR', error); throw error; }
  }));
});
// No fetch interception, automatic permission request, skipWaiting, or notificationclose mutation.
