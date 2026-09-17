export interface Rectangle { top: number; bottom: number; left: number; right: number; height: number; width: number }
export function visibleRegion(rect: Rectangle, intersection: Rectangle,
  viewport: { top: number; left: number; height: number; width: number }): Rectangle | null {
  if (rect.height <= 0 || rect.width <= 0 || intersection.width < rect.width - 1 ||
      rect.left < viewport.left || rect.right > viewport.left + viewport.width ||
      rect.bottom > viewport.top + viewport.height || rect.bottom <= viewport.top) return null;
  const long = rect.height > viewport.height;
  const top = long ? Math.max(rect.top, rect.bottom - Math.min(48, viewport.height)) : rect.top;
  if (top < viewport.top || intersection.top > top + 1 || intersection.bottom < rect.bottom - 1) return null;
  return { ...rect, top, height: rect.bottom - top };
}
export function observeRead(element: HTMLElement, allowed: () => boolean, presented: () => void,
  delay: number): () => void {
  if (typeof IntersectionObserver === 'undefined' || typeof document.elementFromPoint !== 'function') return () => {};
  let intersecting = false;
  let frame = 0;
  let start: number | null = null;
  let signature = '';
  let stopped = false;
  let completed = false;
  const valid = () => {
    if (!allowed() || !element.isConnected || document.visibilityState !== 'visible' || !document.hasFocus() ||
        element.closest('[inert], [aria-hidden="true"], [hidden]') || !intersecting) return null;
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    let top = viewport?.offsetTop ?? 0;
    let left = viewport?.offsetLeft ?? 0;
    let right = left + (viewport?.width ?? window.innerWidth);
    let bottom = top + (viewport?.height ?? window.innerHeight);
    // Inspect only the supplied element's ancestor chain, not host selectors or private state.
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) return null;
      if (ancestor === element) continue;
      const bounds = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left + ancestor.clientLeft);
        right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top + ancestor.clientTop);
        bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
      }
    }
    if (right <= left || bottom <= top) return null;
    const intersection = { top: Math.max(rect.top, top), bottom: Math.min(rect.bottom, bottom),
      left: Math.max(rect.left, left), right: Math.min(rect.right, right),
      width: Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left)),
      height: Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)) };
    const region = visibleRegion(rect, intersection, { top, left, width: right - left, height: bottom - top });
    if (!region) return null;
    for (const x of [region.left + Math.min(8, region.width / 4), (region.left + region.right) / 2, region.right - Math.min(8, region.width / 4)]) {
      for (const y of [region.top + Math.min(4, region.height / 4), (region.top + region.bottom) / 2, region.bottom - Math.min(4, region.height / 4)]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !element.contains(hit)) return null;
      }
    }
    return [rect.top, rect.bottom, rect.left, rect.right].join(',');
  };
  const tick = (now: number) => {
    if (stopped || completed) return;
    const next = valid();
    if (next === null) { start = null; signature = ''; }
    else if (start === null || next !== signature) { start = now; signature = next; }
    else if (now - start >= delay) { completed = true; presented(); return; }
    frame = requestAnimationFrame(tick);
  };
  const observer = new IntersectionObserver(entries => {
    const entry = entries.find(item => item.target === element);
    if (!entry) return;
    intersecting = entry.isIntersecting;
    if (!intersecting) {
      cancelAnimationFrame(frame);
      frame = 0;
      start = null;
      signature = '';
    } else if (!frame && !completed) frame = requestAnimationFrame(tick);
  }, { threshold: [0, 0.01, 0.5, 1] });
  observer.observe(element);
  return () => { stopped = true; observer.disconnect(); cancelAnimationFrame(frame); };
}
