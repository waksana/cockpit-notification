import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import type { ActivateFrontend, MessageProps, ModuleFrontend, ModuleFrontendContext, ModuleStateRegistration } from '@cockpit/module-api';
import type { ComponentType, RefCallback } from 'react';
import type { MessageKey, Snapshot, UnreadEvent } from '../shared/protocol.ts';
import { keyId } from '../shared/protocol.ts';
import type { UnreadStore } from './store.ts';
import type { DeviceBridge, DeviceStatus } from './device.ts';

const compiled = (await build({ entryPoints: [fileURLToPath(new URL('./index.tsx', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' })).outputFiles[0]!.text;
const { activate } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as { activate: ActivateFrontend };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
interface Element { type: unknown; props: Record<string, unknown> }
const base: Snapshot = { generation: 'generation-a', revision: 1, complete: true, total: 1, sessions: [{
  sessionId: 'session-a', count: 1, items: [{ kind: 'reply', nativeId: 'reply-a', createdRevision: 1 }],
}] };
const props: MessageProps = {
  identity: { sessionId: 'session-a', kind: 'message', id: 'reply-a', role: 'assistant' }, complete: true,
};
function fixture(t: { after(fn: () => void): void }, initial = base) {
  let current = initial;
  let focus = true;
  let obstructed = false;
  let visible = true;
  let connected = true;
  let sessionId = 'session-a';
  let autoDelta = true;
  let inert = false;
  let rect = { top: 20, left: 10, right: 290, bottom: 220, height: 200, width: 280 };
  const errors: unknown[] = [];
  const calls: { path: string; init?: RequestInit }[] = [];
  const restorers: (() => void)[] = [];
  const viewListeners = new Set<() => void>();
  let invalidate = () => {};
  let onEvent = (_event: UnreadEvent) => {};
  let invalidationSubscriptions = 0;
  let eventSubscriptions = 0;
  const documentListeners = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  const resizes = new Set<() => void>();
  const observedElements: HTMLElement[] = [];
  const serviceDisposals: string[] = [];
  const services: { id: string; instance: object; active: boolean; dispose(): void }[] = [];
  const windowListeners = new EventTarget();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const events = (target: EventTarget) => ({
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener); target.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener); target.removeEventListener(type, listener);
    },
  });
  let nextFrame = 0;
  const replace = (name: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restorers.push(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  };
  class FakeElement {
    isConnected = true;
    parentElement = null;
    contains(other: unknown) { return other === this; }
    closest() { return inert ? this : null; }
    getBoundingClientRect() { return rect; }
  }
  const element = new FakeElement() as unknown as HTMLDivElement;
  const body = {};
  replace('HTMLElement', FakeElement);
  replace('location', new URL('https://host.test/deployment/session/session-a'));
  replace('navigator', { onLine: true });
  replace('document', {
    body, get visibilityState() { return visible ? 'visible' : 'hidden'; },
    hasFocus: () => focus, elementFromPoint: () => obstructed ? null : element,
    ...events(documentListeners),
  });
  replace('window', { innerHeight: 600, innerWidth: 300,
    ...events(windowListeners),
  });
  replace('getComputedStyle', () => ({ visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', overflowY: 'visible' }));
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  replace('cancelAnimationFrame', (id: number) => frames.delete(id));
  let observed = 0;
  replace('IntersectionObserver', class {
    callback: (entries: unknown[]) => void;
    constructor(callback: (entries: unknown[]) => void) { this.callback = callback; }
    observe(target: HTMLElement) {
      observed++; observedElements.push(target); this.callback([{ target, isIntersecting: true, intersectionRect: rect }]);
    }
    disconnect() {}
  });
  replace('ResizeObserver', class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; }
    observe() { resizes.add(this.callback); }
    disconnect() { resizes.delete(this.callback); }
  });
  const hooks = {
    refs: [] as { current: unknown }[], effects: [] as { deps: unknown[]; cleanup?: () => void }[],
    callbacks: [] as { callback: unknown; deps: unknown[] }[],
    states: [] as unknown[], ref: 0, effect: 0, state: 0, callback: 0, dirty: false,
  };
  const effects: (() => void)[] = [];
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type: unknown, attributes: Record<string, unknown> | null, ...children: unknown[]): Element {
      return { type, props: { ...attributes, ...(children.length ? { children } : {}) } };
    },
    useRef(value: unknown) { return hooks.refs[hooks.ref++] ??= { current: value }; },
    useId() { return 'synthetic-settings-heading'; },
    useState(value: unknown) {
      const index = hooks.state++;
      if (!(index in hooks.states)) hooks.states[index] = value;
      return [hooks.states[index], (next: unknown) => {
        if (!Object.is(hooks.states[index], next)) hooks.dirty = true;
        hooks.states[index] = next;
      }];
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const index = hooks.callback++;
      const previous = hooks.callbacks[index];
      if (previous && previous.deps.length === deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]))) {
        return previous.callback;
      }
      hooks.callbacks[index] = { callback, deps };
      return callback;
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const index = hooks.effect++;
      const previous = hooks.effects[index];
      if (previous && previous.deps.length === deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
      const entry = { deps, cleanup: undefined as (() => void) | undefined };
      hooks.effects[index] = entry;
      effects.push(() => { previous?.cleanup?.(); entry.cleanup = effect() || undefined; });
    },
    useLayoutEffect(effect: () => (() => void) | void, deps: unknown[]) { React.useEffect(effect, deps); },
  };
  const controller = new AbortController();
  const context = {
    apiVersion: 2, uiVersion: 1, uiSurfaceVersion: 1, menuVersion: 1, moduleId: 'cockpit-notification', react: React,
    apiBase: `https://host.test/deployment/_modules/cockpit-notification/${'a'.repeat(64)}/api`,
    config: { readDelayMs: 600, pushDelayMs: 3000, maxBatch: 128 },
    signal: controller.signal, report: (error: unknown) => errors.push(error),
    createPortal: (children: unknown, target: unknown) => {
      assert.equal(target, body); return { type: 'portal', props: { children: [children] } };
    },
    state: {
      host: {
        getSnapshot: () => Object.freeze({ sessionId, visible, connected }),
        subscribe: (listener: () => void) => { viewListeners.add(listener); return () => viewListeners.delete(listener); },
      },
      register<Service extends object>(registration: ModuleStateRegistration<Service>) {
        assert.equal(calls.length, 0, 'all services are registered before starting their actions');
        assert.ok(services.every(service => service.id !== registration.id));
        const instance = registration.create();
        const disposable = instance as Service & { dispose(): void };
        const dispose = disposable.dispose.bind(disposable);
        disposable.dispose = () => { serviceDisposals.push(registration.id); dispose(); };
        const service = { id: registration.id, instance, active: true, dispose: () => registration.dispose(instance) };
        services.push(service);
        return { id: registration.id, get() {
          assert.equal(service.active, true, 'revoked services cannot be retrieved');
          return instance;
        } };
      },
    },
    onInvalidate: (listener: () => void) => {
      invalidationSubscriptions++; invalidate = listener; return () => { invalidate = () => {}; };
    },
    onEvent: (listener: (event: UnreadEvent) => void) => {
      assert.equal(calls.length, 0, 'typed event subscription precedes the initial GET');
      eventSubscriptions++;
      onEvent = listener;
      return () => { eventSubscriptions--; onEvent = () => {}; };
    },
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/read') {
        const request = JSON.parse(String(init!.body));
        const fromRevision = current.revision;
        const requested = new Set((request.keys as MessageKey[]).map(keyId));
        const removed = current.sessions.flatMap(session => session.items.map(item => ({
          sessionId: session.sessionId, kind: item.kind, nativeId: item.nativeId,
        }))).filter(key => requested.has(keyId(key)));
        const sessions = current.sessions.map(session => {
          const items = session.items.filter(item => !requested.has(keyId({ sessionId: session.sessionId, ...item })));
          return { ...session, items, count: items.length };
        }).filter(session => session.count > 0);
        current = { ...current, revision: current.revision + (removed.length ? 1 : 0),
          total: current.total - removed.length, sessions };
        if (autoDelta && removed.length) onEvent({ type: 'unread/delta', generation: current.generation,
          fromRevision, revision: current.revision, added: [], removed });
        return Response.json({ acknowledged: request.keys, generation: current.generation, revision: current.revision });
      }
      return Response.json(current);
    },
  } as unknown as ModuleFrontendContext;
  let mountedRef: RefCallback<HTMLDivElement> | undefined;
  let mountedElement: HTMLDivElement | null = null;
  let refCleanup: (() => void) | void;
  const detachRef = () => {
    if (refCleanup) refCleanup(); else mountedRef?.(null);
    mountedRef = undefined; mountedElement = null; refCleanup = undefined;
  };
  const unmount = () => {
    detachRef();
    hooks.effects.forEach(effect => effect.cleanup?.());
    effects.length = 0;
    hooks.effects = []; hooks.refs = []; hooks.states = []; hooks.callbacks = [];
  };
  const disposeServices = () => {
    const live = services.filter(service => service.active).reverse();
    live.forEach(service => { service.active = false; });
    live.forEach(service => service.dispose());
  };
  const Base = (() => null) as ComponentType<MessageProps>;
  let message: ComponentType<MessageProps> | undefined;
  const render = (component: unknown, values: unknown): Element | null => {
    hooks.ref = 0; hooks.effect = 0; hooks.state = 0; hooks.callback = 0; hooks.dirty = false;
    return (component as (props: unknown) => Element | null)(values);
  };
  const flushEffects = () => { effects.splice(0).forEach(effect => effect()); };
  const renderMessage = (frontend: ModuleFrontend, values: MessageProps = props, target: HTMLDivElement | null = element): Element => {
    message ??= frontend.components!.find(component => component.boundary === 'message')!.wrap(Base);
    let result: Element;
    let iterations = 0;
    do {
      assert.ok(iterations++ < 10, 'body-ref and measurement state converge');
      result = render(message, values)!;
      assert.equal(result.type, Base, 'message middleware returns Base, never a DOM wrapper');
      const ref = result.props.bodyRef as RefCallback<HTMLDivElement>;
      if (ref !== mountedRef || target !== mountedElement) {
        detachRef();
        mountedRef = ref; mountedElement = target;
        refCleanup = ref(target);
      }
      flushEffects();
    } while (hooks.dirty);
    return result;
  };
  const marker = (frontend: ModuleFrontend, values: MessageProps = props): Element | null => {
    const result = renderMessage(frontend, values);
    return ((result.props.adornment as Element | undefined)?.props.children as Element[] | undefined)?.at(-1) ?? null;
  };
  t.after(() => { unmount(); controller.abort(); disposeServices(); restorers.reverse().forEach(restore => restore()); });
  return { context, element, calls, errors, controller, services, serviceDisposals, disposeServices,
    observedElements, renderMessage, marker, Base,
    listeners: () => viewListeners.size + listeners.size,
    observed: () => observed, invalidate: () => invalidate(),
    event: (value: UnreadEvent) => onEvent(value),
    subscriptions: () => ({ events: eventSubscriptions, invalidations: invalidationSubscriptions }),
    setAutoDelta: (value: boolean) => { autoDelta = value; },
    setSession(value: string) { sessionId = value; for (const listener of viewListeners) listener(); },
    unmount, setFocus: (value: boolean) => {
      focus = value; windowListeners.dispatchEvent(new Event(value ? 'focus' : 'blur'));
    }, setObstructed: (value: boolean) => { obstructed = value; },
    setInert: (value: boolean) => { inert = value; }, setRect: (value: typeof rect) => { rect = value; },
    resize() { for (const resize of resizes) resize(); },
    setVisible(value: boolean) { visible = value; documentListeners.dispatchEvent(new Event('visibilitychange')); },
    setConnected(value: boolean) { connected = value; for (const listener of viewListeners) listener(); },
    frame(now: number) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
    render, flushEffects,
  };
}

