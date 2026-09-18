import { randomUUID, createECDH } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { ModuleBackend, ModuleBackendContext, ModuleResponse, NativeObservation,
  ServerEvent } from '@cockpit/module-api';
import type { PushSubscription } from 'web-push';
import { activate } from './index.ts';
import type { Clock, Sender } from './push.ts';
import { parseSnapshot, parseUnreadEvent, type Snapshot, type UnreadEvent } from '../shared/protocol.ts';

export { key, message, observation, turn } from './native-fixtures.ts';

export class FakeClock implements Clock {
  time = 1_000;
  #id = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delay: number): number {
    const id = ++this.#id;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  async advance(delay: number): Promise<void> {
    this.time += delay;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
    }
    await flush();
  }
}
export async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
export function directory(t: TestContext): string {
  const path = resolve('node_modules', `.notification-synthetic-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
export function subscription(name = 'device'): PushSubscription {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-${name}`,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
}
export function ask(requestId: string | null, sessionId = 'session-a'): ServerEvent {
  return { type: 'session/patch', sessionId,
    ask: requestId === null ? null : { requestId, question: 'synthetic-secret-question' } };
}
export async function invoke(backend: ModuleBackend, method: string, path: string, body?: unknown,
  params: Record<string, string> = {}): Promise<ModuleResponse> {
  const route = backend.routes.find(route => route.method === method && route.path === path);
  if (!route) throw new Error('Synthetic route not found');
  return route.handler({ body, params, headers: {}, query: {}, signal: new AbortController().signal });
}
export function fixture(t: TestContext, sender?: Sender, config: Record<string, unknown> = {}) {
  const dataRoot = directory(t);
  const clock = new FakeClock();
  const controller = new AbortController();
  const errors: unknown[] = [];
  const invalidations: Snapshot[] = [];
  const publications: UnreadEvent[] = [];
  const publicationStates: Snapshot[] = [];
  let backend: ModuleBackend;
  const context: ModuleBackendContext = {
    apiVersion: 1, moduleId: 'cockpit-notification', dataRoot, apiBase: '/module-api/cockpit-notification',
    config, signal: controller.signal, report(error) { errors.push(error); },
    invalidate() {
      const route = backend.routes.find(route => route.path === '/state')!;
      const result = route.handler({ body: undefined, params: {}, headers: {}, query: {},
        signal: new AbortController().signal }) as ModuleResponse;
      invalidations.push(parseSnapshot(result.body));
    },
    publish(payload) {
      publications.push(parseUnreadEvent(payload));
      const route = backend.routes.find(route => route.path === '/state')!;
      const result = route.handler({ body: undefined, params: {}, headers: {}, query: {},
        signal: new AbortController().signal }) as ModuleResponse;
      publicationStates.push(parseSnapshot(result.body));
    },
  };
  backend = activate(context, { clock, sender: sender ?? (async () => { throw new Error('Unexpected synthetic send'); }) });
  t.after(() => backend.dispose?.());
  return { backend, context, clock, controller, errors, invalidations, publications, publicationStates, dataRoot,
    state: async () => parseSnapshot((await invoke(backend, 'GET', '/state')).body),
    emit: async (events: NativeObservation[]) => { for (const event of events) await backend.events!.handle(event); },
    control: async (event: ServerEvent) => backend.controlEvents!.handle(event),
  };
}
