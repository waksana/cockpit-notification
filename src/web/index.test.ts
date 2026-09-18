import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import type { ActivateFrontend, MessageProps, ModuleFrontend, ModuleFrontendContext, ModuleStateRegistration } from '@cockpit/module-api';
import type { ComponentType, RefCallback } from 'react';
import type { Snapshot, UnreadEvent } from '../shared/protocol.ts';
import { bell } from './icons.ts';

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
  const documentListeners = new Map<string, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const resizes = new Set<() => void>();
  const observedElements: HTMLElement[] = [];
  const serviceDisposals: string[] = [];
  const services: { id: string; instance: object; active: boolean; dispose(): void }[] = [];
  const windowListeners = new Map<string, () => void>();
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
    addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
  });
  replace('window', { innerHeight: 600, innerWidth: 300,
    addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
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
    apiVersion: 2, uiVersion: 1, moduleId: 'cockpit-notification', react: React,
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
        const removed = current.sessions.flatMap(session => session.items.map(item => ({
          sessionId: session.sessionId, kind: item.kind, nativeId: item.nativeId,
        })));
        current = { ...current, revision: current.revision + 1, total: 0, sessions: [] };
        if (autoDelta) onEvent({ type: 'unread/delta', generation: current.generation,
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
    listeners: () => viewListeners.size + documentListeners.size + windowListeners.size,
    observed: () => observed, invalidate: () => invalidate(),
    event: (value: UnreadEvent) => onEvent(value),
    subscriptions: () => ({ events: eventSubscriptions, invalidations: invalidationSubscriptions }),
    setAutoDelta: (value: boolean) => { autoDelta = value; },
    setSession(value: string) { sessionId = value; for (const listener of viewListeners) listener(); },
    unmount, setFocus: (value: boolean) => { focus = value; }, setObstructed: (value: boolean) => { obstructed = value; },
    setInert: (value: boolean) => { inert = value; }, setRect: (value: typeof rect) => { rect = value; },
    resize() { for (const resize of resizes) resize(); },
    setVisible(value: boolean) { visible = value; documentListeners.get('visibilitychange')?.(); },
    setConnected(value: boolean) { connected = value; for (const listener of viewListeners) listener(); },
    frame(now: number) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
    render, flushEffects,
  };
}

test('frontend registers concrete services and v2 middleware; unsupported push keeps redlines working', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  assert.deepEqual(Object.keys(frontend).sort(), ['apiVersion', 'components', 'dispose']);
  assert.equal(frontend.apiVersion, 2);
  assert.deepEqual(frontend.components?.map(component => component.boundary),
    ['message', 'sessionStatus', 'globalNavigation', 'managementHeader', 'managementDetailHeader']);
  assert.deepEqual(f.services.map(service => [service.id, service.instance.constructor.name]),
    [['device-bridge', 'DeviceBridge'], ['unread-store', 'UnreadStore']]);
  const ids = [...f.services, ...frontend.components!].map(registration => registration.id);
  assert.equal(new Set(ids).size, ids.length);
  const line = f.marker(frontend);
  assert.equal(line?.type, 'span');
  assert.equal(line?.props.className, 'cn-redline');
  assert.equal(line?.props.role, 'img');
  assert.equal(line?.props['aria-label'], '未读消息');
  assert.equal(line?.props['aria-hidden'], undefined);
  assert.equal(line?.props.tabIndex, undefined);
  assert.equal(line?.props.onClick, undefined);
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
  for (const key of ['identity', 'complete', 'children', 'className', 'style', 'onClick', 'aria-label'] as const) {
    assert.equal(result.props[key], values[key]);
  }
  const composed = result.props.adornment as Element;
  assert.equal(typeof composed.type, 'symbol');
  assert.equal((composed.props.children as unknown[])[0], adornment);
  assert.equal((composed.props.children as Element[])[1]!.props.className, 'cn-redline');
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
  assert.equal(f.listeners(), 4);
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

test('short visible root assistant reply reads once after stable600ms and the receipt causes no redundant GET', async t => {
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
});

test('only typed authority events remove redlines; HTTP receipt and generic invalidation leave them unchanged', async t => {
  const f = fixture(t);
  f.setAutoDelta(false);
  const frontend = await activate(f.context);
  await settle();
  const marker = f.marker(frontend);
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.marker(frontend), marker, 'POST receipt cannot change marker or its geometry');
  f.invalidate();
  assert.equal(f.calls.length, 2, 'notification does not subscribe to ordinary invalidations');
  f.event({ type: 'unread/delta', generation: base.generation, fromRevision: 1, revision: 2,
    added: [], removed: [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' }] });
  assert.equal(f.marker(frontend), null);
  assert.equal(f.calls.length, 2);
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

test('ask has no redline but preserves the component and reports its exact identity after stable presentation', async t => {
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

test('reply redline continues to follow the supplied body height', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  const marker = f.marker(frontend)!;
  assert.deepEqual(marker.props.style, { margin: 0, height: 200, bottom: 'auto' });
  assert.equal(marker.props['aria-label'], '未读消息');
  assert.equal(marker.props.role, 'img');
  assert.equal(marker.props.tabIndex, undefined);
  assert.equal(marker.props.onClick, undefined);
  f.setRect({ top: 20, left: 10, right: 290, bottom: 100, height: 80, width: 280 });
  f.resize();
  assert.deepEqual(f.marker(frontend)?.props.style, { margin: 0, height: 80, bottom: 'auto' });
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

test('focus loss, obstruction and inert ancestors reset the stable read timer instead of counting hidden time', async t => {
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

test('sidebar badge is noninteractive, total comes from snapshot, and settings use a body portal', async t => {
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
  assert.equal(badge.props.onClick, undefined);
  assert.equal(badge.props.tabIndex, undefined);
  assert.deepEqual(badge.props.children, [1]);
  f.unmount();
  const globalBase = (() => null);
  const actions = frontend.components!.find(component => component.boundary === 'globalNavigation')!.wrap(globalBase);
  const hostAction = 'native and inherited global actions';
  const outer = f.render(actions, { children: hostAction })!;
  assert.equal(outer.type, globalBase, 'global middleware introduces no placeholder container');
  assert.equal((outer.props.children as unknown[])[0], hostAction);
  const action = (outer.props.children as Element[])[1]!;
  const global = f.render(action.type, action.props)!;
  assert.equal(typeof global.type, 'symbol', 'notification button and portal compose through a Fragment');
  const button = (global.props.children as Element[])[0]!;
  assert.match(String(button.props['aria-label']), /1 条未读/);
  (button.props.onClick as () => void)();
  const open = f.render(action.type, action.props)!;
  const settings = (open.props.children as Element[])[1]!;
  f.unmount();
  const portal = f.render(settings.type, settings.props)!;
  assert.equal(portal.type, 'portal');
  const dialog = (portal.props.children as Element[])[0]!;
  assert.equal(dialog.type, 'dialog');
  assert.equal(dialog.props.onCancel, undefined, 'Escape uses native dialog close and focus restoration before unmount');
  assert.equal(typeof dialog.props.onClose, 'function');
});

test('management middleware retains the actual header props and existing actions without a substitute slot', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  const base = () => null;
  const inherited = { type: 'button', props: { children: ['existing action'] } };
  const onRefresh = () => {};
  for (const boundary of ['managementHeader', 'managementDetailHeader'] as const) {
    const middleware = frontend.components!.find(component => component.boundary === boundary)!;
    const header = f.render(middleware.wrap(base), { section: 'mcp', item: 'Example',
      onRefresh, actions: inherited })!;
    assert.equal(header.type, base);
    assert.equal(header.props.item, 'Example');
    assert.equal(header.props.onRefresh, onRefresh);
    const actions = header.props.actions as Element;
    assert.equal(typeof actions.type, 'symbol');
    assert.equal((actions.props.children as unknown[])[1], inherited);
    f.unmount();
  }
});

test('breaking frontend ABI rejection and gutter geometry are explicit; pinned Lucide nodes retain upstream identity', async t => {
  const f = fixture(t);
  for (const extra of [{ apiVersion: 1 }, { uiVersion: 2 }, { state: undefined }, { onEvent: undefined }]) {
    await assert.rejects(async () => activate({ ...f.context, ...extra } as ModuleFrontendContext), /frontend v2/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.services.length, 0);
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const redline = css.match(/\.cn-redline\s*\{([^}]+)\}/)![1]!;
  assert.match(redline, /position:\s*absolute/);
  assert.match(redline, /left:\s*-8px/);
  assert.doesNotMatch(redline, /margin|padding/);
  assert.doesNotMatch(css, /(?:^|\n)(?:body|\.chat|\.message)/);
  const nodes = JSON.parse(await readFile(new URL('../../node_modules/lucide-static/icon-nodes.json', import.meta.url), 'utf8'));
  assert.deepEqual(bell, nodes.bell);
});