test('frontend registers concrete services and v2 middleware; unsupported push keeps unread highlights working', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  assert.deepEqual(Object.keys(frontend).sort(), ['apiVersion', 'components', 'dispose', 'menus']);
  assert.equal(frontend.apiVersion, 2);
  assert.deepEqual(frontend.components?.map(component => component.boundary),
    ['message', 'sessionStatus']);
  assert.deepEqual(frontend.menus?.map(entry => entry.menu), ['global']);
  assert.deepEqual(f.services.map(service => [service.id, service.instance.constructor.name]),
    [['device-bridge', 'DeviceBridge'], ['unread-store', 'UnreadStore']]);
  const ids = [...f.services, ...frontend.components!, ...frontend.menus!].map(registration => registration.id);
  assert.equal(new Set(ids).size, ids.length);
  const line = f.marker(frontend);
  assert.equal(line?.type, 'span');
  assert.equal(line?.props.className, 'cn-unread-label');
  assert.equal(line?.props.role, 'img');
  assert.equal(line?.props['aria-label'], '未读消息');
  assert.equal(line?.props['aria-hidden'], undefined);
  assert.equal(line?.props.tabIndex, undefined);
  assert.equal(line?.props.onClick, undefined);
  assert.equal(f.renderMessage(frontend).props.className, 'cn-message-highlight cn-unread');
  assert.doesNotMatch(compiled, /createRoot|react\/jsx-runtime|querySelector|localStorage|sessionStorage|module-message-decorations|module-global-actions/);
  assert.doesNotMatch(compiled, /messageDecorations|sessionBadges|surfaceVersion|context\.view/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.subscriptions(), { events: 1, invalidations: 0 });
});

