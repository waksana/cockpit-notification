import { lookup } from 'node:dns';
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { EventEmitter } from 'node:events';
import { BlockList, isIP } from 'node:net';
import webPush from 'web-push';
import { keyId, type MessageKey, type NotificationPayload } from '../shared/protocol.ts';
import { BackendError } from './errors.ts';
import type { Entry, Ledger } from './ledger.ts';
import type { Device, SubscriptionStore } from './storage.ts';
import { notificationTitle } from './preview.ts';
import { parseSendResult, type DeliveryAttempt, type DeliveryStatus, type NetworkCategory,
  type SendOutcome, type SendResult } from '../shared/delivery.ts';
export type { SendOutcome, SendResult } from '../shared/delivery.ts';

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
export type Sender = (device: Device, payload: NotificationPayload, signal: AbortSignal) => Promise<SendResult>;
type Attempt = 'READY' | 'SENDING' | 'CANCELLED' | SendOutcome;
interface Plan {
  generation: string;
  key: MessageKey;
  summary: string;
  state: 'WAITING' | 'DISPATCHED' | 'NO_TARGETS' | 'CANCELLED';
  timer?: unknown;
  attempts: Map<string, Attempt>;
  registrations: Map<string, string>;
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

interface PushRequest extends EventEmitter {
  end(body?: string | Buffer | null): void;
  destroy(error?: Error): void;
}
interface PushResponse extends EventEmitter {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  destroy(): void;
}
export type PushTransport = (endpoint: string, options: RequestOptions,
  response: (response: PushResponse) => void) => PushRequest;

export function retryAfter(value: string | string[] | undefined, now: number): number | undefined {
  if (typeof value !== 'string' || value.length > 128) return;
  const seconds = /^\d+$/.test(value) ? Number(value) :
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ?
      Math.ceil((Date.parse(value) - now) / 1000) : NaN;
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(0, seconds)) : undefined;
}

function networkCategory(error: unknown): NetworkCategory {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'PUSH_DESTINATION_BLOCKED') return 'destination-blocked';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'PUSH_DNS_FAILED') return 'dns';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ABORT_ERR') return 'aborted';
  if (typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') ||
      ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'tls';
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(code))) return 'connection';
  return 'other';
}

