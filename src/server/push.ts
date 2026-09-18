import { lookup } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import webPush from 'web-push';
import { keyId, type MessageKey, type NotificationPayload } from '../shared/protocol.ts';
import { BackendError } from './errors.ts';
import type { Entry, Ledger } from './ledger.ts';
import type { Device, SubscriptionStore } from './storage.ts';

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const systemClock: Clock = {
  now: Date.now,
  setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
  clearTimeout(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
};
export type SendOutcome = 'ACCEPTED' | 'FAILED' | 'UNKNOWN';
export type Sender = (device: Device, payload: NotificationPayload, signal: AbortSignal) => Promise<SendOutcome>;
type Attempt = 'READY' | 'SENDING' | 'CANCELLED' | SendOutcome;
interface Plan {
  generation: string;
  key: MessageKey;
  state: 'WAITING' | 'DISPATCHED' | 'NO_TARGETS' | 'CANCELLED';
  timer?: unknown;
  attempts: Map<string, Attempt>;
}
const MAX_CONCURRENT_SENDS = 4;
interface WaitingSend {
  plan: Plan;
  resolve: (release: (() => void) | undefined) => void;
}

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(address, prefix, 'ipv6');

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address, 'ipv4') :
    family === 6 && !blocked6.check(address, 'ipv6');
}