test('message middleware preserves inherited body refs, children, adornments and ordinary HTML props without wrappers', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const ref = { current: null as HTMLDivElement | null };
  const children = { type: 'strong', props: { children: 'native message' } };
  const adornment = { type: 'span', props: { className: 'inherited-adornment' } };
  const onClick = () => {};
  const values = { ...props, bodyRef: ref, children, adornment, className: 'native-body',
    style: { position: 'relative' as const }, onClick, 'aria-label': 'native body' } as unknown as MessageProps;
  const result = f.renderMessage(frontend, values);
  assert.equal(ref.current, f.element);
  for (const key of ['identity', 'complete', 'children', 'style', 'onClick', 'aria-label'] as const) {
    assert.equal(result.props[key], values[key]);
  }
  assert.equal(result.props.className, 'native-body cn-message-highlight cn-unread');
  const composed = result.props.adornment as Element;
  assert.equal(typeof composed.type, 'symbol');
  assert.equal((composed.props.children as unknown[])[0], adornment);
  assert.equal((composed.props.children as Element[])[1]!.props.className, 'cn-unread-label');
  assert.deepEqual(f.observedElements, [f.element]);
  assert.equal(f.renderMessage(frontend, values).props.bodyRef, result.props.bodyRef, 'ref identity is stable on ordinary rerenders');
  assert.equal(f.services.length, 2, 'renders never create services or duplicate ledger state');
  assert.equal(f.calls.length, 1);
  f.unmount();
  assert.equal(ref.current, null);
});

