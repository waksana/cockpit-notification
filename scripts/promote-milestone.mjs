import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGithub } from './publish-release.mjs';
import { rollingAssetNames, verifyRollingAssets } from './verify-rolling-assets.mjs';

const readGithub = args => execFileSync('gh', ['api', ...args], { maxBuffer: 40 * 1024 * 1024 });
export async function promoteMilestone({ repository, tag, confirmation, root,
  read = readGithub, write = writeGithub, verify = verifyRollingAssets }) {
  assert.equal(repository, 'waksana/cockpit-notification');
  const names = rollingAssetNames(tag);
  assert.equal(confirmation, tag, 'Repeat the selected tag exactly');
  const base = `repos/${repository}/releases`;
  const json = async args => JSON.parse((await read(args)).toString());
  const pages = async path => {
    const result = await json([`${path}?per_page=100`, '--paginate', '--slurp']);
    assert.ok(Array.isArray(result) && result.every(Array.isArray));
    return result.flat();
  };
  const snapshot = async () => {
    const matches = (await pages(base)).filter(release => release.tag_name === tag);
    assert.equal(matches.length, 1, 'Expected exactly one existing Rolling Release');
    const release = await json([`${base}/${matches[0].id}`]);
    assert.equal(release.tag_name, tag);
    assert.equal(release.draft, false, 'Only a published Rolling can be promoted');
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
    const ref = await json([`repos/${repository}/git/ref/tags/${tag}`]);
    assert.equal(ref.ref, `refs/tags/${tag}`);
    assert.equal(ref.object.type, 'commit');
    assert.match(ref.object.sha, /^[a-f0-9]{40}$/);
    assert.equal(release.target_commitish, ref.object.sha, 'Release source differs from tag');
    const assets = (await pages(`${base}/${release.id}/assets`)).map(
      ({ id, name, size, state, digest, created_at, updated_at }) =>
        ({ id, name, size, state, digest, created_at, updated_at })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(assets.map(asset => asset.name), names);
    assert.equal(new Set(assets.map(asset => asset.id)).size, names.length);
    for (const asset of assets) {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
      assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
      assert.equal(asset.state, 'uploaded');
    }
    return { id: release.id, tag, sourceSha: ref.object.sha, name: release.name, body: release.body,
      prerelease: release.prerelease, assets };
  };
  const before = await snapshot();
  assert.equal(before.prerelease, true, 'Selected Release is not an unpromoted Rolling');
  const directory = await mkdtemp(join(root, '.release-readback-'));
  try {
    const original = new Map();
    const download = async (state, compare) => {
      for (const asset of state.assets) {
        const bytes = await read([`${base}/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']);
        assert.equal(bytes.length, asset.size);
        if (compare) assert.deepEqual(bytes, original.get(asset.name), 'Asset bytes changed');
        else original.set(asset.name, bytes);
        await writeFile(join(directory, asset.name), bytes);
      }
      await verify(directory, { repository, tag, sourceSha: state.sourceSha });
    };
    await download(before, false);
    assert.deepEqual(await snapshot(), before, 'Release identity changed during verification');
    // A second byte read rejects replacement under otherwise unchanged metadata.
    await download(before, true);
    assert.deepEqual(await snapshot(), before, 'Release identity changed before promotion');
    try {
      await write('api.github.com', `/${base}/${before.id}`,
        Buffer.from(JSON.stringify({ prerelease: false, make_latest: 'true' })),
        'application/json', { method: 'PATCH' });
    } catch (cause) {
      let observed;
      try { observed = (await snapshot()).prerelease; } catch { observed = 'unknown'; }
      throw new Error(`Promotion write uncertain (prerelease=${observed}); inspect without retry`, { cause });
    }
    const after = await snapshot();
    assert.deepEqual(after, { ...before, prerelease: false }, 'Promotion changed immutable identity');
    await download(after, true);
    assert.equal((await json([`${base}/latest`])).id, before.id, 'Selected Milestone is not Latest');
    return after;
  } finally { await rm(directory, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await promoteMilestone({ repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.MILESTONE_TAG, confirmation: process.env.MILESTONE_CONFIRM_TAG,
    root: fileURLToPath(new URL('..', import.meta.url)) })));
}
