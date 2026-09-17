import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import type { ActivateFrontend, MessageDecorationContext, ModuleFrontendContext } from '@cockpit/module-api';
import type { Snapshot } from '../shared/protocol.ts';
import { bell } from './icons.ts';

const compiled = (await build({ entryPoints: [fileURLToPath(new URL('./index.tsx', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' })).outputFiles[0]!.text;
const { activate } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as { activate: ActivateFrontend };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
interface Element { type: unknown; props: Record<string, unknown> }
const base: Snapshot = { generation: 'generation-a', revision: 1, complete: true, total: 1, sessions: [{
  sessionId: 'session-a', count: 1, items: [{ kind: 'reply', nativeId: 'reply-a', createdRevision: 1 }],
}] };
const props: MessageDecorationContext = {
  sessionId: 'session-a', kind: 'message', id: 'reply-a', role: 'assistant', complete: true, element: null,
};
function fixture(t: { after(fn: () => void): void }, initial = base) {
  let current = initial;
  let focus = true;
  let obstructed = false;
  let visible = true;
  let connected = true;
  let inert = false;
  let rect = { top: 20, left: 10, right: 290, bottom: 220, height: 200, width: 280 };
  const errors: unknown[] = [];
  const calls: { path: string; init?: RequestInit }[] = [];
  const restorers: (() => void)[] = [];
  const viewListeners = new Set<() => void>();
  let invalidate = () => {};
  const documentListeners = new Map<string, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const resizes = new Set<() => void>();
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
  const element = new FakeElement() as unknown as HTMLElement;
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
  replace('window', { innerHeight: 600, innerWidth: 300, addEventListener() {}, removeEventListener() {} });
  replace('getComputedStyle', () => ({ visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', overflowY: 'visible' }));
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  replace('cancelAnimationFrame', (id: number) => frames.delete(id));
  let observed = 0;
  replace('IntersectionObserver', class {
    callback: (entries: unknown[]) => void;
    constructor(callback: (entries: unknown[]) => void) { this.callback = callback; }
    observe(target: HTMLElement) { observed++; this.callback([{ target, isIntersecting: true, intersectionRect: rect }]); }
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
    states: [] as unknown[], ref: 0, effect: 0, state: 0,
  };
  const effects: (() => void)[] = [];
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type: unknown, attributes: Record<string, unknown> | null, ...children: unknown[]): Element {
      return { type, props: { ...attributes, children } };
    },
    useRef(value: unknown) { return hooks.refs[hooks.ref++] ??= { current: value }; },
    useId() { return 'synthetic-settings-heading'; },
    useState(value: unknown) {
      const index = hooks.state++;
      if (!(index in hooks.states)) hooks.states[index] = value;
      return [hooks.states[index], (next: unknown) => { hooks.states[index] = next; }];
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
    apiVersion: 1, uiVersion: 1, surfaceVersion: 1, moduleId: 'cockpit-notification', react: React,
    apiBase: `https://host.test/deployment/_modules/cockpit-notification/${'a'.repeat(64)}/api`,
    config: { readDelayMs: 600, pushDelayMs: 3000, maxBatch: 128 },
    signal: controller.signal, report: (error: unknown) => errors.push(error),
    createPortal: (children: unknown, target: unknown) => {
      assert.equal(target, body); return { type: 'portal', props: { children: [children] } };
    },
    view: {
      getSnapshot: () => ({ sessionId: 'session-a', visible, connected }),
      subscribe: (listener: () => void) => { viewListeners.add(listener); return () => viewListeners.delete(listener); },
    },
    onInvalidate: (listener: () => void) => { invalidate = listener; return () => { invalidate = () => {}; }; },
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === '/read') {
        const request = JSON.parse(String(init!.body));
        current = { ...current, revision: current.revision + 1, total: 0, sessions: [] };
        return Response.json({ acknowledged: request.keys, state: current });
      }
      return Response.json(current);
    },
  } as unknown as ModuleFrontendContext;
  const unmount = () => {
    hooks.effects.forEach(effect => effect.cleanup?.());
    hooks.effects = []; hooks.refs = []; hooks.states = [];
  };
  t.after(() => { unmount(); controller.abort(); restorers.reverse().forEach(restore => restore()); });
  return { context, element, calls, errors, controller, observed: () => observed, invalidate: () => invalidate(),
    unmount, setFocus: (value: boolean) => { focus = value; }, setObstructed: (value: boolean) => { obstructed = value; },
    setInert: (value: boolean) => { inert = value; }, setRect: (value: typeof rect) => { rect = value; },
    resize() { for (const resize of resizes) resize(); },
    setVisible(value: boolean) { visible = value; documentListeners.get('visibilitychange')?.(); },
    setConnected(value: boolean) { connected = value; for (const listener of viewListeners) listener(); },
    frame(now: number) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
    render(component: unknown, values: unknown): Element | null {
      hooks.ref = 0; hooks.effect = 0; hooks.state = 0;
      return (component as (props: unknown) => Element | null)(values);
    },
    flushEffects() { effects.splice(0).forEach(effect => effect()); },
  };
}

test('bundled frontend uses host React and only public v1 surfaces; unsupported push keeps redlines working', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  assert.deepEqual(Object.keys(frontend).sort(), ['dispose', 'globalActions', 'messageDecorations', 'sessionBadges']);
  assert.equal(frontend.messageDecorations?.length, 1);
  const line = f.render(frontend.messageDecorations![0]!.component, { ...props, element: f.element });
  assert.equal(line?.type, 'span');
  assert.equal(line?.props.className, 'cn-redline');
  assert.equal(line?.props.role, 'img');
  assert.equal(line?.props['aria-label'], '未读消息');
  assert.equal(line?.props['aria-hidden'], undefined);
  assert.equal(line?.props.tabIndex, undefined);
  assert.equal(line?.props.onClick, undefined);
  assert.doesNotMatch(compiled, /createRoot|react\/jsx-runtime|querySelector|localStorage|sessionStorage/);
  assert.equal(f.calls.length, 1);
});

test('short visible root assistant reply reads once after stable600ms and the receipt causes no redundant GET', async t => {
  const f = fixture(t);
  const frontend = await activate(f.context);
  await settle();
  f.render(frontend.messageDecorations![0]!.component, { ...props, element: f.element });
  f.flushEffects();
  f.frame(0); f.frame(599);
  assert.equal(f.calls.length, 1);
  f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init?.body)), {
    generation: 'generation-a', keys: [{ sessionId: 'session-a', kind: 'reply', nativeId: 'reply-a' }],
  });
  assert.equal(f.render(frontend.messageDecorations![0]!.component, { ...props, element: f.element }), null);
});

test('ask gutter marker follows the supplied question height rather than spanning the host choice group', async t => {
  const snapshot: Snapshot = { ...base, sessions: [{ sessionId: 'session-a', count: 1,
    items: [{ kind: 'ask', nativeId: 'host-request-42', createdRevision: 1 }] }] };
  const f = fixture(t, snapshot);
  const frontend = await activate(f.context);
  await settle();
  const decoration = frontend.messageDecorations![0]!.component;
  const ask = { ...props, kind: 'ask', id: 'host-request-42', element: f.element };
  f.render(decoration, ask);
  f.flushEffects();
  const marker = f.render(decoration, ask)!;
  assert.deepEqual(marker.props.style, { height: 200, bottom: 'auto' });
  assert.equal(marker.props['aria-label'], '未读提问');
  assert.equal(marker.props.role, 'img');
  assert.equal(marker.props.tabIndex, undefined);
  assert.equal(marker.props.onClick, undefined);
  f.setRect({ top: 20, left: 10, right: 290, bottom: 100, height: 80, width: 280 });
  f.resize();
  assert.deepEqual(f.render(decoration, ask)?.props.style, { height: 80, bottom: 'auto' });
});

test('initial complete history is never read, but a mounted incomplete-to-complete root reply can ACK early', async t => {
  const f = fixture(t, { ...base, total: 0, sessions: [] });
  const frontend = await activate(f.context);
  await settle();
  const decoration = frontend.messageDecorations![0]!.component;
  f.render(decoration, { ...props, element: f.element });
  f.flushEffects();
  assert.equal(f.observed(), 0);
  f.unmount();
  f.render(decoration, { ...props, element: f.element, complete: false });
  f.flushEffects();
  assert.equal(f.observed(), 0);
  f.render(decoration, { ...props, element: f.element, complete: true });
  f.flushEffects();
  assert.equal(f.observed(), 1);
  f.frame(0); f.frame(600);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.calls[1]?.path, '/read');
});

test('sub-agent, user and incomplete outputs are not observed; current pending ask uses exact request id without answering', async t => {
  const f = fixture(t, { ...base, total: 0, sessions: [] });
  const frontend = await activate(f.context);
  await settle();
  const decoration = frontend.messageDecorations![0]!.component;
  for (const extra of [{ agentId: 'child-agent' }, { role: 'user' }, { complete: false }]) {
    f.render(decoration, { ...props, element: f.element, ...extra });
    f.flushEffects();
    f.unmount();
  }
  assert.equal(f.observed(), 0);
  f.render(decoration, { ...props, kind: 'ask', id: 'host-request-42', role: undefined, element: f.element });
  f.flushEffects();
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
  f.render(frontend.messageDecorations![0]!.component, { ...props, element: f.element });
  f.flushEffects();
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
  f.render(frontend.messageDecorations![0]!.component, { ...props, element: f.element });
  f.flushEffects();
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
  const badge = f.render(frontend.sessionBadges![0]!.component, { sessionId: 'session-a' })!;
  assert.equal(badge.type, 'span');
  assert.equal(badge.props.onClick, undefined);
  assert.equal(badge.props.tabIndex, undefined);
  assert.deepEqual(badge.props.children, [1]);
  f.unmount();
  const global = f.render(frontend.globalActions![0]!.component, {})!;
  const button = (global.props.children as Element[])[0]!;
  assert.match(String(button.props['aria-label']), /1 条未读/);
  (button.props.onClick as () => void)();
  const open = f.render(frontend.globalActions![0]!.component, {})!;
  const settings = (open.props.children as Element[])[1]!;
  f.unmount();
  const portal = f.render(settings.type, settings.props)!;
  assert.equal(portal.type, 'portal');
  const dialog = (portal.props.children as Element[])[0]!;
  assert.equal(dialog.type, 'dialog');
});

test('surface ABI rejection and CSS geometry are explicit; pinned Lucide nodes retain upstream identity', async t => {
  const f = fixture(t);
  await assert.rejects(async () => activate({ ...f.context, surfaceVersion: undefined }), /surface v1/);
  assert.equal(f.calls.length, 0);
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const redline = css.match(/\.cn-redline\s*\{([^}]+)\}/)![1]!;
  assert.match(redline, /position:\s*absolute/);
  assert.match(redline, /left:\s*0/);
  assert.doesNotMatch(redline, /margin|padding/);
  assert.doesNotMatch(css, /(?:^|\n)(?:body|\.chat|\.message)/);
  const nodes = JSON.parse(await readFile(new URL('../../node_modules/lucide-static/icon-nodes.json', import.meta.url), 'utf8'));
  assert.deepEqual(bell, nodes.bell);
});