test('callback refs retain React cleanup semantics and observations follow body replacement and unmount', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const assigned: (HTMLDivElement | null)[] = [];
  let cleanups = 0;
  const bodyRef = (element: HTMLDivElement | null) => { assigned.push(element); return () => { cleanups++; }; };
  f.renderMessage(frontend, { ...props, bodyRef });
  const replacement = Object.assign(Object.create(Object.getPrototypeOf(f.element)), {
    isConnected: true, parentElement: null,
  }) as HTMLDivElement;
  f.renderMessage(frontend, { ...props, bodyRef }, replacement);
  assert.deepEqual(assigned, [f.element, replacement]);
  assert.equal(cleanups, 1);
  assert.deepEqual(f.observedElements, [f.element, replacement]);
  f.unmount();
  assert.equal(cleanups, 2);
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1, 'unmounted/replaced body cannot acknowledge through a leftover observer');
});

test('null-callback refs are composed on ref replacement, and absent bodies are never observed', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const assigned: (HTMLDivElement | null)[] = [];
  const bodyRef = (element: HTMLDivElement | null) => { assigned.push(element); };
  f.renderMessage(frontend, { ...props, bodyRef }, null);
  assert.deepEqual(f.observedElements, []);
  f.renderMessage(frontend, { ...props, bodyRef });
  assert.equal(assigned.at(-1), f.element);
  const inherited = { current: null as HTMLDivElement | null };
  f.renderMessage(frontend, { ...props, bodyRef: inherited });
  assert.equal(assigned.at(-1), null);
  assert.equal(inherited.current, f.element);
  f.unmount();
  assert.equal(inherited.current, null);
});

test('registered state disposal is host-owned and module cleanup only unsubscribes its listeners', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  assert.equal(f.listeners(), 3);
  f.unmount();
  frontend.dispose?.();
  frontend.dispose?.();
  f.controller.abort();
  assert.equal(f.listeners(), 0);
  assert.equal(f.subscriptions().events, 0);
  assert.deepEqual(f.serviceDisposals, [], 'module cleanup must not invoke host-owned service disposal');
  f.disposeServices();
  f.disposeServices();
  assert.deepEqual(f.serviceDisposals, ['unread-store', 'device-bridge']);
  f.invalidate();
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

test('short visible root assistant reply reads once after continuous 600ms and the receipt causes no redundant GET', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  f.frame(0); f.frame(599);
  assert.equal(f.calls.length, 1);
  f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init?.body)), {
    generation: 'generation-a', keys: [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' }],
  });
  assert.equal(f.marker(frontend), null);
  assert.equal(f.renderMessage(frontend).props.className, 'cn-message-highlight',
    'the transition class stays mounted when authoritative unread state clears');
});

