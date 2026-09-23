import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createECDH, createHash, ECDH, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import webPush from 'web-push';
import type { PushSubscription, VapidKeys } from 'web-push';
import { record } from '../shared/protocol.ts';
import { BackendError } from './errors.ts';

const MAX_DEVICES = 64;
const MAX_STORAGE_BYTES = 256 * 1024;
const DEFAULT_SUBJECT = 'https://github.com/waksana/cockpit-notification';
export const WSL2_GUIDE_URL = 'https://github.com/waksana/cockpit/blob/main/docs/install.md#windows-wsl2';

export function unsupportedPlatformMessage(platform: string): string {
  return `Cockpit Notification requires Linux (current platform: ${platform}). On Windows, run Cockpit inside WSL2: ${WSL2_GUIDE_URL}`;
}
export interface Settings {
  pushDelayMs: number;
  vapidSubject?: string;
  extraPushHosts: string[];
}
export interface Device {
  id: string;
  subscription: PushSubscription;
}
interface Saved {
  version: 1;
  vapid: VapidKeys & { subject: string };
  subscriptions: PushSubscription[];
}

function literalHost(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && value === value.toLowerCase() &&
    value.includes('.') && !isIP(value) &&
    value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(value);
}

function subject(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash) ||
      (url.protocol === 'mailto:' && /^[^?@]+@[^?@]+\.[^?@]+$/.test(url.pathname) && !url.search && !url.hash);
  } catch { return false; }
}

export function settings(config: Readonly<Record<string, unknown>>): Settings {
  if (Object.keys(config).some(key => !['pushDelayMs', 'vapidSubject', 'extraPushHosts'].includes(key))) {
    throw new BackendError('INVALID_CONFIG', 'Unknown notification configuration field');
  }
  const pushDelayMs = config.pushDelayMs ?? 3000;
  if (!Number.isSafeInteger(pushDelayMs) || Number(pushDelayMs) < 0 || Number(pushDelayMs) > 60_000) {
    throw new BackendError('INVALID_CONFIG', 'pushDelayMs must be an integer from 0 to 60000');
  }
  if (config.vapidSubject !== undefined && !subject(config.vapidSubject)) {
    throw new BackendError('INVALID_CONFIG', 'vapidSubject must be a valid HTTPS or mailto contact');
  }
  const extraPushHosts = config.extraPushHosts ?? [];
  if (!Array.isArray(extraPushHosts) || extraPushHosts.length > 16 || !extraPushHosts.every(literalHost)) {
    throw new BackendError('INVALID_CONFIG', 'extraPushHosts must contain at most 16 literal public DNS names');
  }
  return { pushDelayMs: Number(pushDelayMs), extraPushHosts: [...new Set(extraPushHosts)],
    ...(config.vapidSubject === undefined ? {} : { vapidSubject: config.vapidSubject as string }) };
}

function bytes(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return;
  const result = Buffer.from(value, 'base64url');
  if (result.length !== length || result.toString('base64url') !== value.replace(/=+$/, '')) return;
  return result;
}

export function validateEndpoint(value: unknown, extraHosts: readonly string[]): string {
  const invalid = () => new BackendError('INVALID_PUSH_ENDPOINT', 'Push endpoint is not an allowed HTTPS service');
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes(':') || authority.includes('@') || url.protocol !== 'https:' ||
      url.username || url.password || url.hash || value.includes('#') || url.port || !literalHost(url.hostname)) throw invalid();
  const host = url.hostname;
  if (host !== 'fcm.googleapis.com' && host !== 'updates.push.services.mozilla.com' &&
      !(host.endsWith('.push.apple.com') && host.length > '.push.apple.com'.length) &&
      !(host.endsWith('.notify.windows.com') && host.length > '.notify.windows.com'.length) && !extraHosts.includes(host)) {
    throw invalid();
  }
  if (url.href.length > 2048) throw invalid();
  return url.href;
}

