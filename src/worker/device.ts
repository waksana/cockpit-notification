import { identity, keyId, parsePayload, record, snapshotKeys } from '../shared/protocol.ts';
import type { MessageKey, NotificationPayload, Snapshot } from '../shared/protocol.ts';

export interface DeviceState {
  generation: string;
  revision: number;
  total: number;
  retired: string[];
}
export interface VisibleNotification {
  data: unknown;
  close(): void;
}
export interface Reconciliation {
  state: DeviceState | null;
  badge: number | null;
  close: VisibleNotification[];
}
export function notificationData(notification: VisibleNotification): NotificationPayload | null {
  try { return parsePayload(notification.data); }
  catch { return null; }
}
export function parseDeviceState(value: unknown): DeviceState | null {
  if (value === undefined || value === null) return null;
  if (!record(value) || !identity(value.generation) || !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 || !Number.isSafeInteger(value.total) || Number(value.total) < 0 ||
      Number(value.total) > 10_000 || !Array.isArray(value.retired) || value.retired.length > 64 ||
      value.retired.some(item => !identity(item) || item === value.generation)) {
    throw new Error('设备通知版本记录损坏');
  }
  return { generation: value.generation, revision: Number(value.revision), total: Number(value.total),
    retired: [...new Set(value.retired as string[])] };
}

// A baseline is enumerated BEFORE the fresh GET, never after it.
export function reconcile(current: DeviceState | null, snapshot: Snapshot,
  notifications: VisibleNotification[], _acknowledged: MessageKey[] = [],
  baseline: VisibleNotification[] | null = null): Reconciliation {
  const switching = current?.generation !== snapshot.generation;
  if (switching && baseline === null) return { state: current, badge: null, close: [] };
  const retired = new Set(current?.retired ?? []);
  if (baseline !== null) {
    if (current && switching) retired.add(current.generation);
    for (const notification of baseline) {
      const data = notificationData(notification);
      if (data && data.generation !== snapshot.generation) retired.add(data.generation);
    }
    retired.delete(snapshot.generation);
  }
  const newer = switching || snapshot.revision >= current!.revision;
  if (!switching && snapshot.revision === current!.revision && snapshot.total !== current!.total) {
    throw new Error('同版本设备角标总数不一致');
  }
  const state: DeviceState = newer ? {
    generation: snapshot.generation, revision: snapshot.revision, total: snapshot.total,
    // Forgotten proof only makes future cleanup more conservative; it never changes U.
    retired: [...retired].slice(-64),
  } : { ...current!, retired: [...retired].slice(-64) };
  const unread = snapshotKeys(snapshot);
  const proven = new Set(baseline ?? []);
  const close = notifications.filter(notification => {
    const data = notificationData(notification);
    if (!data) return false;
    if (data.generation === snapshot.generation) {
      return data.createdRevision <= snapshot.revision && !unread.has(keyId(data.key));
    }
    // Only earlier proof (or this exact pre-GET object) may clear another generation.
    return current?.retired.includes(data.generation) === true || proven.has(notification) ||
      (baseline !== null && data.generation === current?.generation && switching);
  });
  return { state, badge: newer ? snapshot.total : null, close };
}

export function pushBadge(current: DeviceState | null, payload: NotificationPayload): Reconciliation {
  if (!current || current.generation !== payload.generation || payload.revision < current.revision) {
    return { state: current, badge: null, close: [] };
  }
  if (payload.revision === current.revision && payload.total !== current.total) {
    throw new Error('同版本推送角标总数不一致');
  }
  return { state: { ...current, revision: payload.revision, total: payload.total }, badge: payload.total, close: [] };
}

export interface WorkerConfiguration {
  moduleId: 'cockpit-notification';
  digest: string;
  apiBase: string;
  appBase: string;
  workerUrl: string;
}
export interface ModuleApi { digest: string; apiBase: string }
export function discoverModuleApi(value: unknown, configuration: WorkerConfiguration): ModuleApi {
  if (!record(value) || !Array.isArray(value.modules) || !Array.isArray(value.active) ||
      !Array.isArray(value.errors) || ('apiVersion' in value && value.apiVersion !== 1)) {
    throw new Error('模块启动信息无效；请打开前台更新通知程序');
  }
  const matches = value.modules.filter(item => record(item) && item.id === configuration.moduleId);
  const active = value.active.filter(item => record(item) && item.id === configuration.moduleId);
  const module = matches[0];
  if (matches.length !== 1 || active.length !== 1 || !record(module) || !record(active[0])) {
    throw new Error('通知模块未成功加载或已停用；请打开前台检查模块并更新通知程序');
  }
  if (typeof module.digest !== 'string' || !/^[a-f0-9]{64}$/.test(module.digest) ||
      active[0].digest !== module.digest || typeof module.apiBase !== 'string' || module.apiBase.length > 2048 ||
      /[\\\x00-\x20\x7f]/.test(module.apiBase)) throw new Error('通知模块启动身份或 API 地址无效');
  // Host bootstrap paths beginning /_modules/ are deployment-relative, as in its web runtime.
  const api = new URL(module.apiBase.startsWith('/_modules/') ? module.apiBase.slice(1) : module.apiBase,
    configuration.appBase);
  const expected = new URL(`_modules/cockpit-notification/${module.digest}/api`, configuration.appBase);
  if (api.href !== expected.href) throw new Error('通知模块 API 越过当前应用、模块或版本边界');
  return { digest: module.digest, apiBase: api.href };
}
export function workerConfiguration(value: unknown, location: string): WorkerConfiguration {
  const worker = new URL(location);
  if (!record(value) || value.moduleId !== 'cockpit-notification' ||
      typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.apiBase !== 'string' || worker.username || worker.password || worker.search || worker.hash ||
      !['https:', 'http:'].includes(worker.protocol)) throw new Error('无效的宿主 worker 配置');
  const appBase = new URL('../../../', worker);
  const expectedWorker = new URL('_modules/workers/cockpit-notification/worker.js', appBase);
  const apiBase = new URL(value.apiBase, worker);
  const expectedApi = new URL(`_modules/cockpit-notification/${value.digest}/api`, appBase);
  if (worker.href !== expectedWorker.href || apiBase.href !== expectedApi.href) {
    throw new Error('worker 或 API 路径不属于本模块');
  }
  return { moduleId: 'cockpit-notification', digest: value.digest, apiBase: apiBase.href,
    appBase: appBase.href, workerUrl: worker.href };
}
export function appClient(url: string, configuration: WorkerConfiguration): boolean {
  try {
    const target = new URL(url);
    const base = new URL(configuration.appBase);
    return target.origin === base.origin && !target.username && !target.password && target.pathname.startsWith(base.pathname);
  } catch { return false; }
}
export function navigationUrl(payload: NotificationPayload, configuration: WorkerConfiguration): string {
  const expected = `session/${encodeURIComponent(payload.key.sessionId)}`;
  if (payload.navigationTarget !== expected) throw new Error('无效的通知导航目标');
  const target = new URL(expected, configuration.appBase);
  if (!appClient(target.href, configuration) ||
      target.pathname !== `${new URL('session/', configuration.appBase).pathname}${encodeURIComponent(payload.key.sessionId)}`) {
    throw new Error('通知导航越过会话边界');
  }
  return target.href;
}