test('only typed authority events remove highlights; HTTP receipt and generic invalidation leave them unchanged', async t => {
  const f = fixture(t);
  f.setAutoDelta(false);
  const frontend = await activate(f.context);
  await settle();
  const marker = f.marker(frontend);
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.marker(frontend), marker, 'POST receipt cannot change marker or its geometry');
  assert.equal(f.renderMessage(frontend).props.className, 'cn-message-highlight cn-unread');
  f.invalidate();
  assert.equal(f.calls.length, 2, 'notification does not subscribe to ordinary invalidations');
  f.event({ type: 'unread/delta', generation: base.generation, fromRevision: 1, revision: 2,
    added: [], removed: [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' }] });
  assert.equal(f.marker(frontend), null);
  assert.equal(f.renderMessage(frontend).props.className, 'cn-message-highlight');
  assert.equal(f.calls.length, 2);
});

test('compiled message middleware reads a continuously scrolling long block, not earlier messages or another session', async t => {
  const f = fixture(t, { ...base, total: 3, sessions: [
    { sessionId: 'session-a', count: 2, items: [
      { kind: 'reply', nativeId: 'earlier', createdRevision: 1 }, ...base.sessions[0]!.items,
    ] },
    { sessionId: 'session-b', count: 1, items: [{ kind: 'reply', nativeId: 'elsewhere', createdRevision: 1 }] },
  ] });
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  for (const now of [0, 100, 200, 300, 400, 500, 599]) {
    const top = -now * 4;
    f.setRect({ top, bottom: top + 4000, left: 10, right: 290, width: 280, height: 4000 });
    f.frame(now);
  }
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1, '599ms never queues a receipt');
  f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init?.body)).keys,
    [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' }]);
  const store = f.services.find(service => service.id === 'unread-store')!.instance as UnreadStore;
  assert.equal(store.getSnapshot().snapshot?.total, 2);
  assert.deepEqual(store.getSnapshot().snapshot?.sessions.map(session => [session.sessionId, session.count]), [
    ['session-a', 1], ['session-b', 1],
  ]);
  assert.equal(f.marker(frontend), null);
  f.frame(1200);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2, 'the same block cannot send a second receipt');
});

test('compiled middleware reads a short message with only a small visible ending', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.setRect({ top: -190, bottom: 10, left: 10, right: 290, width: 280, height: 200 });
  f.renderMessage(frontend);
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls[1]?.path, '/read');
});

for (const gate of ['session', 'focus', 'visibility']) {
  test(`compiled middleware cancels a ${gate} interruption even without an intervening frame or render`, async t => {
    const f = fixture(t);
    const frontend = await activate(f.context);
    await settle();
    f.renderMessage(frontend);
    f.frame(0); f.frame(500);
    if (gate === 'session') { f.setSession('session-b'); f.setSession('session-a'); }
    if (gate === 'focus') { f.setFocus(false); f.setFocus(true); }
    if (gate === 'visibility') { f.setVisible(false); f.setVisible(true); }
    f.frame(1000); f.frame(1599);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(f.calls.length, 1);
    f.frame(1600);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(f.calls[1]?.path, '/read');
  });
}

test('DOM reuse for a different message identity starts a new clock and only acknowledges the new identity', async t => {
  const f = fixture(t, { ...base, total: 2, sessions: [{
    ...base.sessions[0]!, count: 2,
    items: [...base.sessions[0]!.items, { kind: 'reply', nativeId: 'reply-b', createdRevision: 1 }],
  }] });
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  f.frame(0); f.frame(500);
  const next = { ...props, identity: { ...props.identity, id: 'reply-b' } };
  f.renderMessage(frontend, next);
  f.frame(550); f.frame(1149);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1);
  f.frame(1150);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init?.body)).keys,
    [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-b' }]);
  assert.notEqual(f.marker(frontend, props), null, 'the earlier block remains unread');
});

test('losing complete/root eligibility cancels a pending clock on the same DOM body', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  f.frame(0); f.frame(500);
  f.renderMessage(frontend, { ...props, complete: false });
  f.frame(1000);
  f.renderMessage(frontend);
  f.frame(1100); f.frame(1699);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1);
  f.renderMessage(frontend, { ...props, identity: { ...props.identity, agentId: 'child' } });
  f.frame(2000);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1);
});