export function networkSender(store: SubscriptionStore): Sender {
  return async (device, payload, signal) => {
    if (signal.aborted) return 'UNKNOWN';
    let details: ReturnType<typeof webPush.generateRequestDetails>;
    try {
      details = webPush.generateRequestDetails(device.subscription, JSON.stringify(payload), {
        vapidDetails: store.vapid, timeout: 10_000, TTL: 60, urgency: 'normal',
      });
    } catch { return 'FAILED'; }
    return new Promise<SendOutcome>(resolve => {
      let outcome: SendOutcome = 'UNKNOWN';
      const push = request(details.endpoint, {
        method: details.method, headers: details.headers, agent: false, timeout: 10_000,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (error || !addresses.length || addresses.some(item => !publicAddress(item.address))) {
              callback(new Error('Push destination unavailable'), '', 4);
              return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      }, response => {
        outcome = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300 ?
          'ACCEPTED' : 'FAILED';
        response.on('error', () => { push.destroy(); });
        response.destroy();
      });
      push.on('timeout', () => push.destroy(new Error('Push timeout')));
      push.on('error', () => { /* Errors without response headers leave acceptance unknown. */ });
      // Keep the concurrency slot until the actual request closes, not merely until headers arrive.
      push.on('close', () => resolve(outcome));
      push.end(details.body);
    });
  };
}

export class PushScheduler {
  #ledger: Ledger;
  #store: SubscriptionStore;
  #clock: Clock;
  #sender: Sender;
  #delay: number;
  #report: (error: BackendError) => void;
  #plans = new Map<string, Plan>();
  #controller = new AbortController();
  #inFlight = 0;
  #waiting: WaitingSend[] = [];

  constructor(ledger: Ledger, store: SubscriptionStore, clock: Clock, sender: Sender,
    delay: number, report: (error: BackendError) => void) {
    this.#ledger = ledger;
    this.#store = store;
    this.#clock = clock;
    this.#sender = sender;
    this.#delay = delay;
    this.#report = report;
  }

  schedule(entry: Entry): void {
    const id = keyId(entry.key);
    if (this.#controller.signal.aborted || this.#plans.has(id)) return;
    const plan: Plan = { generation: this.#ledger.generation, key: entry.key, state: 'WAITING', attempts: new Map() };
    this.#plans.set(id, plan);
    plan.timer = this.#clock.setTimeout(() => { void this.#due(plan); }, this.#delay);
  }

  cancel(key: MessageKey): void {
    const plan = this.#plans.get(keyId(key));
    if (!plan) return;
    if (plan.timer !== undefined) this.#clock.clearTimeout(plan.timer);
    plan.state = 'CANCELLED';
    for (const [id, attempt] of plan.attempts) if (attempt === 'READY') plan.attempts.set(id, 'CANCELLED');
    this.#cancelWaiting(plan);
    this.#plans.delete(keyId(key));
  }

  cancelSubscription(id: string): void {
    for (const plan of this.#plans.values()) {
      if (plan.attempts.get(id) === 'READY') plan.attempts.set(id, 'CANCELLED');
    }
  }

  inspect(key: MessageKey): { state: Plan['state']; attempts: Record<string, Attempt> } | undefined {
    const plan = this.#plans.get(keyId(key));
    return plan ? { state: plan.state, attempts: Object.fromEntries(plan.attempts) } : undefined;
  }

  #current(plan: Plan): Entry | undefined {
    return !this.#controller.signal.aborted && plan.state !== 'CANCELLED' && plan.generation === this.#ledger.generation ?
      this.#ledger.get(plan.key) : undefined;
  }

  #acquire(plan: Plan): Promise<(() => void) | undefined> {
    if (!this.#current(plan)) return Promise.resolve(undefined);
    if (this.#inFlight < MAX_CONCURRENT_SENDS) return Promise.resolve(this.#reserve());
    return new Promise(resolve => { this.#waiting.push({ plan, resolve }); });
  }

  #reserve(): () => void {
    this.#inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight--;
      while (this.#waiting.length && this.#inFlight < MAX_CONCURRENT_SENDS) {
        const next = this.#waiting.shift()!;
        next.resolve(this.#current(next.plan) ? this.#reserve() : undefined);
      }
    };
  }

  #cancelWaiting(plan?: Plan): void {
    const cancelled = this.#waiting.filter(waiting => plan === undefined || waiting.plan === plan);
    this.#waiting = this.#waiting.filter(waiting => plan !== undefined && waiting.plan !== plan);
    for (const waiting of cancelled) waiting.resolve(undefined);
  }

  async #due(plan: Plan): Promise<void> {
    if (plan.state !== 'WAITING') return;
    plan.timer = undefined;
    if (!this.#current(plan)) { plan.state = 'CANCELLED'; return; }
    const devices = this.#store.active(this.#clock.now());
    plan.state = devices.length ? 'DISPATCHED' : 'NO_TARGETS';
    for (const device of devices) plan.attempts.set(device.id, 'READY');
    for (const device of devices) {
      const release = await this.#acquire(plan);
      if (!release) {
        for (const [id, attempt] of plan.attempts) if (attempt === 'READY') plan.attempts.set(id, 'CANCELLED');
        return;
      }
      try {
        const entry = this.#current(plan);
        const currentDevice = this.#store.active(this.#clock.now()).find(current => current.id === device.id);
        if (!entry || !currentDevice || plan.attempts.get(device.id) !== 'READY') {
          plan.attempts.set(device.id, 'CANCELLED');
          continue;
        }
        const snapshot = this.#ledger.snapshot();
        const text = plan.key.kind === 'reply' ? '会话有新回复' : '有问题需要回答';
        const payload: NotificationPayload = {
          moduleId: 'cockpit-notification', generation: snapshot.generation, key: { ...plan.key },
          createdRevision: entry.createdRevision, revision: snapshot.revision, total: snapshot.total,
          title: text, body: text, navigationTarget: `session/${encodeURIComponent(plan.key.sessionId)}`,
        };
        plan.attempts.set(device.id, 'SENDING');
        let outcome: SendOutcome;
        try { outcome = await this.#sender(currentDevice, payload, this.#controller.signal); }
        catch { outcome = 'UNKNOWN'; }
        if (this.#controller.signal.aborted) return;
        if (!['ACCEPTED', 'FAILED', 'UNKNOWN'].includes(outcome)) outcome = 'UNKNOWN';
        plan.attempts.set(device.id, outcome);
        if (outcome !== 'ACCEPTED') {
          this.#report(new BackendError(`PUSH_${outcome}`, outcome === 'FAILED' ?
            'Push service rejected a notification' : 'Push acceptance is unknown', 502));
        }
      } finally {
        release();
      }
    }
  }

  stop(): void {
    this.#controller.abort();
    this.#cancelWaiting();
    for (const plan of this.#plans.values()) if (plan.timer !== undefined) this.#clock.clearTimeout(plan.timer);
    this.#plans.clear();
  }
}
