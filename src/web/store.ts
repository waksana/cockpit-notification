import { keyId, MAX_BATCH, parseKeys, parseSnapshot, record, snapshotKeys } from '../shared/protocol.ts';
import type { MessageKey, ReadResult, Snapshot } from '../shared/protocol.ts';

export type Status = 'empty' | 'refreshing' | 'ready' | 'stale' | 'suspended' | 'disconnected' | 'stopped';
export interface UnreadState {
  snapshot: Snapshot | null;
  status: Status;
  error: string | null;
  pending: number;
}
export interface Activity { sessionId: string | null; visible: boolean; connected: boolean }
export interface StoreOptions {
  request(path: string, init?: RequestInit): Promise<Response>;
  report(error: unknown): void;
  apply(state: Snapshot, acknowledged: MessageKey[]): void;
  batchMs?: number;
}

export function fingerprint(snapshot: Snapshot): string {
  return JSON.stringify([snapshot.generation, snapshot.revision, snapshot.total,
    snapshot.sessions.flatMap(session => session.items.map(item =>
      [keyId({ sessionId: session.sessionId, ...item }), item.createdRevision] as const))
      .sort(([a], [b]) => a.localeCompare(b))]);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}
export async function responseJson(response: Response): Promise<unknown> {
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ApiError(response.status, `通知服务返回了无效响应（HTTP ${response.status}）`); }
  if (!response.ok) {
    const code = record(body) && typeof body.code === 'string' ? body.code : undefined;
    const detail = record(body) && typeof body.message === 'string' ? body.message :
      record(body) && typeof body.error === 'string' ? body.error : response.statusText;
    throw new ApiError(response.status, `通知服务请求失败（HTTP ${response.status}）：${detail}`, code);
  }
  return body;
}

