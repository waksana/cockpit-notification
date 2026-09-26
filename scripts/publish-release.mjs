import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationSeal, readPublicationSeal, verifyPublicationSeal } from './publication-seal.mjs';

const runGh = (args, input) => execFileSync('gh', args, {
  input, maxBuffer: 40 * 1024 * 1024, timeout: 120_000,
});

// Unlike gh release create, this transport never retries an upload or follows a redirect.
export function writeGithub(hostname, path, body, contentType, {
  token = process.env.GH_TOKEN, request = httpsRequest, method = 'POST',
} = {}) {
  assert.ok(token, 'GH_TOKEN is required for Release writes');
  return new Promise((resolveWrite, reject) => {
    const req = request({
      hostname, path, method,
      headers: {
        Authorization: `Bearer ${token}`, 'User-Agent': 'cockpit-notification-release',
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': contentType, 'Content-Length': body.length,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('GitHub write response aborted')));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub write HTTP ${response.statusCode}`));
        } else {
          resolveWrite(Buffer.concat(chunks));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('GitHub write timed out')));
    req.end(body);
  });
}

export async function publishRelease({ repository, tag, sha, directory, root, gh = runGh,
  rolling,
  write = writeGithub,
  verify = path => execFileSync(process.execPath,
    [join(root, 'scripts/check-release.mjs'), tag, sha, path], { stdio: 'inherit' }) }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(tag, rolling ? /^v0\.0\.0-rolling\.[1-9]\d*$/ : /^v\d+\.\d+\.\d+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const base = `repos/${repository}/releases`;
  const archive = `cockpit-notification-${tag.slice(1)}.tgz`;
  const names = [archive, `${archive}.sha256`,
    ...(rolling ? ['cockpit-deployment.json', 'cockpit-deployment.json.sha256'] : [])].sort();
  let knownId;
  const json = async args => JSON.parse((await gh(['api', ...args])).toString());
  const pages = async endpoint => {
    const result = await json([`${endpoint}?per_page=100`, '--paginate', '--slurp']);
    assert.ok(Array.isArray(result) && result.length > 0 && result.every(Array.isArray),
      'Invalid paginated API response');
    return result.flat();
  };
  const discover = async () => {
    const matches = (await pages(base)).filter(release => release.tag_name === tag);
    assert.ok(matches.length <= 1, `Multiple Releases match ${tag}; refusing a conflict`);
    return matches[0];
  };
  const checkMetadata = (release, draft, id) => {
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid Release ID');
    if (id !== undefined) assert.equal(release.id, id, 'Release ID changed');
    assert.equal(release.tag_name, tag, 'Release tag changed');
    assert.equal(release.draft, draft, draft ? 'Release is already published' : 'Release is still a draft');
    assert.equal(release.prerelease, Boolean(rolling), 'Prerelease conflicts with publication channel');
    if (rolling) {
      assert.equal(release.target_commitish, sha, 'Release source changed');
      assert.equal(release.name, rolling.title, 'Release title changed');
      if (release.body !== rolling.notes) {
        assert.equal(readPublicationSeal(release.body).notes, rolling.notes, 'Release notes changed');
      } else assert.equal(draft, true, 'Published Rolling is missing original asset identity');
    }
  };
  const snapshot = async (id, draft) => {
    // Listing can lag creation/publication. Once selected, the ID endpoint owns
    // readback; absence there is an error, never permission to create again.
    const release = await json([`${base}/${id}`]);
    checkMetadata(release, draft, id);
    const assets = await pages(`${base}/${id}/assets`);
    assert.deepEqual(assets.map(asset => asset.name).sort(), names, 'Incomplete or conflicting Release assets');
    assert.equal(new Set(assets.map(asset => asset.id)).size, names.length, 'Duplicate asset IDs');
    for (const asset of assets) {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset ID');
      assert.equal(asset.state, 'uploaded', 'Asset upload is incomplete');
      assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid asset size');
    }
    if (rolling && release.body !== rolling.notes) {
      verifyPublicationSeal(release.body, { releaseId: id, tag, sourceSha: sha }, assets, expected);
    }
    // Download counters and URLs can change without changing asset identity.
    return assets.map(({ id: assetId, name, size, state, digest, created_at, updated_at }) => ({
      id: assetId, name, size, state, digest, created_at, updated_at,
    })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const mutate = async operation => {
    try {
      return await operation();
    } catch (error) {
      // A failed command may already have changed GitHub. Observe, never retry.
      let observation;
      try {
        const remote = knownId === undefined ? await discover() : await json([`${base}/${knownId}`]);
        observation = remote ? `Release id=${remote.id}, draft=${remote.draft}` : 'no exact-tag Release observed';
      } catch (lookupError) {
        observation = `readback also failed: ${lookupError.message}`;
      }
      throw new Error(`Release write failed or is uncertain (${observation}); inspect remote state before another run`, { cause: error });
    }
  };
  await verify(directory);
  const expected = new Map(await Promise.all(names.map(async name => [name, await readFile(join(directory, name))])));
  let release = await discover();
  if (release) {
    checkMetadata(release, rolling ? release.draft : true);
    knownId = release.id;
  } else {
    const body = Buffer.from(JSON.stringify({
      tag_name: tag, target_commitish: sha, draft: true, prerelease: Boolean(rolling),
      name: rolling?.title ?? `Cockpit Notification ${tag}`,
      body: rolling?.notes ?? await readFile(join(root, 'docs/release-notes.md'), 'utf8'),
      ...(rolling ? { make_latest: 'false' } : { generate_release_notes: true }),
    }));
    const created = JSON.parse((await mutate(() =>
      write('api.github.com', `/${base}`, body, 'application/json'))).toString());
    checkMetadata(created, true);
    knownId = created.id;
    release = await json([`${base}/${knownId}`]);
    checkMetadata(release, true, created.id);
    assert.deepEqual(await pages(`${base}/${release.id}/assets`), [], 'New draft already has assets');
    for (const name of names) {
      await mutate(() => write('uploads.github.com',
        `/${base}/${release.id}/assets?name=${encodeURIComponent(name)}`,
        expected.get(name), 'application/octet-stream'));
    }
  }
  const id = release.id;
  const downloaded = await mkdtemp(join(root, '.release-readback-'));
  try {
    const checkAssets = async assets => {
      for (const asset of assets) {
        assert.equal(asset.size, expected.get(asset.name).length, 'Asset size differs from checked CI artifact');
        const bytes = await gh(['api', `${base}/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']);
        assert.deepEqual(bytes, expected.get(asset.name), 'Asset bytes differ from checked CI artifact');
        await writeFile(join(downloaded, asset.name), bytes);
      }
      await verify(downloaded);
    };
    const draft = release.draft;
    const assets = await snapshot(id, draft);
    await checkAssets(assets);
    assert.deepEqual(await snapshot(id, draft), assets, 'Assets changed during verification');
    if (draft) await mutate(() => write('api.github.com', `/${base}/${id}`,
      Buffer.from(JSON.stringify({ draft: false, prerelease: Boolean(rolling), make_latest: rolling ? 'false' : 'true',
        ...(rolling ? { body: publicationSeal(rolling.notes, { releaseId: id, tag, sourceSha: sha }, assets, expected) } : {}) })),
      'application/json', { method: 'PATCH' }));
    const published = await snapshot(id, false);
    assert.deepEqual(published, assets, 'Assets changed during publication');
    await checkAssets(published);
    return { id, tag, sourceSha: sha, assets: names };
  } finally {
    await rm(downloaded, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, directory, ...extra] = process.argv.slice(2);
  if (!tag || !sha || !directory || extra.length) throw new Error('Usage: publish-release.mjs TAG SOURCE_SHA ARTIFACT_DIRECTORY');
  console.log(JSON.stringify(await publishRelease({
    repository: process.env.GITHUB_REPOSITORY, tag, sha, directory: resolve(directory),
    root: fileURLToPath(new URL('..', import.meta.url)),
  })));
}
