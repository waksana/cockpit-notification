import { parseKey, parsePayload, parseSnapshot, record, MAX_BATCH } from '../shared/protocol.ts';
import type { MessageKey, Snapshot, UnreadSyncHint } from '../shared/protocol.ts';
import { appClient, discoverModuleApi, navigationUrl, notificationData, pushBadge, reconcile } from './device.ts';
import type { DeviceState, ModuleApi, Reconciliation, VisibleNotification, WorkerConfiguration } from './device.ts';

export interface WindowClient {
  id: string;
  url: string;
  focused?: boolean;
  visibilityState?: string;
  postMessage(message: unknown): void;
  focus(): Promise<WindowClient>;
}
export interface WorkerEnvironment {
  registration: {
    getNotifications(): Promise<VisibleNotification[]>;
    showNotification(title: string, options?: NotificationOptions): Promise<void>;
  };
  clients: {
    get(id: string): Promise<WindowClient | undefined>;
    matchAll(options: { type: 'window'; includeUncontrolled: true }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<WindowClient | null>;
  };
  navigator: {
    setAppBadge?(total: number): Promise<void>;
    clearAppBadge?(): Promise<void>;
  };
  storage: { load(): Promise<DeviceState | null>; save(state: DeviceState): Promise<void> };
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export class NotificationWorker {
  private tail: Promise<unknown> = Promise.resolve();
  private environment: WorkerEnvironment;
  private api: ModuleApi;
  readonly configuration: WorkerConfiguration;
  constructor(environment: WorkerEnvironment, configuration: WorkerConfiguration) {
    this.environment = environment;
    this.configuration = configuration;
    this.api = { apiBase: configuration.apiBase, digest: configuration.digest };
  }
  serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // Callers report each failure; a failed operation must not poison the next event.
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async commit(plan: Reconciliation) {
    if (plan.state) await this.environment.storage.save(plan.state);
    const errors: unknown[] = [];
    const navigator = this.environment.navigator;
    if (plan.badge !== null) {
      try {
        if (plan.badge === 0 && navigator.clearAppBadge) await navigator.clearAppBadge();
        else if (navigator.setAppBadge) await navigator.setAppBadge(plan.badge);
      } catch (error) { errors.push(error); }
    }
    for (const notification of plan.close) {
      try { notification.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '系统角标或通知清理失败；网页未读状态未改变');
    return { badgeSupported: typeof navigator.setAppBadge === 'function',
      generation: plan.state?.generation, revision: plan.state?.revision };
  }
  private async discover(signal: AbortSignal): Promise<ModuleApi> {
    const response = await this.environment.fetch(new URL('_modules', this.configuration.appBase).href, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { accept: 'application/json' }, signal,
    });
    if (!response.ok) throw new Error(`模块启动信息同步失败（HTTP ${response.status}）；请打开前台检查登录并更新通知程序`);
    return discoverModuleApi(await response.json(), this.configuration);
  }
  private fetchState(api: ModuleApi, signal: AbortSignal): Promise<Response> {
    return this.environment.fetch(`${api.apiBase}/state`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', headers: { 'x-cockpit-module-digest': api.digest }, signal,
    });
  }
  private async fetchSnapshot(currentGeneration: string | undefined, discover: boolean): Promise<Snapshot> {
    const signal = AbortSignal.timeout(15_000);
    let discovered = discover || !currentGeneration;
    let api = discovered ? await this.discover(signal) : this.api;
    let response = await this.fetchState(api, signal);
    if (!discovered && (response.status === 404 || response.status === 409)) {
      api = await this.discover(signal);
      discovered = true;
      response = await this.fetchState(api, signal);
    }
    const parse = async (response: Response) => {
      if (!response.ok) throw new Error(`通知同步失败（HTTP ${response.status}）；请检查登录、模块版本与连接并在前台更新通知程序`);
      return parseSnapshot(await response.json());
    };
    let snapshot = await parse(response);
    if (!discovered && snapshot.generation !== currentGeneration) {
      api = await this.discover(signal);
      snapshot = await parse(await this.fetchState(api, signal));
    }
    this.api = api;
    return snapshot;
  }
  async sync(discover = false) {
    const current = await this.environment.storage.load();
    const baseline = await this.environment.registration.getNotifications();
    const state = await this.fetchSnapshot(current?.generation, discover);
    return this.commit(reconcile(current, state, baseline, [], baseline));
  }
  async apply(state: Snapshot, acknowledged: MessageKey[]) {
    const current = await this.environment.storage.load();
    if (!current || current.generation !== state.generation) return this.sync(true);
    const notifications = await this.environment.registration.getNotifications();
    return this.commit(reconcile(current, state, notifications, acknowledged));
  }
  async message(value: unknown, sourceId: string) {
    const source = await this.environment.clients.get(sourceId);
    if (!source || !appClient(source.url, this.configuration)) throw new Error('通知控制消息来源不属于本应用');
    if (!record(value)) throw new Error('无效的通知控制消息');
    if (value.type === 'SYNC') return this.sync();
    if (value.type !== 'APPLY_STATE') throw new Error('不支持的通知控制操作');
    const state = parseSnapshot(value.state);
    const acknowledgements = value.acknowledged ?? [];
    if (!Array.isArray(acknowledgements) || acknowledgements.length > MAX_BATCH) throw new Error('无效的通知核销身份');
    return this.apply(state, acknowledgements.map(parseKey));
  }
  async broadcast(type: 'ERROR' | UnreadSyncHint, error?: unknown) {
    const clients = await this.environment.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (appClient(client.url, this.configuration)) client.postMessage({
        moduleId: 'cockpit-notification', ...(typeof type === 'string' ? { type } : type),
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      });
    }
  }
  async push(value: unknown) {
    let payload;
    try {
      payload = parsePayload(value);
      navigationUrl(payload, this.configuration);
    } catch (error) {
      await this.environment.registration.showNotification('Cockpit 通知', {
        body: '通知数据无效，请打开应用检查。', data: { moduleId: 'cockpit-notification' },
      });
      throw error;
    }
    // Even a late/read delivery fulfills the platform's visible-push requirement first.
    await this.environment.registration.showNotification(payload.title, {
      body: payload.body, tag: JSON.stringify([payload.generation, payload.key.sessionId, payload.key.kind, payload.key.nativeId]),
      data: payload,
    });
    const current = await this.environment.storage.load();
    await this.commit(pushBadge(current, payload));
    await this.broadcast({ type: 'unread/sync', generation: payload.generation, revision: payload.revision });
    // Normal pushes carry a count, not a request to fetch the whole unread set.
    if (!current || current.generation !== payload.generation) await this.sync(true);
  }
  async click(notification: VisibleNotification) {
    notification.close();
    const payload = notificationData(notification);
    let target = this.configuration.appBase;
    if (payload) target = navigationUrl(payload, this.configuration);
    else if (!record(notification.data) || notification.data.moduleId !== 'cockpit-notification') {
      throw new Error('通知不属于本模块');
    }
    const clients = (await this.environment.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter(client => appClient(client.url, this.configuration) && client.url === target)
      .sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
    const client = clients[0];
    if (client) {
      await client.focus();
      return;
    }
    // Chat is outside this worker's scope; WindowClient.navigate() cannot redirect it.
    if (!await this.environment.clients.openWindow(target)) throw new Error('浏览器未能打开通知会话');
  }
}