test('module-global state persists through session changes and connected hidden delta delivery', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.setSession('session-b');
  f.setSession('session-a');
  f.setVisible(false);
  f.event({ type: 'unread/delta', generation: base.generation, fromRevision: 1, revision: 2,
    added: [], removed: [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' }] });
  f.setVisible(true);
  assert.equal(f.marker(frontend), null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.services.length, 2);
});

test('ask has no highlight but preserves the component and reports its exact identity after continuous presentation', async t => {
  const snapshot: Snapshot = { ...base, sessions: [{ sessionId: 'session-a', count: 1,
    items: [{ kind: 'ask', nativeId: 'host-request-42', createdRevision: 1 }] }] };
  const f = fixture(t, snapshot);
  const frontend = await activate(f.context);
  await settle();
  const ask: MessageProps = { ...props, identity: { sessionId: 'session-a', kind: 'ask', id: 'host-request-42' } };
  assert.equal(f.marker(frontend, ask), null);
  const ref = { current: null as HTMLDivElement | null };
  const children = 'native question and choices';
  const adornment = 'inherited question adornment';
  const result = f.renderMessage(frontend, { ...ask, bodyRef: ref, children, adornment });
  assert.equal(result.type, f.Base);
  assert.equal(result.props.children, children);
  assert.equal(result.props.adornment, adornment);
  assert.equal(result.props.className, undefined);
  assert.equal(ref.current, f.element);
  assert.equal(f.observed() > 0, true);
  f.frame(0); f.frame(599);
  assert.equal(f.calls.length, 1);
  f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.path, '/read');
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init?.body)), {
    generation: 'generation-a', keys: [{ sessionId: 'session-a', kind: 'ask', nativeId: 'host-request-42' }],
  });
  assert.equal(f.marker(frontend, ask), null);
  assert.equal(f.calls.every(call => ['/state', '/read'].includes(call.path)), true);
  f.frame(1200);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2, 'removing ask decoration does not duplicate read acknowledgements');
  f.unmount();
  assert.equal(ref.current, null);
});

test('reply highlight needs no body-height measurement and retains a noninteractive accessible unread label', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const marker = f.marker(frontend)!;
  assert.equal(marker.props.style, undefined);
  assert.equal(f.renderMessage(frontend).props.className, 'cn-message-highlight cn-unread');
  assert.equal(marker.props['aria-label'], '未读消息');
  assert.equal(marker.props.role, 'img');
  assert.equal(marker.props.tabIndex, undefined);
  assert.equal(marker.props.onClick, undefined);
  f.setRect({ top: 20, left: 10, right: 290, bottom: 100, height: 80, width: 280 });
  f.resize();
  assert.deepEqual(f.marker(frontend), marker);
  assert.doesNotMatch(compiled, /ResizeObserver/);
});

test('highlight excludes child, user, tool, system and incomplete messages even with a matching unread identity', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  for (const values of [
    { ...props, identity: { ...props.identity, agentId: 'child-agent' } },
    ...(['user', 'tool', 'system'] as const).map(role => ({
      ...props, identity: { sessionId: 'session-a', kind: 'message' as const, id: 'reply-a', role },
    })),
    { ...props, complete: false },
  ]) {
    const result = f.renderMessage(frontend, { ...values, className: 'inherited' });
    assert.ok(!String(result.props.className).split(' ').includes('cn-unread'));
    assert.equal(result.props.adornment, undefined);
    if (values.complete) assert.equal(result.props.className, 'inherited');
    f.unmount();
  }
  assert.equal(f.observed(), 0);
});

test('initial complete history is never read, but a mounted incomplete-to-complete root reply can ACK early', async t => {
  const f = fixture(t, { ...base, total: 0, sessions: [] });
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  assert.equal(f.observed(), 0);
  f.unmount();
  f.renderMessage(frontend, { ...props, complete: false });
  assert.equal(f.observed(), 0);
  f.renderMessage(frontend, { ...props, complete: true });
  assert.equal(f.observed(), 1);
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls[1]?.path, '/read');
});

