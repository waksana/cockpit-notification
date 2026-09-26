import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promoteMilestone } from './promote-milestone.mjs';
import { rollingAssetNames } from './verify-rolling-assets.mjs';

const repository = 'waksana/cockpit-notification';
const tag = 'v0.0.0-rolling.31';
const sha = 'a'.repeat(40);
const base = `repos/${repository}/releases`;

async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve('node_modules/.milestone-test-'));
  t.after(() => rm(root, { recursive: true }));
  const release = { id: 4, tag_name: tag, target_commitish: sha,
    draft: false, prerelease: true, name: 'Complete PR title', body: 'Complete body\nand provenance' };
  const names = rollingAssetNames(tag);
  const bytes = names.map((_, i) => Buffer.from(`synthetic ${i}`));
  const state = { writes: [], downloads: 0, snapshots: 0, verified: 0,
    assets: names.map((name, i) => ({ id: 100 + i, name, size: bytes[i].length, state: 'uploaded' })) };
  const json = value => Buffer.from(JSON.stringify(value));
  const read = args => {
    const path = args[0];
    if (path === `${base}?per_page=100`) {
      state.snapshots++;
      if (options.changeMetadata && state.snapshots === 2) state.assets[0].id++;
      return json([[release]]);
    }
    if (path === `${base}/4` || path === `${base}/latest`) return json(release);
    if (path === `repos/${repository}/git/ref/tags/${tag}`) return json({
      ref: `refs/tags/${tag}`, object: { type: 'commit', sha },
    });
    if (path === `${base}/4/assets?per_page=100`) return json([state.assets]);
    const index = names.findIndex((_, i) => path === `${base}/assets/${100 + i}`);
    assert.ok(index >= 0, path);
    state.downloads++;
    return options.changeBytes && state.downloads > 4 ? Buffer.from('replacement') : bytes[index];
  };
  const write = (host, path, body, type, options) => {
    assert.equal(host, 'api.github.com');
    assert.equal(path, `/${base}/4`);
    assert.equal(type, 'application/json');
    assert.deepEqual(options, { method: 'PATCH' });
    const patch = JSON.parse(body);
    assert.deepEqual(patch, { prerelease: false, make_latest: 'true' });
    state.writes.push(patch);
    release.prerelease = false;
    if (state.lostResponse) throw new Error('response lost after acceptance');
  };
  const run = extra => promoteMilestone({ repository, tag, confirmation: tag, root, read, write,
    verify: () => { state.verified++; if (options.invalidArchive) throw new Error('invalid archive'); }, ...extra });
  return { state, release, run };
}

test('promotion changes only prerelease/Latest on the same release and verifies bytes before and after', async t => {
  const { state, release, run } = await fixture(t);
  const before = structuredClone(release);
  const result = await run();
  assert.deepEqual(release, { ...before, prerelease: false });
  assert.equal(result.id, before.id);
  assert.equal(state.writes.length, 1);
  assert.equal(state.downloads, 12);
  assert.equal(state.verified, 3);
});

for (const [label, options] of [
  ['changed metadata', { changeMetadata: true }], ['changed bytes', { changeBytes: true }],
  ['invalid archive', { invalidArchive: true }],
]) {
  test(`${label} prevents promotion`, async t => {
    const { state, run } = await fixture(t, options);
    await assert.rejects(run());
    assert.deepEqual(state.writes, []);
  });
}

test('missing assets, draft, non-Rolling tag and unconfirmed tag never write', async t => {
  const { state, release, run } = await fixture(t);
  await assert.rejects(run({ tag: 'v1.2.3', confirmation: 'v1.2.3' }));
  await assert.rejects(run({ confirmation: 'wrong' }));
  release.draft = true;
  await assert.rejects(run(), /published/);
  release.draft = false;
  state.assets.pop();
  await assert.rejects(run());
  assert.deepEqual(state.writes, []);
});

test('lost promotion response performs diagnostic readback but never retries', async t => {
  const { state, run } = await fixture(t);
  state.lostResponse = true;
  await assert.rejects(run(), /uncertain/);
  assert.equal(state.writes.length, 1);
});