export class UnreadStore {
  private state: UnreadState = { snapshot: null, status: 'empty', error: null, pending: 0 };
  private activity: Activity = { sessionId: null, visible: false, connected: false };
  private listeners = new Set<() => void>();
  private pending = new Map<string, MessageKey>();
  private acknowledged = new Set<string>();
  private get: AbortController | null = null;
  private read: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private fence = 0;
  private bindingEpoch = 0;
  private rebinding = false;
  private stopped = false;
  private options: StoreOptions;
  constructor(options: StoreOptions) { this.options = options; }
  getSnapshot = (): UnreadState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<UnreadState>) {
    if (this.stopped && update.status !== 'stopped') return;
    this.state = { ...this.state, ...update, pending: this.pending.size };
    for (const listener of this.listeners) listener();
  }
  canPresent(): boolean {
    return !this.stopped && !this.rebinding && this.activity.visible && this.activity.connected &&
      this.state.snapshot !== null && this.state.status !== 'stale';
  }
  setActivity(next: Activity) {
    if (this.stopped) return;
    const previous = this.activity;
    this.activity = next;
    if (!next.visible || !next.connected) {
      this.fence++;
      this.get?.abort();
      this.get = null;
      this.dirty = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.publish({ status: !next.visible ? 'suspended' : 'disconnected' });
    } else if (!previous.visible || !previous.connected || next.sessionId !== previous.sessionId) {
      this.refresh();
    }
  }
  refresh = () => {
    if (this.stopped || !this.activity.visible || !this.activity.connected) return;
    if (this.get) { this.dirty = true; return; }
    const controller = new AbortController();
    const fence = this.fence;
    this.get = controller;
    this.publish({ status: 'refreshing' });
    void this.options.request('/state', { signal: controller.signal, cache: 'no-store' })
      .then(responseJson).then(parseSnapshot).then(snapshot => {
        if (this.stopped || controller.signal.aborted || fence !== this.fence) return;
        this.accept(snapshot, true);
        this.rebinding = false;
        this.publish({ status: 'ready', error: null });
        this.schedule();
      }).catch(error => {
        if (!this.stopped && !controller.signal.aborted && fence === this.fence) this.fail(error);
      }).finally(() => {
        if (this.get !== controller) return;
        this.get = null;
        if (this.dirty) { this.dirty = false; this.refresh(); }
      });
  };
  private accept(snapshot: Snapshot, fresh: boolean, acknowledged: MessageKey[] = []) {
    const current = this.state.snapshot;
    if (!current || current.generation !== snapshot.generation) {
      if (!fresh) throw new Error('只有新的完整同步可以切换通知运行代');
      this.bindingEpoch++;
      this.read?.abort();
      this.read = null;
      this.pending.clear();
      this.acknowledged.clear();
    } else {
      if (snapshot.revision < current.revision) {
        if (acknowledged.length) this.options.apply(snapshot, acknowledged);
        return;
      }
      if (snapshot.revision === current.revision && fingerprint(snapshot) !== fingerprint(current)) {
        throw new Error('同版本通知快照内容不一致');
      }
    }
    for (const id of snapshotKeys(snapshot).keys()) {
      if (this.acknowledged.has(id)) throw new Error('已核销通知在同一运行代重新出现');
    }
    this.publish({ snapshot });
    this.options.apply(snapshot, acknowledged);
  }
  present(key: MessageKey, generation: string) {
    if (!this.canPresent() || this.state.snapshot?.generation !== generation) return;
    const id = keyId(key);
    if (this.acknowledged.has(id) || this.pending.has(id)) return;
    this.pending.set(id, key);
    this.publish({});
    this.schedule();
  }
  private schedule() {
    if (!this.canPresent() || this.read || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.options.batchMs ?? 150);
  }
  async flush() {
    if (!this.canPresent() || this.read || !this.pending.size) return;
    const generation = this.state.snapshot!.generation;
    const epoch = this.bindingEpoch;
    const keys = [...this.pending.values()].slice(0, MAX_BATCH);
    const sent = new Set(keys.map(keyId));
    const controller = new AbortController();
    this.read = controller;
    let succeeded = false;
    try {
      const body = await responseJson(await this.options.request('/read', {
        method: 'POST', signal: controller.signal, cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generation, keys }),
      }));
      if (this.stopped || controller.signal.aborted || this.bindingEpoch !== epoch || this.rebinding ||
          this.state.snapshot?.generation !== generation) return;
      if (!record(body)) throw new Error('无效的核销回执');
      const result: ReadResult = { acknowledged: parseKeys(body.acknowledged), state: parseSnapshot(body.state) };
      if (result.state.generation !== generation || result.acknowledged.length !== sent.size ||
          result.acknowledged.some(key => !sent.has(keyId(key)))) throw new Error('核销回执身份或运行代不匹配');
      for (const key of result.acknowledged) {
        this.pending.delete(keyId(key));
        this.acknowledged.add(keyId(key));
      }
      this.accept(result.state, false, result.acknowledged);
      this.publish({ error: null, status: !this.activity.visible ? 'suspended' :
        !this.activity.connected ? 'disconnected' : this.get ? 'refreshing' : 'ready' });
      succeeded = true;
    } catch (error) {
      if (this.stopped || controller.signal.aborted || this.bindingEpoch !== epoch) return;
      this.fail(error);
      if (error instanceof ApiError && error.status === 409 && error.code === 'GENERATION_MISMATCH') {
        this.rebinding = true;
        this.bindingEpoch++;
        this.fence++;
        this.get?.abort();
        this.get = null;
        this.refresh();
      }
    } finally {
      if (this.read === controller) this.read = null;
      if (succeeded) this.schedule();
    }
  }
  private fail(error: unknown) {
    this.options.report(error);
    this.publish({ error: error instanceof Error ? error.message : String(error),
      status: !this.activity.visible ? 'suspended' : !this.activity.connected ? 'disconnected' : 'stale' });
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.fence++;
    this.get?.abort();
    this.read?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
    this.publish({ status: 'stopped' });
    this.listeners.clear();
  }
}