export function validateSubscription(value: unknown, extraHosts: readonly string[]): PushSubscription {
  if (!record(value) || Object.keys(value).some(key => !['endpoint', 'keys', 'expirationTime'].includes(key)) ||
      !record(value.keys) || Object.keys(value.keys).some(key => !['p256dh', 'auth'].includes(key))) {
    throw new BackendError('INVALID_SUBSCRIPTION', 'Invalid push subscription');
  }
  const endpoint = validateEndpoint(value.endpoint, extraHosts);
  const publicKey = bytes(value.keys.p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !bytes(value.keys.auth, 16)) {
    throw new BackendError('INVALID_SUBSCRIPTION_KEYS', 'Invalid push subscription keys');
  }
  try { ECDH.convertKey(publicKey, 'prime256v1'); }
  catch { throw new BackendError('INVALID_SUBSCRIPTION_KEYS', 'Invalid push subscription keys'); }
  if (value.expirationTime !== undefined && value.expirationTime !== null &&
      (!Number.isSafeInteger(value.expirationTime) || Number(value.expirationTime) < 0)) {
    throw new BackendError('INVALID_SUBSCRIPTION', 'Invalid push subscription expiration');
  }
  return { endpoint, keys: { p256dh: publicKey.toString('base64url'),
    auth: bytes(value.keys.auth, 16)!.toString('base64url') },
  ...(value.expirationTime === undefined ? {} : { expirationTime: value.expirationTime as number | null }) };
}

export function subscriptionId(subscription: PushSubscription): string {
  return createHash('sha256').update(subscription.endpoint).digest('hex');
}

function privateStat(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) ||
      (!directory && stat.nlink !== 1)) {
    throw new BackendError('UNSAFE_STORAGE', 'Notification storage must be private, owned and not symlinked', 503);
  }
}

export class SubscriptionStore {
  #root: string;
  #rootIdentity: string;
  #path: string;
  #settings: Settings;
  #saved: Saved;
  #closed = false;
  #devices: Map<string, PushSubscription>;