export function networkSender(store: SubscriptionStore, transport: PushTransport = request): Sender {
  return async (device, payload, signal) => {
    if (signal.aborted) return { outcome: 'UNKNOWN', phase: 'cancelled', networkCategory: 'aborted' };
    let details: ReturnType<typeof webPush.generateRequestDetails>;
    try {
      details = webPush.generateRequestDetails(device.subscription, JSON.stringify(payload), {
        vapidDetails: store.vapid, timeout: 10_000, TTL: 60, urgency: 'normal',
      });
    } catch { return { outcome: 'FAILED', phase: 'preparation' }; }
    return new Promise<SendResult>(resolve => {
      let result: SendResult = { outcome: 'UNKNOWN', phase: 'transport', networkCategory: 'other' };
      const deadline = AbortSignal.timeout(10_000);
      let push: PushRequest;
      try { push = transport(details.endpoint, {
        method: details.method, headers: details.headers, agent: false, timeout: 10_000,
        signal: AbortSignal.any([signal, deadline]),
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (error || !addresses.length || addresses.some(item => !publicAddress(item.address))) {
              callback(Object.assign(new Error('Push destination unavailable'),
                { code: error || !addresses.length ? 'PUSH_DNS_FAILED' : 'PUSH_DESTINATION_BLOCKED' }), '', 4);
              return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      }, response => {
        const status = response.statusCode;
        if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
          const delay = retryAfter(response.headers['retry-after'], Date.now());
          result = { outcome: status >= 200 && status < 300 ? 'ACCEPTED' : 'FAILED',
            phase: 'response', upstreamStatus: status,
            ...(delay === undefined ? {} : { retryAfterSeconds: delay }) };
        }
        response.on('error', () => { push.destroy(); });
        response.destroy();
      }); } catch { resolve({ outcome: 'FAILED', phase: 'preparation' }); return; }
      push.on('timeout', () => {
        if (result.phase !== 'response') result = { outcome: 'UNKNOWN', phase: 'transport', networkCategory: 'timeout' };
        push.destroy(Object.assign(new Error('Push timeout'), { code: 'ETIMEDOUT' }));
      });
      push.on('error', (error: unknown) => {
        if (result.phase === 'response') return;
        result = signal.aborted ? { outcome: 'UNKNOWN', phase: 'cancelled', networkCategory: 'aborted' } :
          { outcome: 'UNKNOWN', phase: 'transport', networkCategory: deadline.aborted ? 'timeout' : networkCategory(error) };
      });
      // Keep the concurrency slot until the actual request closes, not merely until headers arrive.
      push.on('close', () => resolve(result));
      try { push.end(details.body); }
      catch {
        result = { outcome: 'UNKNOWN', phase: 'transport', networkCategory: 'other' };
        push.destroy();
      }
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
  #sessionTitle: (sessionId: string) => string | undefined;
  #plans = new Map<string, Plan>();
  #controller = new AbortController();
  #inFlight = 0;
  #waiting: WaitingSend[] = [];
  #delivery = new Map<string, DeliveryStatus>();

  constructor(ledger: Ledger, store: SubscriptionStore, clock: Clock, sender: Sender,
    delay: number, report: (error: BackendError) => void,
    sessionTitle: (sessionId: string) => string | undefined = () => undefined) {
    this.#ledger = ledger;
    this.#store = store;
    this.#clock = clock;
    this.#sender = sender;
    this.#delay = delay;
    this.#report = report;
    this.#sessionTitle = sessionTitle;
  }

  schedule(entry: Entry, summary = ''): void {
    const id = keyId(entry.key);
    if (this.#controller.signal.aborted || this.#plans.has(id)) return;
    const plan: Plan = { generation: this.#ledger.generation, key: entry.key, summary, state: 'WAITING',
      attempts: new Map(), registrations: new Map() };
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

  cancelSubscription(id: string, generation?: string): void {
    for (const plan of this.#plans.values()) {
      if (plan.attempts.get(id) === 'READY' && (generation === undefined || plan.registrations.get(id) === generation)) {
        plan.attempts.set(id, 'CANCELLED');
      }
    }
  }

  delivery(id: string): DeliveryStatus | undefined {
    const status = this.#delivery.get(id);
    return status ? structuredClone(status) : undefined;
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
    const summary = plan.summary;
    plan.summary = '';
    if (!this.#current(plan)) { plan.state = 'CANCELLED'; return; }
    const devices = this.#store.active(this.#clock.now());
    plan.state = devices.length ? 'DISPATCHED' : 'NO_TARGETS';
    for (const device of devices) {
      plan.attempts.set(device.id, 'READY');
      plan.registrations.set(device.id, device.generation);
    }
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
        const payload: NotificationPayload = {
          moduleId: 'cockpit-notification', generation: snapshot.generation, key: { ...plan.key },
          createdRevision: entry.createdRevision, revision: snapshot.revision, total: snapshot.total,
          title: notificationTitle(plan.key, this.#sessionTitle(plan.key.sessionId)),
          body: summary || (plan.key.kind === 'reply' ? '打开会话查看回复' : '打开会话查看问题'),
          navigationTarget: `session/${encodeURIComponent(plan.key.sessionId)}`,
        };
        plan.attempts.set(device.id, 'SENDING');
        plan.registrations.set(device.id, currentDevice.generation);
        let result: SendResult;
        try { result = parseSendResult(await this.#sender(currentDevice, payload, this.#controller.signal)); }
        catch { result = { outcome: 'UNKNOWN', phase: 'transport', networkCategory: 'other' }; }
        if (this.#controller.signal.aborted) return;
        plan.attempts.set(device.id, result.outcome);
        const attempt: DeliveryAttempt = { at: this.#clock.now(), result };
        let persistenceError: BackendError | undefined;
        if (result.phase === 'response' && (result.upstreamStatus === 404 || result.upstreamStatus === 410)) {
          this.cancelSubscription(device.id, currentDevice.generation);
          try { attempt.invalidation = this.#store.invalidate(currentDevice); }
          catch {
            attempt.invalidation = 'persistence-failed';
            persistenceError = new BackendError('PUSH_INVALIDATION_PERSIST_FAILED',
              'Expired push subscription quarantined in memory; durable removal failed and restart may restore it', 503);
          }
        }
        const previous = this.#delivery.get(device.id);
        this.#delivery.delete(device.id);
        this.#delivery.set(device.id, { latest: attempt,
          ...(result.outcome === 'ACCEPTED' ? { lastAcceptedAt: attempt.at,
            ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}) } :
            { lastFailure: attempt, ...(previous?.lastAcceptedAt === undefined ? {} : { lastAcceptedAt: previous.lastAcceptedAt }) }) });
        if (this.#delivery.size > 64) this.#delivery.delete(this.#delivery.keys().next().value!);
        if (result.outcome !== 'ACCEPTED') {
          const detail = Object.entries(result).map(([field, value]) => `${field}=${value}`).join(' ');
          this.#report(new BackendError(result.phase === 'preparation' ? 'PUSH_PREPARATION_FAILED' :
            result.phase === 'response' ? 'PUSH_HTTP_REJECTED' : 'PUSH_UNKNOWN',
          `Push attempt: ${detail}`, result.phase === 'preparation' ? 500 : 502));
        }
        if (persistenceError) this.#report(persistenceError);
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
    this.#delivery.clear();
  }
}
