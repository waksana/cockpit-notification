import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergedIdentity, releaseNotes } from './rolling-identity.mjs';
import { publishRelease, writeGithub } from './publish-release.mjs';
import { checkRelease } from './check-release.mjs';

export const githubRead = args => execFileSync('gh', ['api', ...args], { maxBuffer: 40 * 1024 * 1024 });

export async function ensureTag(repository, identity, { read = githubRead, write = writeGithub } = {}) {
  const endpoint = `repos/${repository}/git/matching-refs/tags/${identity.tag}`;
  const inspect = async () => {
    const matches = JSON.parse((await read([endpoint])).toString())
      .filter(ref => ref.ref === `refs/tags/${identity.tag}`);
    assert.ok(matches.length <= 1);
    if (matches.length) {
      assert.equal(matches[0].object.type, 'commit');
      assert.equal(matches[0].object.sha, identity.sourceSha, 'Rolling tag moved');
    }
    return matches[0];
  };
  if (!await inspect()) {
    try {
      await write('api.github.com', `/repos/${repository}/git/refs`, Buffer.from(JSON.stringify({
        ref: `refs/tags/${identity.tag}`, sha: identity.sourceSha,
      })), 'application/json');
    } catch (cause) {
      let observed;
      try { observed = Boolean(await inspect()); } catch { observed = 'unknown'; }
      throw new Error(`Tag write uncertain; observed=${observed}; inspect, never retry automatically`, { cause });
    }
    assert.ok(await inspect(), 'Created tag was not observed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY;
  const identity = mergedIdentity(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
    process.env.GITHUB_RUN_NUMBER, repository);
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), identity.sourceSha);
  execFileSync('git', ['merge-base', '--is-ancestor', identity.sourceSha, 'origin/main']);
  const directory = resolve(process.argv[2] ?? 'release-artifact');
  await checkRelease(root, identity.tag, identity.sourceSha, directory);
  const names = (await readdir(directory)).sort();
  await ensureTag(repository, identity);
  console.log(JSON.stringify(await publishRelease({ repository, tag: identity.tag, sha: identity.sourceSha,
    directory, root, rolling: { title: identity.title, notes: releaseNotes(identity, names) } })));
}
