import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishRelease, writeGithub } from './publish-release.mjs';

const tag = 'v1.2.3';
const sha = 'a'.repeat(40);
const repository = 'synthetic/notification';
const base = `repos/${repository}/releases`;
const names = ['cockpit-notification-1.2.3.tgz', 'cockpit-notification-1.2.3.tgz.sha256'];

async function fixture(t, options = {}) {
  const tag = options.rolling ? 'v0.0.0-rolling.42' : 'v1.2.3';
  const archive = `cockpit-notification-${tag.slice(1)}.tgz`;
  const names = [archive, `${archive}.sha256`,
    ...(options.rolling ? ['cockpit-deployment.json', 'cockpit-deployment.json.sha256'] : [])].sort();
  const rolling = options.rolling ? { title: 'Complete PR title', notes: 'Full PR body\nand provenance' } : undefined;
  const directory = await mkdtemp(join(tmpdir(), 'notification-release-test-'));
  t.after(() => rm(directory, { recursive: true }));
  await mkdir(join(directory, 'docs'));
  await writeFile(join(directory, 'docs/release-notes.md'), 'Synthetic release notes');
  const bytes = names.map((_, i) => Buffer.from(`synthetic-${i}`));
  for (let i = 0; i < names.length; i++) await writeFile(join(directory, names[i]), bytes[i]);
  const draft = { id: 42, tag_name: tag, draft: true, prerelease: Boolean(rolling),
    target_commitish: rolling ? sha : 'main', ...(rolling ? { name: rolling.title, body: rolling.notes } : {}) };
  const state = {
    release: options.absent ? undefined : { ...draft, ...options.release },
    assets: names.map((name, i) => ({ id: 100 + i, name, size: bytes[i].length, state: 'uploaded' })),
    calls: [], writes: [], verifications: [], lists: 0,
  };
  const encode = value => Buffer.from(JSON.stringify(value));
  const write = async (hostname, path, body, contentType, { method = 'POST' } = {}) => {
    state.calls.push(['write', method, hostname, path]);
    if (path === `/${base}`) {
      assert.equal(hostname, 'api.github.com');
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(body), {
        tag_name: tag, target_commitish: sha, draft: true, prerelease: Boolean(rolling),
        name: rolling?.title ?? `Cockpit Notification ${tag}`, body: rolling?.notes ?? 'Synthetic release notes',
        ...(rolling ? { make_latest: 'false' } : { generate_release_notes: true }),
      });
      state.writes.push('create');
      state.release = { ...draft };
      state.assets = [];
      if (options.createError) throw new Error('create connection lost after acceptance');
      return encode(state.release);
    }
    if (method === 'PATCH') {
      assert.equal(hostname, 'api.github.com');
      assert.equal(path, `/${base}/42`);
      assert.deepEqual(JSON.parse(body), { draft: false, prerelease: Boolean(rolling), make_latest: rolling ? 'false' : 'true' });
      state.writes.push('publish');
      state.release.draft = false;
      if (options.publishError) throw new Error('publish response lost after acceptance');
      return encode(state.release);
    }
    assert.equal(hostname, 'uploads.github.com');
    assert.equal(contentType, 'application/octet-stream');
    const index = names.findIndex(name => path === `/${base}/42/assets?name=${encodeURIComponent(name)}`);
    assert.ok(index >= 0);
    assert.deepEqual(body, bytes[index]);
    state.writes.push('upload');
    state.assets.push({ id: 100 + index, name: names[index], size: bytes[index].length, state: 'uploaded' });
    if (options.uploadError) throw new Error('upload response lost after acceptance');
    return encode(state.assets.at(-1));
  };
  const gh = async args => {
    state.calls.push(args);
    assert.ok(!args.some(arg => arg.includes('/tags/')), 'Never use the published-tag endpoint');
    assert.equal(args[0], 'api');
    assert.ok(!args.includes('PATCH'), 'gh only performs reads');
    const endpoint = args[1];
    if (endpoint.endsWith('?per_page=100')) {
      assert.ok(args.includes('--paginate') && args.includes('--slurp'));
      if (endpoint === `${base}?per_page=100`) {
        state.lists++;
        if (options.lookupError || (options.finalReadError && state.writes.includes('publish'))) {
          throw new Error('HTTP 404: synthetic lookup failure');
        }
        if (options.staleList && state.lists > 1) throw new Error('Do not rediscover a known Release ID');
        // Put the exact tag on a later page; near matches must not count.
        const pages = [[{ ...draft, id: 1, tag_name: `${tag}0` }],
          state.release ? [state.release] : []];
        if (options.duplicate) pages.push([{ ...draft, id: 43 }]);
        return encode(pages);
      }
      assert.equal(endpoint, `${base}/42/assets?per_page=100`);
      return encode(state.assets.length ? state.assets.map(asset => [asset]) : [[]]);
    }
    if (endpoint === `${base}/42`) {
      if (options.disappear) throw new Error('Release disappeared');
      if (options.finalReadError && state.writes.includes('publish')) throw new Error('HTTP 404: synthetic direct lookup failure');
      return encode(options.changedId ? { ...state.release, id: 43 } : state.release);
    }
    const index = names.findIndex((_, i) => endpoint === `${base}/assets/${100 + i}`);
    assert.ok(index >= 0, `Unexpected API request: ${endpoint}`);
    assert.ok(args.includes('Accept: application/octet-stream'));
    state.assets[index].download_count = (state.assets[index].download_count ?? 0) + 1;
    return options.wrongBytes ? Buffer.from('wrong-bytes') : bytes[index];
  };
  const verify = async path => {
    state.verifications.push(path);
    if (options.verifyError) throw new Error(options.verifyError);
    for (let i = 0; i < names.length; i++) {
      assert.deepEqual(await readFile(join(path, names[i])), bytes[i]);
    }
    if (options.changeAssets && path !== directory) state.assets[0].id = 200;
  };
  const run = () => publishRelease({ root: directory, directory, repository, tag, sha, gh, write, verify, rolling });
  return { state, run };
}

