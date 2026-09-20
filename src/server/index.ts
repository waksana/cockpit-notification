import type { ModuleBackend, ModuleBackendContext, ModuleRequest, ModuleResponse, ModuleRoute,
  ServerEvent } from '@cockpit/module-api';
import { identity, keyId, MAX_BATCH, MAX_IDENTITIES, parseKeys, record, type MessageKey } from '../shared/protocol.ts';
import { finalReply } from './final-reply.ts';
import { BackendError, safeError } from './errors.ts';
import { Ledger, type Change } from './ledger.ts';
import { networkSender, PushScheduler, systemClock, type Clock, type Sender } from './push.ts';
import { settings, SubscriptionStore } from './storage.ts';
import { unreadEvent } from './unread-events.ts';
import { notificationExcerpt, sessionTitle, type NotificationPreview } from './preview.ts';

export interface BackendDependencies {
  clock?: Clock;
  sender?: Sender;
}
const headers = { 'cache-control': 'private, no-store', 'pragma': 'no-cache' };
const askKey = (sessionId: string, nativeId: string): MessageKey => ({ sessionId, kind: 'ask', nativeId });

export function activate(context: ModuleBackendContext, dependencies: BackendDependencies = {}): ModuleBackend {
  if (context.signal.aborted) throw new BackendError('STOPPED', 'Notification module is stopped', 503);
  if (typeof context.publish !== 'function') {
    throw new BackendError('HOST_EVENTS_UNAVAILABLE', 'Notification deltas require the paired host module-event transport', 503);
  }
  const config = settings(context.config);
  const clock = dependencies.clock ?? systemClock;
  const store = new SubscriptionStore(context.dataRoot, config);
  const ledger = new Ledger();
  const asks = new Map<string, string>();
  const titles = new Map<string, string>();
  const removedSessions = new Set<string>();
  let stopped = false;
  const report = (error: unknown): void => {
    if (stopped) return;
    try { context.report(safeError(error)); } catch { /* Reporting must not alter committed ledger state. */ }
  };
  const pushes = new PushScheduler(ledger, store, clock, dependencies.sender ?? networkSender(store),
    config.pushDelayMs, report, sessionId => titles.get(sessionId));

  function active(): void {
    if (stopped || context.signal.aborted) throw new BackendError('STOPPED', 'Notification module is stopped', 503);
  }
  function changed(change: Change, previews: readonly NotificationPreview[] = []): void {
    const summaries = new Map(previews.map(({ key, summary }) => [keyId(key), summary]));
    for (const key of change.removed) pushes.cancel(key);
    for (const entry of change.added) pushes.schedule(entry, summaries.get(keyId(entry.key)));
    if (change.changed) {
      try { context.publish(unreadEvent(change.delta)); }
      catch { report(new BackendError('PUBLICATION_FAILED', 'Committed unread change could not be published', 503)); }
    }
  }
  function rememberTitle(id: string, value: string): void {
    if (removedSessions.has(id)) return;
    if (!identity(id)) throw new BackendError('INVALID_IDENTITY', 'Invalid session identity');
    const title = sessionTitle(value);
    if (!title) { titles.delete(id); return; }
    if (!titles.has(id) && titles.size >= MAX_IDENTITIES) {
      throw new BackendError('TITLE_CAPACITY', 'Notification title capacity reached; restart required', 503);
    }
    titles.set(id, title);
  }
  function retireSession(sessionId: string): void {
    const ask = asks.get(sessionId);
    const keys = [...ledger.keysForSession(sessionId), ...(ask ? [askKey(sessionId, ask)] : [])];
    changed(ledger.transition([], keys));
    asks.delete(sessionId);
  }
  function control(event: ServerEvent): void {
    active();
    if (event.type === 'snapshot') {
      for (const session of event.sessions) rememberTitle(session.sessionId, session.title);
      return;
    }
    if (event.type === 'session/removed') {
      if (!identity(event.sessionId)) throw new BackendError('INVALID_IDENTITY', 'Invalid session identity');
      if (!removedSessions.has(event.sessionId) && removedSessions.size >= MAX_IDENTITIES) {
        throw new BackendError('IDENTITY_CAPACITY', 'Retired session capacity reached; restart required', 503);
      }
      retireSession(event.sessionId);
      titles.delete(event.sessionId);
      removedSessions.add(event.sessionId);
      return;
    }
    if (event.type === 'chat/invalidated') {
      if (event.reason === 'rewind') retireSession(event.sessionId);
      return;
    }
    if (event.type !== 'session/added' && event.type !== 'session/patch') return;
    const session = event.type === 'session/added' ? event.session : event;
    if (typeof session.title === 'string') rememberTitle(session.sessionId, session.title);
    if (!Object.hasOwn(session, 'ask') || removedSessions.has(session.sessionId)) return;
    if (!identity(session.sessionId) || (session.ask !== null &&
        (!record(session.ask) || !identity(session.ask.requestId) || typeof session.ask.question !== 'string'))) {
      throw new BackendError('INVALID_ASK', 'Invalid live ask identity');
    }
    const previous = asks.get(session.sessionId);
    const next = session.ask?.requestId;
    if (previous === next) return;
    if (next && !asks.has(session.sessionId) && asks.size >= MAX_IDENTITIES) {
      throw new BackendError('IDENTITY_CAPACITY', 'Active ask capacity reached; restart required', 503);
    }
    const change = ledger.transition(next ? [askKey(session.sessionId, next)] : [],
      previous ? [askKey(session.sessionId, previous)] : []);
    if (next) asks.set(session.sessionId, next);
    else asks.delete(session.sessionId);
    changed(change, next && session.ask ? [{
      key: askKey(session.sessionId, next), summary: notificationExcerpt(session.ask.question),
    }] : []);
  }
  function route(method: ModuleRoute['method'], path: string,
    handler: (request: ModuleRequest) => ModuleResponse, json = false): ModuleRoute {
    return { method, path, ...(json ? { body: 'json' as const, bodyLimit: path === '/read' ? 256 * 1024 : 4096 } : {}),
      handler(request) {
        try {
          active();
          if (request.signal.aborted) throw new BackendError('REQUEST_ABORTED', 'Notification request was cancelled', 499);
          return { ...handler(request), headers };
        } catch (error) {
          const safe = safeError(error);
          return { status: safe.status, headers, body: { code: safe.code, message: safe.message } };
        }
      } };
  }
  function deviceId(request: ModuleRequest): string {
    const id = request.params.id;
    if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new BackendError('INVALID_SUBSCRIPTION_ID', 'Invalid subscription identity');
    return id;
  }
  const dispose = (): void => {
    if (stopped) return;
    stopped = true;
    context.signal.removeEventListener('abort', dispose);
    pushes.stop();
    ledger.dispose();
    store.close();
    asks.clear();
    titles.clear();
    removedSessions.clear();
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  return {
    publicConfig: { vapidPublicKey: store.vapid.publicKey, readDelayMs: 600, pushDelayMs: config.pushDelayMs, maxBatch: MAX_BATCH },
    routes: [
      route('GET', '/state', () => ({ body: ledger.snapshot() })),
      route('POST', '/read', request => {
        if (!record(request.body) || !identity(request.body.generation) ||
            Object.keys(request.body).some(key => !['generation', 'keys'].includes(key))) {
          throw new BackendError('INVALID_READ', 'Expected generation and a bounded array of message keys');
        }
        let keys: MessageKey[];
        try { keys = parseKeys(request.body.keys); }
        catch { throw new BackendError('INVALID_READ_BATCH', `Read batch must contain 1 to ${MAX_BATCH} valid message keys`); }
        const { result, change } = ledger.read(request.body.generation, keys);
        changed(change);
        return { body: result };
      }, true),
      route('POST', '/subscriptions', request => {
        if (!record(request.body) || Object.keys(request.body).length !== 1 || !Object.hasOwn(request.body, 'subscription')) {
          throw new BackendError('INVALID_SUBSCRIPTION', 'Expected one push subscription');
        }
        const id = store.register(request.body.subscription, clock.now());
        return { body: { id, generation: ledger.generation, state: ledger.snapshot() } };
      }, true),
      route('GET', '/subscriptions/:id', request =>
        ({ body: { registered: store.registered(deviceId(request), clock.now()) } })),
      route('DELETE', '/subscriptions/:id', request => {
        const id = deviceId(request);
        store.remove(id);
        pushes.cancelSubscription(id);
        return { status: 204 };
      }),
    ],
    events: {
      types: ['assistant.message'],
      handle(observation) {
        if (stopped || context.signal.aborted || removedSessions.has(observation.sessionId)) return;
        try {
          const reply = finalReply(observation);
          if (reply) changed(ledger.transition([reply.key]), [reply]);
        }
        catch (error) { report(error); }
      },
    },
    controlEvents: {
      types: ['snapshot', 'session/added', 'session/patch', 'session/removed', 'chat/invalidated'],
      handle(event) {
        if (stopped || context.signal.aborted) return;
        try { control(event); } catch (error) { report(error); }
      },
    },
    dispose,
  };
}

export default activate;
