import assert from 'node:assert/strict';
import test from 'node:test';
import { observeRead } from './visibility.ts';

const rect = (top: number, bottom: number, left = 10, right = 290) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top });
class Body {
  bounds = rect(20, 220);
  isConnected = true;
  parentElement: Body | null = null;
  hidden = false;
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 300;
  clientHeight = 600;
  style = { visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
  contains(hit: Body | null): boolean { return hit !== null && (hit === this || this.contains(hit.parentElement)); }
  closest(): Body | null { return this.hidden ? this : this.parentElement?.closest() ?? null; }
  getBoundingClientRect() { return this.bounds; }
}

function fixture(t: { after(fn: () => void): void }) {
  const element = new Body();
  let focused = true;
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible', hasFocus: () => focused,
    elementFromPoint: (_x: number, _y: number): Body | null => element,
  });
  const window = Object.assign(new EventTarget(), {
    innerHeight: 600, innerWidth: 300,
    visualViewport: undefined as { offsetTop: number; offsetLeft: number; width: number; height: number } | undefined,
  });
  const frames = new Map<number, FrameRequestCallback>();
  const observers = new Map<Body, (entries: { target: Body; isIntersecting: boolean }[]) => void>();
  let sequence = 0;
  const restorers: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  for (const [name, value] of Object.entries({
    document, window, getComputedStyle: (body: Body) => body.style,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IntersectionObserver: class {
      target?: Body;
      callback: (entries: { target: Body; isIntersecting: boolean }[]) => void;
      constructor(callback: (entries: { target: Body; isIntersecting: boolean }[]) => void) { this.callback = callback; }
      observe(target: Body) {
        this.target = target;
        observers.set(target, this.callback);
        this.callback([{ target, isIntersecting: true }]);
      }
      disconnect() { if (this.target) observers.delete(this.target); }
    },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restorers.push(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name));
  }
  t.after(() => { cleanups.forEach(cleanup => cleanup()); restorers.reverse().forEach(restore => restore()); });
  return {
    element, document, window,
    observe(presented: () => void, allowed = () => true, body = element) {
      const cleanup = observeRead(body as unknown as HTMLElement, allowed, presented, 600);
      cleanups.push(cleanup);
      return cleanup;
    },
    frame(now: number) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
    intersect(...values: boolean[]) { observers.get(element)?.(values.map(isIntersecting => ({ target: element, isIntersecting }))); },
    focus(value: boolean) { focused = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')); },
    visible(value: boolean) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
  };
}

test('a block reads once at 600ms, not at 599ms, with native prototype geometry', t => {
  const f = fixture(t);
  f.element.bounds = Object.create(f.element.bounds);
  assert.deepEqual(Object.keys(f.element.bounds), []);
  let reads = 0;
  f.observe(() => reads++);
  f.frame(0); f.frame(599);
  assert.equal(reads, 0);
  f.frame(600); f.frame(1200);
  assert.equal(reads, 1);
});

for (const direction of ['up', 'down']) {
  test(`long block scrolling ${direction} keeps time while all visible content changes`, t => {
    const f = fixture(t);
    let reads = 0;
    f.observe(() => reads++);
    for (const now of [0, 100, 200, 300, 400, 500, 599, 600]) {
      const top = direction === 'down' ? -now * 4 : -3000 + now * 4;
      f.element.bounds = rect(top, top + 4000);
      f.frame(now);
      assert.equal(reads, now < 600 ? 0 : 1);
    }
  });
}

for (const bounds of [rect(-190, 10), rect(590, 790), rect(20, 220, -270, 10), rect(599.75, 700)]) {
  test(`any positive short-block intersection is enough: ${JSON.stringify(bounds)}`, t => {
    const f = fixture(t);
    f.element.bounds = bounds;
    f.document.elementFromPoint = (x, y) => {
      assert.ok(x > Math.max(0, bounds.left) && x < Math.min(300, bounds.right));
      assert.ok(y > Math.max(0, bounds.top) && y < Math.min(600, bounds.bottom));
      return f.element;
    };
    let reads = 0;
    f.observe(() => reads++);
    f.frame(0); f.frame(600);
    assert.equal(reads, 1);
  });
}

test('fully leaving the viewport restarts time; zero-area edge contact does not count', t => {
  const f = fixture(t);
  let reads = 0;
  f.observe(() => reads++);
  f.frame(0); f.frame(500);
  f.element.bounds = rect(600, 800);
  f.frame(550);
  f.element.bounds = rect(590, 790);
  f.frame(600); f.frame(1199);
  assert.equal(reads, 0);
  f.frame(1200);
  assert.equal(reads, 1);
});

test('all batched intersection entries are processed, including a leave/reenter between frames', t => {
  const f = fixture(t);
  let reads = 0;
  f.observe(() => reads++);
  f.frame(0); f.frame(500);
  f.intersect(false, true);
  f.frame(600); f.frame(1199);
  assert.equal(reads, 0);
  f.frame(1200);
  assert.equal(reads, 1);
});

for (const gate of ['focus', 'visible'] as const) {
  test(`${gate} loss between frames resets time even if frames were suspended`, t => {
    const f = fixture(t);
    let reads = 0;
    f.observe(() => reads++);
    f.frame(0); f.frame(500);
    f[gate](false); f[gate](true);
    f.frame(5000); f.frame(5599);
    assert.equal(reads, 0);
    f.frame(5600);
    assert.equal(reads, 1);
  });
}

test('partial occlusion counts only exposed points, and complete occlusion breaks continuity', t => {
  const f = fixture(t);
  let reads = 0;
  f.observe(() => reads++);
  f.frame(0);
  f.document.elementFromPoint = () => null;
  f.frame(500);
  const child = new Body();
  child.parentElement = f.element;
  f.document.elementFromPoint = (x, y) => x > 270 && y > 210 ? child : null;
  f.frame(600); f.frame(1199);
  assert.equal(reads, 0);
  f.frame(1200);
  assert.equal(reads, 1);
});

test('hit tests use only the intersection of nested ancestor clips and the visual viewport', t => {
  const f = fixture(t);
  const outer = new Body();
  outer.bounds = rect(50, 550, 20, 280);
  outer.clientLeft = 2; outer.clientTop = 3;
  outer.clientWidth = 256; outer.clientHeight = 494;
  outer.style.overflowX = 'hidden'; outer.style.overflowY = 'scroll';
  const inner = new Body();
  inner.parentElement = outer;
  inner.bounds = rect(-100, 180, -50, 200);
  inner.clientWidth = 250; inner.clientHeight = 280;
  inner.style.overflowX = 'clip'; inner.style.overflowY = 'auto';
  f.element.parentElement = inner;
  f.element.bounds = rect(-500, 1500, -300, 600);
  f.window.visualViewport = { offsetTop: 100, offsetLeft: 100, width: 150, height: 300 };
  f.document.elementFromPoint = (x, y) => {
    assert.ok(x > 100 && x < 200 && y > 100 && y < 180);
    return f.element;
  };
  let reads = 0;
  f.observe(() => reads++);
  f.frame(0); f.frame(600);
  assert.equal(reads, 1, 'clipped offscreen parts do not disqualify the remaining visible area');
});

test('complete ancestor clipping blocks reading without trusting intersection observer alone', t => {
  const f = fixture(t);
  const parent = new Body();
  parent.bounds = rect(300, 400);
  parent.clientHeight = 100;
  parent.style.overflowY = 'hidden';
  f.element.parentElement = parent;
  let reads = 0;
  f.observe(() => reads++);
  f.frame(0); f.frame(600);
  assert.equal(reads, 0);
  f.element.bounds = rect(390, 590);
  f.frame(700); f.frame(1300);
  assert.equal(reads, 1);
});

test('hidden/inert ancestors, CSS hiding, disconnection and lost eligibility break exposure', t => {
  const f = fixture(t);
  const parent = new Body();
  f.element.parentElement = parent;
  let allowed = true;
  let reads = 0;
  f.observe(() => reads++, () => allowed);
  let now = 0;
  for (const change of [
    (hidden: boolean) => { parent.hidden = hidden; },
    (hidden: boolean) => { parent.style.opacity = hidden ? '0' : '1'; },
    (hidden: boolean) => { parent.style.visibility = hidden ? 'hidden' : 'visible'; },
    (hidden: boolean) => { parent.style.display = hidden ? 'none' : 'block'; },
    (hidden: boolean) => { f.element.isConnected = !hidden; },
    (hidden: boolean) => { allowed = !hidden; },
  ]) {
    f.frame(now);
    change(true); f.frame(now + 500); f.frame(now + 1100);
    change(false); now += 1200;
  }
  f.frame(now); f.frame(now + 599);
  assert.equal(reads, 0);
  f.frame(now + 600);
  assert.equal(reads, 1);
});

test('different blocks have independent clocks and unmount cancels pending observation', t => {
  const f = fixture(t);
  const second = new Body();
  let firstReads = 0, secondReads = 0;
  const stop = f.observe(() => firstReads++);
  f.frame(0);
  f.observe(() => secondReads++, () => true, second);
  f.document.elementFromPoint = x => x < 100 ? f.element : second;
  f.frame(300); f.frame(600);
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 0);
  stop();
  f.frame(899);
  assert.equal(secondReads, 0);
  f.frame(900);
  assert.equal(secondReads, 1);
  let unmounted = 0;
  const unmount = f.observe(() => unmounted++);
  f.frame(1000);
  unmount(); f.frame(2000);
  assert.equal(unmounted, 0);
});