test('Rolling uploads exactly four assets and never claims Latest; completed rerun is read-only', async t => {
  const { state, run } = await fixture(t, { absent: true, rolling: true });
  const result = await run();
  assert.equal(result.assets.length, 4);
  assert.equal(state.release.prerelease, true);
  assert.deepEqual(state.writes, ['create', 'upload', 'upload', 'upload', 'upload', 'publish']);
  state.writes.length = 0;
  assert.deepEqual(await run(), result);
  assert.deepEqual(state.writes, []);
});

for (const release of [{ target_commitish: 'b'.repeat(40) }, { name: 'changed title' },
  { body: 'truncated body' }, { prerelease: false }]) {
  test(`Rolling rejects immutable metadata drift ${Object.keys(release)[0]}`, async t => {
    const { state, run } = await fixture(t, { rolling: true, release });
    await assert.rejects(run());
    assert.deepEqual(state.writes, []);
  });
}

test('fresh release creates once, discovers the draft on a later page, and publishes by ID', async t => {
  const { state, run } = await fixture(t, { absent: true });
  assert.deepEqual(await run(), { id: 42, tag, sourceSha: sha, assets: names });
  assert.deepEqual(state.writes, ['create', 'upload', 'upload', 'publish']);
  assert.equal(state.verifications.length, 3);
  assert.equal(state.calls.filter(args => args.includes('Accept: application/octet-stream')).length, 4);
});

test('a complete existing draft resumes with no create or upload', async t => {
  const { state, run } = await fixture(t);
  await run();
  assert.deepEqual(state.writes, ['publish']);
  assert.equal(state.verifications.length, 3);
});

for (const absent of [true, false]) {
  test(`known Release ID bypasses stale listing (${absent ? 'new draft' : 'existing draft'})`, async t => {
    const { state, run } = await fixture(t, { absent, rolling: true, staleList: true });
    await run();
    assert.equal(state.lists, 1, 'Discovery is only needed before an ID is known');
    assert.equal(state.writes.filter(write => write === 'create').length, absent ? 1 : 0);
    assert.equal(state.writes.filter(write => write === 'publish').length, 1);
  });
}

