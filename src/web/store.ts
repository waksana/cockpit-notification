import { applyUnreadDelta, keyId, MAX_BATCH, parseReadResult, parseSnapshot, parseUnreadEvent, record } from '../shared/protocol.ts';
import type { MessageKey, Snapshot, UnreadEvent, UnreadSyncHint } from '../shared/protocol.ts';

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
  barrierMs?: number;
  maxBufferedEvents?: number;
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
  private barrierTimer: ReturnType<typeof setTimeout> | null = null;
  private barriers = new Map<string, number>();
  private required = new Map<string, number>();
  private barrierDeadline = 0;
  private barrierAttempted = false;
  private buffer: UnreadEvent[] = [];
  private observedDuringGet = new Set<string>();
  private bufferInvalid = false;
  private retired = new Set<string>();
  private needsSync = true;
  private recoveryBlocked = false;
  private readBlocked = false;
  private dirty = false;
  private fence = 0;
  private bindingEpoch = 0;
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
    return !this.stopped && !this.needsSync && !this.readBlocked && !this.state.error &&
      this.activity.visible && this.activity.connected && this.state.snapshot !== null;
  }
  private status(): Status {
    if (!this.activity.visible) return 'suspended';
    if (!this.activity.connected) return 'disconnected';
    if (this.get) return 'refreshing';
    if (this.needsSync || this.state.error) return this.state.snapshot || this.state.error ? 'stale' : 'empty';
    return 'ready';
  }
  private cancelGet() {
    this.fence++;
    this.get?.abort();
    this.get = null;
    this.buffer = [];
    this.observedDuringGet.clear();
    this.bufferInvalid = false;
    this.dirty = false;
  }
  setActivity(next: Activity) {
    if (this.stopped) return;
    const previous = this.activity;
    this.activity = next;
    if (!next.visible || !next.connected) {
      if (!next.connected || this.get) this.needsSync = true;
      this.cancelGet();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.barrierTimer) clearTimeout(this.barrierTimer);
      this.barrierTimer = null;
    } else if (!previous.visible || !previous.connected) {
      if (this.needsSync) this.refresh();
      this.scheduleBarrier();
      this.schedule();
    }
    this.publish({ status: this.status() });
  }
  refresh = () => {
    if (this.stopped) return;
    this.recoveryBlocked = false;
    this.needsSync = true;
    if (this.get) { this.dirty = true; return; }
    this.startGet(1);
  };
  private startGet(retries: number) {
    if (this.stopped || !this.activity.visible || !this.activity.connected) return;
    if (this.get || this.recoveryBlocked) return;
    const controller = new AbortController();
    const fence = this.fence;
    const observedBeforeGet = new Set([...this.required.keys(), ...this.barriers.keys()]);
    this.get = controller;
    this.buffer = [];
    this.observedDuringGet.clear();
    this.bufferInvalid = false;
    this.publish({ status: 'refreshing' });
    let retry = false;
    void this.options.request('/state', { signal: controller.signal, cache: 'no-store' })
      .then(responseJson).then(parseSnapshot).then(snapshot => {
        if (this.stopped || controller.signal.aborted || fence !== this.fence) return;
        // A fresh checkpoint may supersede hints from an unfamiliar, already retired generation.
        // Events observed during this request still need a subsequent checkpoint or contiguous replay.
        const superseded = new Set([...observedBeforeGet].filter(generation =>
          generation !== snapshot.generation && !this.observedDuringGet.has(generation)));
        const result = this.merge(snapshot, superseded);
        this.accept(result.snapshot);
        for (const generation of superseded) this.retired.add(generation);
        this.coverBarriers();
        this.needsSync = result.incomplete || this.required.size > 0 || (this.barrierAttempted && this.barriers.size > 0);
        if (this.needsSync) {
          retry = retries > 0;
          this.recoveryBlocked = !retry;
          this.fail(new Error('通知事件未连续覆盖同步版本；保留已知状态，请重新同步'));
          return;
        }
        this.recoveryBlocked = false;
        this.readBlocked = false;
        this.publish({ error: null });
        this.schedule();
      }).catch(error => {
        if (!this.stopped && !controller.signal.aborted && fence === this.fence) {
          this.needsSync = true;
          this.recoveryBlocked = true;
          this.fail(error);
        }
      }).finally(() => {
        if (this.get !== controller) return;
        this.get = null;
        this.buffer = [];
        this.observedDuringGet.clear();
        this.bufferInvalid = false;
        this.publish({ status: this.status() });
        if (this.dirty) { this.dirty = false; this.refresh(); }
        else if (retry) this.startGet(retries - 1);
        this.scheduleBarrier();
      });
  }
  private merge(snapshot: Snapshot, superseded: Set<string>): { snapshot: Snapshot; incomplete: boolean } {
    const current = this.state.snapshot;
    if (this.retired.has(snapshot.generation)) throw new Error('通知同步返回了已退役运行代');
    if (current?.generation === snapshot.generation) {
      if (snapshot.revision < current.revision) snapshot = current;
      else if (snapshot.revision === current.revision && fingerprint(snapshot) !== fingerprint(current)) {
        throw new Error('同版本通知快照内容不一致');
      }
    }
    const ignored = new Set([...this.retired, ...superseded]);
    if (current && current.generation !== snapshot.generation) ignored.add(current.generation);
    const events = this.buffer.filter(event => !ignored.has(event.generation));
    let incomplete = this.bufferInvalid || events.some(event => event.generation !== snapshot.generation);
    const deltas = events.filter(event => event.type === 'unread/delta' && event.generation === snapshot.generation)
      .sort((a, b) => a.revision - b.revision);
    for (const delta of deltas) {
      if (delta.type !== 'unread/delta' || delta.revision <= snapshot.revision) continue;
      if (delta.fromRevision !== snapshot.revision) { incomplete = true; break; }
      snapshot = applyUnreadDelta(snapshot, delta);
    }
    if (events.some(event => event.generation === snapshot.generation && event.revision > snapshot.revision)) incomplete = true;
    return { snapshot, incomplete };
  }
  private accept(snapshot: Snapshot) {
    const current = this.state.snapshot;
    if (!current || current.generation !== snapshot.generation) {
      if (current) this.retired.add(current.generation);
      this.bindingEpoch++;
      this.read?.abort();
      this.read = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.pending.clear();
      this.acknowledged.clear();
      this.readBlocked = false;
    }
    this.publish({ snapshot, status: this.status() });
    this.options.apply(snapshot, []);
  }
  onEvent = (value: unknown) => {
    if (this.stopped) return;
    let event: UnreadEvent;
    try { event = parseUnreadEvent(value); }
    catch (error) {
      this.needsSync = true;
      this.bufferInvalid = true;
      this.fail(error);
      this.startGet(1);
      return;
    }
    if (this.retired.has(event.generation)) return;
    if (!this.covered(event.generation, event.revision)) {
      this.required.set(event.generation, Math.max(this.required.get(event.generation) ?? 0, event.revision));
    }
    if (!this.activity.connected) { this.needsSync = true; return; }
    if (this.get) {
      this.observedDuringGet.add(event.generation);
      if (this.bufferInvalid) return;
      if (this.buffer.length >= (this.options.maxBufferedEvents ?? 128)) {
        this.buffer = [];
        this.bufferInvalid = true;
      } else this.buffer.push(event);
      return;
    }
    const current = this.state.snapshot;
    if (current?.generation === event.generation && event.revision <= current.revision) return;
    if (event.type === 'unread/delta' && current?.generation === event.generation &&
        event.fromRevision === current.revision) {
      try {
        this.accept(applyUnreadDelta(current, event));
        this.coverBarriers();
      } catch (error) {
        this.needsSync = true;
        this.fail(error);
        this.startGet(1);
      }
      return;
    }
    this.needsSync = true;
    this.publish({ status: this.status() });
    this.startGet(1);
    if (this.get) this.buffer.push(event);
  };
  hint = (value: UnreadSyncHint) => {
    if (this.stopped) return;
    try {
      const hint = parseUnreadEvent(value);
      if (hint.type !== 'unread/sync') throw new Error('无效的通知版本提示');
      this.target(hint.generation, hint.revision);
    } catch (error) { this.fail(error); }
  };
  private covered(generation: string, revision: number) {
    return this.retired.has(generation) ||
      (this.state.snapshot?.generation === generation && this.state.snapshot.revision >= revision);
  }
  private target(generation: string, revision: number) {
    if (this.covered(generation, revision)) return;
    if (this.get) this.observedDuringGet.add(generation);
    if (!this.barriers.size) {
      this.barrierDeadline = Date.now() + (this.options.barrierMs ?? 3000);
      this.barrierAttempted = false;
    }
    this.barriers.set(generation, Math.max(this.barriers.get(generation) ?? 0, revision));
    this.scheduleBarrier();
  }
  private coverBarriers() {
    for (const [generation, revision] of this.required) {
      if (this.covered(generation, revision)) this.required.delete(generation);
    }
    for (const [generation, revision] of this.barriers) {
      if (this.covered(generation, revision)) this.barriers.delete(generation);
    }
    if (!this.barriers.size) {
      if (this.barrierTimer) clearTimeout(this.barrierTimer);
      this.barrierTimer = null;
      this.barrierAttempted = false;
    }
  }
  private scheduleBarrier() {
    if (this.stopped || this.barrierTimer || this.barrierAttempted || !this.barriers.size ||
        !this.activity.visible || !this.activity.connected) return;
    this.barrierTimer = setTimeout(() => {
      this.barrierTimer = null;
      this.barrierAttempted = true;
      this.needsSync = true;
      this.startGet(0);
      this.publish({ status: this.status() });
    }, Math.max(0, this.barrierDeadline - Date.now()));
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      if (this.stopped || controller.signal.aborted || this.bindingEpoch !== epoch ||
          this.state.snapshot?.generation !== generation) return;
      const result = parseReadResult(body);
      if (result.generation !== generation || result.acknowledged.length !== sent.size ||
          result.acknowledged.some(key => !sent.has(keyId(key)))) throw new Error('核销回执身份或运行代不匹配');
      for (const key of result.acknowledged) {
        this.pending.delete(keyId(key));
        this.acknowledged.add(keyId(key));
      }
      this.target(result.generation, result.revision);
      this.publish({});
      succeeded = true;
    } catch (error) {
      if (this.stopped || controller.signal.aborted || this.bindingEpoch !== epoch) return;
      this.readBlocked = true;
      this.fail(error);
      if (error instanceof ApiError && error.status === 409 && error.code === 'GENERATION_MISMATCH') {
        this.bindingEpoch++;
        this.cancelGet();
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
    if (this.barrierTimer) clearTimeout(this.barrierTimer);
    this.buffer = [];
    this.observedDuringGet.clear();
    this.barriers.clear();
    this.required.clear();
    this.pending.clear();
    this.publish({ status: 'stopped' });
    this.listeners.clear();
  }
}