test('image and child rendering progress never substitutes for actual root completion', async t => {
  const f = fixture(t, { ...base, total: 0, sessions: [] });
  const frontend = await activate(f.context);
  await settle();
  for (const children of ['streaming', 'image loaded', 'child agent completed']) {
    f.renderMessage(frontend, { ...props, complete: false, children });
    f.frame(0); f.frame(600);
  }
  assert.equal(f.observed(), 0);
  assert.equal(f.calls.length, 1);
  f.unmount();
  for (const children of ['history', 'history image loaded', 'history child completed']) {
    f.renderMessage(frontend, { ...props, children });
  }
  assert.equal(f.observed(), 0);
});

test('sub-agent, user and incomplete outputs are not observed; current pending ask uses exact request id without answering', async t => {
  const f = fixture(t, { ...base, total: 0, sessions: [] });
  const frontend = await activate(f.context);
  await settle();
  const excluded: MessageProps[] = [
    { ...props, identity: { ...props.identity, agentId: 'child-agent' } },
    { ...props, identity: { ...props.identity, kind: 'message', role: 'user' } },
    { ...props, identity: { ...props.identity, kind: 'message', role: 'tool' } },
    { ...props, identity: { ...props.identity, kind: 'message', role: 'system' } },
    { ...props, complete: false },
  ];
  for (const values of excluded) {
    f.renderMessage(frontend, values);
    f.unmount();
  }
  assert.equal(f.observed(), 0);
  f.renderMessage(frontend, { ...props, identity: { sessionId: 'session-a', kind: 'ask', id: 'host-request-42' } });
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init?.body)).keys,
    [{ sessionId: 'session-a', kind: 'ask', nativeId: 'host-request-42' }]);
  assert.equal(f.calls.every(call => ['/state', '/read'].includes(call.path)), true);
});

test('focus loss, obstruction and inert ancestors reset the read timer instead of counting hidden time', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  f.frame(0);
  f.setFocus(false); f.frame(500);
  f.setFocus(true); f.frame(600);
  f.setObstructed(true); f.frame(1000);
  f.setObstructed(false); f.frame(1100);
  f.setInert(true); f.frame(1600);
  f.setInert(false); f.frame(1700); f.frame(2299);
  assert.equal(f.calls.length, 1);
  f.frame(2300);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2);
});

test('hidden, disconnected or disposed modules cannot submit presentation facts', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.renderMessage(frontend);
  f.frame(0);
  f.setVisible(false);
  f.frame(600);
  f.setConnected(false);
  f.frame(1200);
  frontend.dispose?.();
  f.frame(1800);
  f.invalidate();
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 1);
});

test('sidebar badge remains noninteractive while navigation contains only the notification menu action', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const sessionBase = (() => null);
  const session = frontend.components!.find(component => component.boundary === 'sessionStatus')!.wrap(sessionBase);
  const nativeStatus = 'native status and needs-decision';
  const sessionProps = { sessionId: 'session-a', status: 'idle', needsDecision: true, children: nativeStatus };
  const sidebar = f.render(session, sessionProps)!;
  assert.equal(sidebar.type, sessionBase, 'native status boundary is not replaced or wrapped');
  assert.equal(sidebar.props.status, sessionProps.status);
  assert.equal(sidebar.props.needsDecision, true);
  assert.equal((sidebar.props.children as unknown[])[0], nativeStatus);
  const badgeNode = (sidebar.props.children as Element[])[1]!;
  const badge = f.render(badgeNode.type, badgeNode.props)!;
  assert.equal(badge.type, 'span');
  assert.equal(badge.props.className, 'ck-badge cn-session-badge');
  assert.equal(badge.props.onClick, undefined);
  assert.equal(badge.props.tabIndex, undefined);
  assert.deepEqual(badge.props.children, [1]);
  f.unmount();
  assert.equal(frontend.menus!.length, 1);
  const state = frontend.menus![0]!.getState({ menu: 'global' });
  assert.equal(state.label, '开启通知（当前环境不支持）');
  assert.equal(state.disabled, true);
  assert.doesNotMatch(compiled, /cn-global|cn-dialog|cn-settings|cn-state-dot|createPortal|通知设置，|未读：/);
  assert.doesNotMatch(compiled, /globalNavigation|props\.items/);
});