for (const [label, options, expected] of [
  ['published', { release: { draft: false } }, /already published/],
  ['prerelease', { release: { prerelease: true } }, /Prerelease/],
  ['duplicate exact tags', { duplicate: true }, /Multiple Releases/],
  ['lookup failure is not absence', { absent: true, lookupError: true }, /HTTP 404/],
  ['disappeared draft', { disappear: true }, /disappeared/],
  ['changed Release ID', { changedId: true }, /Release ID changed/],
  ['wrong remote bytes', { wrongBytes: true }, /bytes differ/],
  ['asset race', { changeAssets: true }, /Assets changed/],
  ['moved tag', { verifyError: 'Version tag moved' }, /Version tag moved/],
  ['wrong source', { verifyError: 'sourceSha mismatch' }, /sourceSha mismatch/],
  ['wrong version', { verifyError: 'Tag and package version differ' }, /version differ/],
]) {
  test(`${label} stops without mutations`, async t => {
    const { state, run } = await fixture(t, options);
    await assert.rejects(run(), expected);
    assert.deepEqual(state.writes, []);
  });
}

for (const [label, change] of [
  ['missing', assets => assets.pop()],
  ['extra', assets => assets.push({ ...assets[0], id: 102, name: 'unexpected' })],
  ['duplicate names', assets => { assets[1].name = assets[0].name; }],
  ['duplicate IDs', assets => { assets[1].id = assets[0].id; }],
  ['incomplete', assets => { assets[0].state = 'new'; }],
  ['empty', assets => { assets[0].size = 0; }],
  ['wrong size', assets => { assets[0].size++; }],
]) {
  test(`${label} assets stop without upload, deletion or publication`, async t => {
    const { state, run } = await fixture(t);
    change(state.assets);
    await assert.rejects(run());
    assert.deepEqual(state.writes, []);
  });
}

for (const [label, options, writes] of [
  ['uncertain create', { absent: true, createError: true }, ['create']],
  ['uncertain upload', { absent: true, uploadError: true }, ['create', 'upload']],
  ['uncertain publish', { publishError: true }, ['publish']],
  ['uncertain write and failed diagnostic lookup',
    { absent: true, createError: true }, ['create']],
]) {
  test(`${label} only reads back and never retries or continues`, async t => {
    const { state, run } = await fixture(t, options);
    if (label.includes('failed diagnostic')) {
      Object.defineProperty(options, 'lookupError', { get: () => state.writes.length > 0 });
    }
    await assert.rejects(run(), /write failed or is uncertain.*inspect remote state/);
    assert.deepEqual(state.writes, writes);
    const lastWrite = state.calls.findLastIndex(args => args[0] === 'write');
    assert.equal(state.calls.length, lastWrite + 2, 'Only one diagnostic list request follows the failed write');
    assert.equal(state.calls.at(-1)[1],
      writes.length === 1 && writes[0] === 'create' ? `${base}?per_page=100` : `${base}/42`);
  });
}

for (const outcome of ['lost response', 'HTTP 500', 'HTTP 307', 'timeout', 'aborted response']) {
    test(`single-request upload transport does not retry ${outcome}`, async () => {
      let attempts = 0;
      let accepted = 0;
      const request = (options, onResponse) => {
        attempts++;
        assert.equal(options.hostname, 'uploads.github.com');
        assert.equal(options.method, 'POST');
        const req = new EventEmitter();
        req.destroy = error => req.emit('error', error);
        let timeout;
        req.setTimeout = (_, callback) => { timeout = callback; };
        req.end = body => {
          accepted++;
          assert.deepEqual(body, Buffer.from('synthetic'));
          if (outcome === 'lost response') req.emit('error', new Error('ECONNRESET after acceptance'));
          else if (outcome === 'timeout') timeout();
          else {
            const response = new EventEmitter();
            response.statusCode = outcome === 'HTTP 500' ? 500 : 307;
            onResponse(response);
            if (outcome === 'aborted response') response.emit('aborted');
            else response.emit('end');
          }
        };
        return req;
      };
      await assert.rejects(writeGithub('uploads.github.com', '/synthetic', Buffer.from('synthetic'),
        'application/octet-stream', { token: 'synthetic-token', request }));
      assert.equal(attempts, 1);
      assert.equal(accepted, 1);
    });
}

test('failed final readback does not retry publication', async t => {
  const { state, run } = await fixture(t, { finalReadError: true });
  await assert.rejects(run(), /HTTP 404/);
  assert.deepEqual(state.writes, ['publish']);
});
