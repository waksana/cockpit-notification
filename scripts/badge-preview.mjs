import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [hostDist, port = '47832', ...extra] = process.argv.slice(2);
if (!hostDist || extra.length || !/^\d+$/.test(port) || +port < 1024 || +port > 65535) {
  throw new Error('Usage: node scripts/badge-preview.mjs /absolute/host/apps/web/dist [port]');
}
const assets = join(resolve(hostDist), 'assets');
const names = (await readdir(assets)).filter(name => /^(?:index|classic)-.*\.css$/.test(name));
if (names.length !== 1) throw new Error('Expected exactly one built host classic stylesheet');
const hostCss = await readFile(join(assets, names[0]));
const moduleCss = fileURLToPath(new URL('../src/web/styles.css', import.meta.url));
const counts = [1, 8, 9, 10, 99, 128, 1000];
const statuses = ['waiting', 'running', 'error', 'idle'];
const statusLabels = { waiting: '待回答', running: '回复中', error: '出错', idle: '' };
const rows = counts.map(count => `
  <li><button type="button" class="chatlist-chat ck-button${count === 9 ? ' is-unloaded' : ''}${count === 99 ? ' active' : ''}">
    <span class="dialog-avatar" aria-hidden="true">FX</span>
    <span class="session-row-title">Synthetic long session title</span>
    <span class="dialog-time">12m</span>
    <span class="dialog-subtitle">/synthetic/workspace</span>
    <span class="dialog-meta">STATUS
      <span class="ck-badge cn-session-badge${count === 8 ? ' cn-stale' : ''}"
        aria-label="${count} unread" data-count="${count}">${count}</span>
    </span>
  </button></li>`).join('');
const statusRows = statuses.map(status => rows.replaceAll('STATUS', statusLabels[status]
  ? `<span class="dialog-status" data-tone="${status}">${statusLabels[status]}</span>` : '')).join('');
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synthetic unread badge geometry</title>
<link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/module.css">
<style>
body { overflow: auto; padding: 16px; }
main { display: flex; flex-wrap: wrap; gap: 24px; align-items: start; }
section { inline-size: 220px; max-inline-size: 100%; }
section.wide { inline-size: 360px; }
section.large { --ck-text-meta: 24px; }
h1, h2, pre { font-size: 14px; }
</style>
<h1>Synthetic unread counts; no backend, native state or push access</h1>
<main><section><h2>Narrow</h2><ul class="chatlist">${statusRows}</ul></section>
<section class="wide"><h2>Wide</h2><ul class="chatlist">${statusRows}</ul></section>
<section class="wide large"><h2>Double badge text size</h2><ul class="chatlist">${statusRows}</ul></section></main>
<pre id="result">Measuring...</pre>
<script>
window.measureBadges = () => {
  window.badgeResults = [...document.querySelectorAll('[data-count]')].map(badge => {
    const rect = badge.getBoundingClientRect(), css = getComputedStyle(badge);
    const range = document.createRange(); range.selectNodeContents(badge);
    const text = range.getBoundingClientRect();
    const inside = (a, b) => a.left >= b.left - .5 && a.right <= b.right + .5
      && a.top >= b.top - .5 && a.bottom <= b.bottom + .5;
    let unclipped = true;
    for (let p = badge.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), r = p.getBoundingClientRect();
      if (p !== document.body && p !== document.documentElement && /(hidden|clip|auto|scroll)/.test(s.overflowX)
        && (rect.left < r.left - .5 || rect.right > r.right + .5)) unclipped = false;
      if (p !== document.body && p !== document.documentElement && /(hidden|clip|auto|scroll)/.test(s.overflowY)
        && (rect.top < r.top - .5 || rect.bottom > r.bottom + .5)) unclipped = false;
    }
    const circle = badge.dataset.count.length !== 1 || Math.abs(rect.width - rect.height) < .5;
    const rounded = parseFloat(css.borderTopLeftRadius) >= rect.height / 2;
    return { count: badge.dataset.count, width: rect.width, height: rect.height,
      circle, rounded, unclipped, textInside: inside(text, rect),
      noShrink: css.flexShrink === '0', noWrap: css.whiteSpace === 'nowrap' };
  });
  const passed = window.badgeResults.every(r =>
    r.circle && r.rounded && r.unclipped && r.textInside && r.noShrink && r.noWrap);
  document.querySelector('#result').textContent = (passed ? 'PASS' : 'FAIL')
    + '\\n' + JSON.stringify(window.badgeResults, null, 2);
  document.documentElement.dataset.result = passed ? 'pass' : 'fail';
  return { passed, count: window.badgeResults.length,
    failures: window.badgeResults.filter(r => !(r.circle && r.rounded && r.unclipped && r.textInside && r.noShrink && r.noWrap)) };
};
window.addEventListener('load', window.measureBadges);
</script></html>`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/') response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    else if (path === '/host.css') response.writeHead(200, { 'content-type': 'text/css' }).end(hostCss);
    else if (path === '/module.css') response.writeHead(200, {
      'content-type': 'text/css', 'cache-control': 'no-store',
    }).end(await readFile(moduleCss));
    else response.writeHead(404).end('Not found');
  } catch (error) {
    console.error(error);
    response.writeHead(500).end('Fixture failed to read its styles');
  }
});
server.listen(+port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
