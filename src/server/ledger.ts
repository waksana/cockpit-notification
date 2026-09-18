import { randomUUID } from 'node:crypto';
import {
  MAX_IDENTITIES, MAX_UNREAD, keyId, parseKey,
  type MessageKey, type ReadResult, type Snapshot,
} from '../shared/protocol.ts';
import { BackendError } from './errors.ts';

export interface Entry {
  key: MessageKey;
  createdRevision: number;
}
export interface Change {
  changed: boolean;
  added: Entry[];
  removed: MessageKey[];
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export class Ledger {
  readonly generation: string;
  #revision = 0;
  #unread = new Map<string, Entry>();
  #acknowledged = new Set<string>();
  #limits: { unread: number; identities: number };
  #stopped = false;

  constructor(limits = { unread: MAX_UNREAD, identities: MAX_IDENTITIES }) {
    this.generation = randomUUID();
    this.#limits = limits;
  }

  get(key: MessageKey): Entry | undefined {
    const entry = this.#unread.get(keyId(key));
    return entry ? { key: { ...entry.key }, createdRevision: entry.createdRevision } : undefined;
  }

  keysForSession(sessionId: string): MessageKey[] {
    return [...this.#unread.values()].filter(entry => entry.key.sessionId === sessionId)
      .map(entry => ({ ...entry.key }));
  }

  transition(newKeys: readonly MessageKey[], retireKeys: readonly MessageKey[] = []): Change {
    this.#active();
    let additions: Map<string, MessageKey>;
    let retirements: Map<string, MessageKey>;
    try {
      additions = new Map(newKeys.map(value => { const key = parseKey(value); return [keyId(key), key]; }));
      retirements = new Map(retireKeys.map(value => { const key = parseKey(value); return [keyId(key), key]; }));
    } catch {
      throw new BackendError('INVALID_IDENTITY', 'Invalid message identity');
    }
    const newIdentities = new Set([...additions.keys(), ...retirements.keys()].filter(
      id => !this.#unread.has(id) && !this.#acknowledged.has(id),
    ));
    if (this.#unread.size + this.#acknowledged.size + newIdentities.size > this.#limits.identities) {
      throw new BackendError('IDENTITY_CAPACITY', 'Notification identity capacity reached; restart required', 503);
    }
    const removed = [...retirements].filter(([id]) => this.#unread.has(id)).map(([, key]) => key);
    const addedKeys = [...additions].filter(([id]) =>
      !this.#unread.has(id) && !this.#acknowledged.has(id) && !retirements.has(id)).map(([, key]) => key);
    if (this.#unread.size - removed.length + addedKeys.length > this.#limits.unread) {
      throw new BackendError('UNREAD_CAPACITY', 'Unread notification capacity reached', 503);
    }
    const changed = addedKeys.length > 0 || [...retirements.keys()].some(id => !this.#acknowledged.has(id));
    if (!changed) return { changed: false, added: [], removed: [] };
    if (this.#revision === Number.MAX_SAFE_INTEGER) {
      throw new BackendError('REVISION_CAPACITY', 'Notification revision capacity reached; restart required', 503);
    }
    this.#revision++;
    for (const [id] of retirements) {
      this.#unread.delete(id);
      this.#acknowledged.add(id);
    }
    const added = addedKeys.map(key => ({ key, createdRevision: this.#revision }));
    for (const entry of added) this.#unread.set(keyId(entry.key), entry);
    return { changed: true, added: added.map(entry => ({ ...entry, key: { ...entry.key } })), removed };
  }

  read(generation: string, keys: readonly MessageKey[]): { result: ReadResult; change: Change } {
    this.#active();
    if (generation !== this.generation) {
      throw new BackendError('GENERATION_MISMATCH', 'Notification generation changed; refresh state', 409);
    }
    const change = this.transition([], keys);
    const acknowledged = [...new Map(keys.map(key => [keyId(key), { ...key }])).values()];
    return { change, result: { acknowledged, state: this.snapshot() } };
  }

  snapshot(): Snapshot {
    this.#active();
    const sessions: Snapshot['sessions'] = [];
    const entries = [...this.#unread.values()].sort((a, b) =>
      compare(a.key.sessionId, b.key.sessionId) || compare(a.key.kind, b.key.kind) ||
      compare(a.key.nativeId, b.key.nativeId));
    for (const { key, createdRevision } of entries) {
      let session = sessions.at(-1);
      if (!session || session.sessionId !== key.sessionId) {
        session = { sessionId: key.sessionId, count: 0, items: [] };
        sessions.push(session);
      }
      session.items.push({ kind: key.kind, nativeId: key.nativeId, createdRevision });
      session.count++;
    }
    return { generation: this.generation, revision: this.#revision, complete: true,
      total: this.#unread.size, sessions };
  }

  dispose(): void {
    this.#stopped = true;
    this.#unread.clear();
    this.#acknowledged.clear();
  }

  #active(): void {
    if (this.#stopped) throw new BackendError('STOPPED', 'Notification module is stopped', 503);
  }
}
