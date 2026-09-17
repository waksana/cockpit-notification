import type { ModuleFrontendContext } from '@cockpit/module-api';
import { identity, parseSnapshot, record } from '../shared/protocol.ts';
import type { MessageKey, Snapshot } from '../shared/protocol.ts';
import { responseJson } from './store.ts';

export interface DeviceStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  installed: boolean;
  subscribed: boolean;
  registered: boolean;
  needsResubscribe: boolean;
  updatePending: boolean;
  busy: boolean;
  badgeSupported: boolean | null;
  error: string | null;
}
export function vapidBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('推送公钥无效');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), char => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('推送公钥无效');
  return bytes;
}
export function sameKey(subscription: PushSubscription, expected: Uint8Array): boolean {
  const actual = subscription.options.applicationServerKey;
  if (!actual) return false;
  const bytes = new Uint8Array(actual);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}
export async function subscriptionId(subscription: Pick<PushSubscription, 'endpoint'>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(subscription.endpoint).href));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export class DeviceBridge {
  private context: ModuleFrontendContext;
  private status: DeviceStatus;
  private listeners = new Set<() => void>();
  private registration: ServiceWorkerRegistration | null = null;
  private stopped = false;
  private pending = new Set<(reason: Error) => void>();
  private entry: string | null = null;
  private scope: string | null = null;
  private latest: Snapshot | null = null;
  private initializing = true;
  private busy = false;
  private controller = new AbortController();
  private updateFlight: Promise<void> | null = null;
  private registrationCleanup: (() => void)[] = [];
  private inspectRegistration: (() => void) | null = null;
  private subscriptionReference: { endpoint: string; id: string } | null = null;
  constructor(context: ModuleFrontendContext) {
    this.context = context;
    let error: string | null = null;
    try {
      if (!context.worker) throw new Error('宿主没有提供通知 worker');
      const api = new URL(context.apiBase, location.href);
      const entry = new URL(context.worker.entry, location.href);
      const scope = new URL(context.worker.scope, location.href);
      const base = new URL('../../../', entry);
      if (entry.origin !== location.origin || entry.href !== new URL('_modules/workers/cockpit-notification/worker.js', base).href ||
          scope.href !== new URL('./', entry).href || api.origin !== entry.origin ||
          !new RegExp(`^${base.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_modules/cockpit-notification/[a-f0-9]{64}/api$`).test(api.pathname) ||
          api.search || api.hash) throw new Error('宿主通知 worker 路径无效');
      this.entry = entry.href;
      this.scope = scope.href;
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
      typeof Notification !== 'undefined' && typeof PushManager !== 'undefined' &&
      globalThis.isSecureContext === true && this.entry !== null;
    this.status = { supported, permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      installed: false, subscribed: false, registered: false, needsResubscribe: false, updatePending: false,
      busy: false, badgeSupported: null, error };
  }
  getSnapshot = (): DeviceStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<DeviceStatus>) {
    if (this.stopped) return;
    this.status = { ...this.status, ...update };
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown) {
    if (this.stopped) return;
    this.context.report(error);
    this.publish({ error: error instanceof Error ? error.message : String(error) });
  }
  private async findRegistration() {
    if (!this.scope || !this.entry) return null;
    const registration = await navigator.serviceWorker.getRegistration(this.scope);
    if (!registration || registration.scope !== this.scope) return null;
    const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean) as ServiceWorker[];
    if (workers.some(worker => worker.scriptURL !== this.entry)) throw new Error('通知 worker 作用域已被其他 worker 使用；未替换或注销它');
    return registration;
  }
  private bindRegistration(registration: ServiceWorkerRegistration | null) {
    if (this.stopped || this.registration === registration) return;
    this.registrationCleanup.splice(0).forEach(cleanup => cleanup());
    this.registration = registration;
    this.inspectRegistration = null;
    if (!registration) { this.publish({ updatePending: false }); return; }
    const watched = new Set<ServiceWorker>();
    const inspect = () => {
      if (this.stopped || this.registration !== registration) return;
      this.publish({ updatePending: [registration.installing, registration.waiting]
        .some(worker => worker && worker.state !== 'activated' && worker.state !== 'redundant') });
      for (const worker of [registration.active, registration.installing, registration.waiting]) {
        if (!worker || watched.has(worker)) continue;
        watched.add(worker);
        const changed = () => {
          inspect();
          if (worker.state === 'activated' && registration.active === worker) {
            void this.resumeState().catch(error => this.fail(error));
          }
        };
        worker.addEventListener('statechange', changed);
        this.registrationCleanup.push(() => worker.removeEventListener('statechange', changed));
      }
    };
    registration.addEventListener('updatefound', inspect);
    this.registrationCleanup.push(() => registration.removeEventListener('updatefound', inspect));
    this.inspectRegistration = inspect;
    inspect();
  }
  private async updateRegistration() {
    if (!this.registration || this.stopped) return;
    if (this.updateFlight) return this.updateFlight;
    const registration = this.registration;
    const flight = (async () => {
      await registration.update();
      this.ensureActive();
      this.inspectRegistration?.();
    })();
    this.updateFlight = flight;
    try { await flight; } finally { if (this.updateFlight === flight) this.updateFlight = null; }
  }
  private async resumeState() {
    if (!this.latest || this.initializing || this.stopped) return;
    await this.send({ type: 'APPLY_STATE', state: this.latest, acknowledged: [] });
    this.publish({ error: null });
  }
  async refreshWorker() {
    if (!this.registration || this.stopped) return;
    try { await this.updateRegistration(); await this.resumeState(); }
    catch (error) { this.fail(error); }
  }
  private async checkSubscription(registration: ServiceWorkerRegistration) {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) { this.publish({ subscribed: false, registered: false, needsResubscribe: false }); return; }
    this.publish({ subscribed: true, needsResubscribe: !sameKey(subscription, vapidBytes(this.context.config.vapidPublicKey)) });
    const id = await this.knownSubscriptionId(subscription);
    const result = await responseJson(await this.context.request(`/subscriptions/${encodeURIComponent(id)}`, {
      cache: 'no-store', signal: this.context.signal,
    }));
    if (!record(result) || typeof result.registered !== 'boolean') throw new Error('设备订阅检查响应无效');
    this.publish({ subscribed: true, registered: result.registered,
      needsResubscribe: !sameKey(subscription, vapidBytes(this.context.config.vapidPublicKey)) });
  }
  private async knownSubscriptionId(subscription: PushSubscription) {
    const endpoint = new URL(subscription.endpoint).href;
    if (this.subscriptionReference?.endpoint === endpoint) return this.subscriptionReference.id;
    // Startup lookup must not POST: that could undo a previously successful server-side disable.
    return subscriptionId(subscription);
  }
  async bootstrap() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !this.entry || this.stopped) {
      this.initializing = false; return;
    }
    try {
      const registration = await this.findRegistration();
      if (this.stopped) return;
      this.bindRegistration(registration);
      this.publish({ installed: Boolean(registration),
        permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission });
      if (registration) {
        try { await this.updateRegistration(); } catch (error) { this.fail(error); }
        try { await this.send({ type: 'SYNC' }); } catch (error) { this.fail(error); }
        await this.checkSubscription(registration);
      }
    } catch (error) { this.fail(error); }
    finally {
      this.initializing = false;
      if (this.latest) this.apply(this.latest, []);
    }
  }
  apply(state: Snapshot, acknowledged: MessageKey[]) {
    this.latest = state;
    if (!this.registration || this.initializing || this.stopped) return;
    void this.send({ type: 'APPLY_STATE', state, acknowledged }).catch(error => this.fail(error));
  }
  async sync() {
    if (!this.registration || this.stopped) return;
    try { await this.updateRegistration(); await this.send({ type: 'SYNC' }); this.publish({ error: null }); }
    catch (error) { this.fail(error); }
  }
  handleMessage(event: MessageEvent) {
    if (event.source !== this.registration?.active || !record(event.data) ||
        event.data.moduleId !== 'cockpit-notification') return false;
    if (event.data.type === 'ERROR') this.fail(new Error(String(event.data.error ?? '通知 worker 失败')));
    return event.data.type === 'INVALIDATE';
  }
  private active(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
    if (registration.active?.state === 'activated') return Promise.resolve(registration.active);
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker) return Promise.reject(new Error('通知 worker 尚不可用'));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        worker.removeEventListener('statechange', check);
        this.controller.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(worker);
      };
      const abort = () => finish(new Error('通知模块已停止'));
      const check = () => {
        if (worker.state === 'activated') finish();
        else if (worker.state === 'redundant') finish(new Error('通知 worker 安装失败'));
      };
      const timer = setTimeout(() => finish(new Error('通知 worker 更新尚未激活，请关闭旧窗口后重试')), 15_000);
      worker.addEventListener('statechange', check);
      this.controller.signal.addEventListener('abort', abort, { once: true });
      if (this.controller.signal.aborted) { abort(); return; }
      check();
    });
  }
  private async send(message: unknown) {
    if (!this.registration || this.stopped) throw new Error('通知 worker 未安装');
    const worker = await this.active(this.registration);
    if (this.stopped) throw new Error('通知模块已停止');
    if (worker.scriptURL !== this.entry) throw new Error('通知 worker 已被其他程序替换；未发送状态');
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        clearTimeout(timer);
        this.pending.delete(cancel);
        channel.port1.close();
        if (error) reject(error); else resolve(value!);
      };
      const cancel = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error('通知 worker 响应超时；系统状态尚未确认')), 20_000);
      this.pending.add(cancel);
      channel.port1.onmessage = event => {
        if (!record(event.data) || event.data.ok !== true) {
          finish(new Error(record(event.data) ? String(event.data.error ?? '通知 worker 操作失败') : '通知 worker 回执无效'));
        } else finish(undefined, event.data);
      };
      channel.port1.onmessageerror = () => finish(new Error('通知 worker 回执无法解析'));
      try { worker.postMessage(message, [channel.port2]); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    this.publish({ badgeSupported: result.badgeSupported === true });
    return result;
  }
  async enable() {
    if (this.busy || this.stopped || !this.status.supported) return;
    this.busy = true;
    this.publish({ busy: true, error: null });
    try {
      // Permission is requested synchronously within this explicit button gesture.
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      this.ensureActive();
      this.publish({ permission });
      if (permission !== 'granted') throw new Error('系统通知权限未允许；请在浏览器或系统设置中修改');
      const key = vapidBytes(this.context.config.vapidPublicKey);
      let registration = await this.findRegistration();
      this.ensureActive();
      if (!registration) {
        registration = await navigator.serviceWorker.register(this.entry!, {
          scope: this.scope!, type: 'classic', updateViaCache: 'none',
        });
        this.ensureActive();
        this.bindRegistration(registration);
      } else {
        this.bindRegistration(registration);
        await this.updateRegistration();
      }
      this.ensureActive();
      this.publish({ installed: true });
      await this.active(registration);
      this.ensureActive();
      let subscription = await registration.pushManager.getSubscription();
      this.ensureActive();
      if (subscription && !sameKey(subscription, key)) {
        await this.remove(subscription);
        this.ensureActive();
        subscription = null;
      }
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      this.ensureActive();
      this.publish({ subscribed: true });
      const body = await responseJson(await this.context.request('/subscriptions', {
        method: 'POST', cache: 'no-store', signal: this.context.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription.toJSON() }),
      }));
      if (!record(body) || !identity(body.id)) {
        throw new Error('设备注册回执身份无效');
      }
      const state = parseSnapshot(body.state);
      if (body.generation !== state.generation) throw new Error('设备注册回执运行代无效');
      this.subscriptionReference = { endpoint: new URL(subscription.endpoint).href, id: body.id };
      this.publish({ registered: true, needsResubscribe: false });
      await this.send({ type: 'APPLY_STATE', state });
    } catch (error) { this.fail(error); }
    finally { this.busy = false; this.publish({ busy: false }); }
  }
  private async remove(subscription: PushSubscription) {
    const id = await this.knownSubscriptionId(subscription);
    this.ensureActive();
    const response = await this.context.request(`/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE', cache: 'no-store', signal: this.context.signal,
    });
    if (response.status !== 204) {
      await responseJson(response);
      throw new Error(`设备注销返回了意外状态（HTTP ${response.status}）`);
    }
    this.publish({ registered: false });
    this.ensureActive();
    if (!await subscription.unsubscribe()) throw new Error('服务端已停用，但浏览器未确认取消设备订阅，请重试');
    this.subscriptionReference = null;
    this.publish({ subscribed: false, needsResubscribe: false });
  }
  async disable() {
    if (this.busy || this.stopped || !this.registration) return;
    this.busy = true;
    this.publish({ busy: true, error: null });
    try {
      const subscription = await this.registration.pushManager.getSubscription();
      this.ensureActive();
      if (subscription) await this.remove(subscription);
      else this.publish({ subscribed: false, registered: false });
    } catch (error) { this.fail(error); }
    finally { this.busy = false; this.publish({ busy: false }); }
  }
  dispose() {
    this.stopped = true;
    this.controller.abort();
    this.registrationCleanup.splice(0).forEach(cleanup => cleanup());
    this.inspectRegistration = null;
    for (const cancel of [...this.pending]) cancel(new Error('通知模块已停止'));
    this.listeners.clear();
  }
  private ensureActive() {
    if (this.stopped || this.context.signal.aborted) throw new Error('通知模块已停止');
  }
}