  constructor(dataRoot: string, config: Settings) {
    this.#settings = config;
    // The POSIX ownership/mode and O_NOFOLLOW guarantees below only hold on Linux.
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
      throw new BackendError('UNSUPPORTED_PLATFORM', unsupportedPlatformMessage(process.platform), 503);
    }
    try {
      if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot) {
        throw new BackendError('UNSAFE_STORAGE', 'Notification storage requires a canonical absolute directory', 503);
      }
      const parts: string[] = [];
      let current = dataRoot;
      while (current !== parse(current).root) { parts.unshift(current); current = dirname(current); }
      for (const part of parts) {
        if (part === dataRoot && !existsSync(part)) mkdirSync(part, { mode: 0o700 });
        if (lstatSync(part).isSymbolicLink()) {
          throw new BackendError('UNSAFE_STORAGE', 'Notification storage cannot traverse symlinks', 503);
        }
      }
      this.#root = dataRoot;
      const stat = lstatSync(dataRoot);
      privateStat(stat, true);
      this.#rootIdentity = `${stat.dev}:${stat.ino}`;
      this.#path = join(dataRoot, 'push-config.json');
      let saved: unknown;
      try {
        const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const file = fstatSync(fd);
          privateStat(file, false);
          if (file.size > MAX_STORAGE_BYTES) throw new BackendError('INVALID_STORAGE', 'Notification configuration exceeds size limit', 503);
          saved = JSON.parse(readFileSync(fd, 'utf8'));
        } finally { closeSync(fd); }
      } catch (error) {
        if (!record(error) || error.code !== 'ENOENT') throw error;
      }
      if (saved === undefined) {
        this.#saved = { version: 1, vapid: { ...webPush.generateVAPIDKeys(),
          subject: config.vapidSubject ?? DEFAULT_SUBJECT }, subscriptions: [] };
        this.#persist(this.#saved);
      } else {
        this.#saved = this.#validateSaved(saved);
        if (config.vapidSubject !== undefined && config.vapidSubject !== this.#saved.vapid.subject) {
          const changed = { ...this.#saved, vapid: { ...this.#saved.vapid, subject: config.vapidSubject } };
          this.#persist(changed);
          this.#saved = changed;
        }
      }
      this.#devices = new Map(this.#saved.subscriptions.map(subscription => [subscriptionId(subscription), subscription]));
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError('STORAGE_UNAVAILABLE', 'Notification private configuration could not be loaded', 503);
    }
  }

  get vapid(): Saved['vapid'] { return { ...this.#saved.vapid }; }

  #validateSaved(saved: unknown): Saved {
    try {
      if (!record(saved) || saved.version !== 1 || !record(saved.vapid) || !subject(saved.vapid.subject) ||
          !bytes(saved.vapid.publicKey, 65) || !bytes(saved.vapid.privateKey, 32) ||
          !Array.isArray(saved.subscriptions) || saved.subscriptions.length > MAX_DEVICES) throw new Error();
      const pair = createECDH('prime256v1');
      pair.setPrivateKey(bytes(saved.vapid.privateKey, 32)!);
      if (!pair.getPublicKey().equals(bytes(saved.vapid.publicKey, 65)!)) throw new Error();
      const subscriptions = saved.subscriptions.map(value => validateSubscription(value, this.#settings.extraPushHosts));
      if (new Set(subscriptions.map(subscriptionId)).size !== subscriptions.length) throw new Error();
      return { version: 1, vapid: { publicKey: saved.vapid.publicKey as string,
        privateKey: saved.vapid.privateKey as string, subject: saved.vapid.subject }, subscriptions };
    } catch {
      throw new BackendError('INVALID_STORAGE', 'Existing notification configuration is invalid; refusing to replace it', 503);
    }
  }

  #persist(saved: Saved): void {
    let pending: string | undefined;
    try {
      if (this.#closed) throw new BackendError('STOPPED', 'Notification module is stopped', 503);
      const root = lstatSync(this.#root);
      privateStat(root, true);
      if (`${root.dev}:${root.ino}` !== this.#rootIdentity) throw new Error();
      try { privateStat(lstatSync(this.#path), false); }
      catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
      const serialized = JSON.stringify(saved);
      if (Buffer.byteLength(serialized) > MAX_STORAGE_BYTES) throw new Error();
      pending = join(this.#root, `.push-config-${randomUUID()}.pending`);
      const fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(pending, this.#path);
      pending = undefined;
      const directory = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError('STORAGE_WRITE_FAILED', 'Notification configuration could not be saved', 503);
    } finally {
      if (pending) {
        try { unlinkSync(pending); }
        catch (error) {
          if (!record(error) || error.code !== 'ENOENT') {
            throw new BackendError('STORAGE_CLEANUP_FAILED', 'Notification configuration cleanup failed', 503);
          }
        }
      }
    }
  }

  register(value: unknown, now: number): string {
    const subscription = validateSubscription(value, this.#settings.extraPushHosts);
    if (subscription.expirationTime != null && subscription.expirationTime <= now) {
      throw new BackendError('EXPIRED_SUBSCRIPTION', 'Push subscription has expired');
    }
    const id = subscriptionId(subscription);
    if (!this.#devices.has(id) && this.#devices.size >= MAX_DEVICES) {
      throw new BackendError('SUBSCRIPTION_CAPACITY', 'Push subscription capacity reached', 409);
    }
    const devices = new Map(this.#devices);
    devices.set(id, subscription);
    const saved = { ...this.#saved, subscriptions: [...devices.values()] };
    this.#persist(saved);
    this.#saved = saved;
    this.#devices = devices;
    return id;
  }

  remove(id: string): void {
    if (!this.#devices.has(id)) return;
    const devices = new Map(this.#devices);
    devices.delete(id);
    const saved = { ...this.#saved, subscriptions: [...devices.values()] };
    this.#persist(saved);
    this.#saved = saved;
    this.#devices = devices;
  }

  active(now: number): Device[] {
    return [...this.#devices].filter(([, subscription]) =>
      subscription.expirationTime == null || subscription.expirationTime > now)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, subscription]) => ({ id, subscription: { ...subscription, keys: { ...subscription.keys } } }));
  }

  registered(id: string, now: number): boolean { return this.active(now).some(device => device.id === id); }
  close(): void { this.#closed = true; }
}