test('notification menu only toggles this device and disables actions during work or unsupported enablement', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const bridge = f.services.find(service => service.id === 'device-bridge')!.instance as DeviceBridge;
  const initial = bridge.getSnapshot();
  let status: DeviceStatus = { ...initial, supported: true, error: null };
  const toggled: string[] = [];
  bridge.getSnapshot = () => status;
  bridge.enable = async () => { toggled.push('enable'); };
  bridge.disable = async () => { toggled.push('disable'); };
  const menu = frontend.menus![0]!;
  const target = { menu: 'global' } as const;
  const toggle = () => menu.getState(target);
  const controller = new AbortController();
  const click = () => menu.onSelect(target, { signal: controller.signal });
  assert.equal(menu.subscribe, bridge.subscribe, 'the registry subscribes to the existing device service');
  assert.equal(toggle().label, '开启通知');
  assert.equal(toggle().disabled, false);
  assert.deepEqual(toggled, []);
  await click();
  assert.deepEqual(toggled, ['enable']);
  status = { ...status, subscribed: true, registered: false, error: 'Server registration rejected' };
  assert.equal(toggle().label, '开启通知', 'a browser-only subscription does not claim server-side enablement');
  assert.equal(toggle().disabled, false);
  await click();
  assert.deepEqual(toggled, ['enable', 'enable']);
  status = { ...status, registered: true, subscribed: true };
  assert.equal(toggle().label, '关闭通知');
  await click();
  assert.deepEqual(toggled, ['enable', 'enable', 'disable']);
  status = { ...status, busy: true };
  assert.equal(toggle().label, '通知处理中…');
  assert.equal(toggle().disabled, true);
  assert.throws(click, /当前无法更改/);
  status = { ...status, busy: false, registered: false, subscribed: true, supported: false };
  assert.equal(toggle().disabled, false, 'a remaining browser subscription can still be disabled');
  status = { ...status, subscribed: false };
  assert.equal(toggle().disabled, true);
  assert.throws(click, /当前无法更改/);
  status = { ...status, supported: true };
  controller.abort();
  assert.throws(click, /abort/i);
  assert.deepEqual(toggled, ['enable', 'enable', 'disable']);
  assert.equal(f.calls.length, 1, 'menu rendering and toggling do not refetch unread state');
  assert.equal(frontend.components!.some(component =>
    component.boundary === 'managementHeader' || component.boundary === 'managementDetailHeader'), false);
});

test('session badge delegates geometry to public CSS and retains only count semantics', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const badge = css.match(/\.cn-session-badge\s*\{([^}]+)\}/)![1]!;
  assert.match(badge, /background:\s*var\(--ck-color-danger\);/);
  assert.match(badge, /color:\s*var\(--ck-color-on-accent\);/);
  assert.match(badge, /font-variant-numeric:\s*tabular-nums;/);
  assert.doesNotMatch(badge, /display:|align-items:|justify-content:|flex:|box-sizing:|width:|height:|padding:|border-radius:|font-size:|line-height:/);
});

test('breaking frontend ABI rejection and theme-aware in-bounds highlighting are explicit', async t => {
  const f = fixture(t);
  for (const extra of [{ apiVersion: 1 }, { uiVersion: 2 }, { uiSurfaceVersion: undefined }, { uiSurfaceVersion: 0 }, { uiSurfaceVersion: 2 }, { menuVersion: undefined }, { menuVersion: 2 }, { state: undefined }, { onEvent: undefined }]) {
    await assert.rejects(async () => activate({ ...f.context, ...extra } as ModuleFrontendContext), /frontend v2/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.services.length, 0);
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const body = css.match(/\.cn-message-highlight\s*\{([^}]+)\}/)![1]!;
  assert.match(body, /border-radius:\s*min\(var\(--ck-radius\), 3px\)/);
  assert.doesNotMatch(body, /overflow|clip-path|margin|padding/);
  const highlight = css.match(/\.cn-message-highlight\.cn-unread\s*\{([^}]+)\}/)![1]!;
  assert.match(highlight, /background-color:\s*color-mix\(in srgb, color-mix\(in srgb, var\(--ck-color-accent\) 35%, #f2c94c\) 18%, transparent\)/);
  assert.match(highlight, /transition-duration:\s*0s/);
  assert.doesNotMatch(highlight, /margin|padding|border|position|width|height/);
  assert.match(css, /transition:\s*background-color 1000ms ease-out/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.cn-message-highlight\s*\{\s*transition: none;/);
  const label = css.match(/\.cn-unread-label\s*\{([^}]+)\}/)![1]!;
  assert.match(label, /clip-path:\s*inset\(50%\)/);
  assert.match(label, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /cn-redline|content-visibility/);
  assert.doesNotMatch(css, /(?:^|\n)(?:body|\.chat|\.message)/);
  assert.doesNotMatch(css, /cn-global|cn-dialog|cn-settings|cn-state-dot/);
});
