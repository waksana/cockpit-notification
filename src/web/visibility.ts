export function observeRead(element: HTMLElement, allowed: () => boolean, presented: () => void,
  delay: number): () => void {
  if (typeof IntersectionObserver === 'undefined' || typeof document.elementFromPoint !== 'function') return () => {};
  let intersecting = false;
  let frame = 0;
  let start: number | null = null;
  let stopped = false;
  let completed = false;
  const valid = () => {
    if (!allowed() || !element.isConnected || document.visibilityState !== 'visible' || !document.hasFocus() ||
        element.closest('[inert], [aria-hidden="true"], [hidden]') || !intersecting) return false;
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    let top = Math.max(rect.top, viewportTop);
    let left = Math.max(rect.left, viewportLeft);
    let right = Math.min(rect.right, viewportLeft + (viewport?.width ?? window.innerWidth));
    let bottom = Math.min(rect.bottom, viewportTop + (viewport?.height ?? window.innerHeight));
    // Inspect only the supplied element's ancestor chain, not host selectors or private state.
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) return false;
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
    if (right <= left || bottom <= top) return false;
    for (const x of [left + Math.min(8, (right - left) / 4), (left + right) / 2, right - Math.min(8, (right - left) / 4)]) {
      for (const y of [top + Math.min(4, (bottom - top) / 4), (top + bottom) / 2, bottom - Math.min(4, (bottom - top) / 4)]) {
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit)) return true;
      }
    }
    return false;
  };
  const tick = (now: number) => {
    if (stopped || completed) return;
    if (!valid()) start = null;
    else if (start === null) start = now;
    else if (now - start >= delay) { completed = true; presented(); return; }
    frame = requestAnimationFrame(tick);
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target !== element) continue;
      intersecting = entry.isIntersecting;
      if (!intersecting) {
        cancelAnimationFrame(frame);
        frame = 0;
        start = null;
      } else if (!frame && !completed && !stopped) frame = requestAnimationFrame(tick);
    }
  }, { threshold: 0 });
  // Background tabs may not run a frame between losing and regaining visibility.
  const reset = () => { start = null; };
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('blur', reset);
  observer.observe(element);
  return () => {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', reset);
    window.removeEventListener('blur', reset);
  };
}
