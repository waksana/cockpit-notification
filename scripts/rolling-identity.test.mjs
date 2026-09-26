import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIdentity, deploymentDescriptor, mergedIdentity, moduleProduct, releaseNotes, rollingIdentity } from './rolling-identity.mjs';
import { ensureTag } from './publish-rolling.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'waksana/cockpit-notification';
const sha = 'a'.repeat(40);
const event = (number, title = 'docs: complete title') => ({ action: 'closed', pull_request: {
  number, merged: true, merge_commit_sha: sha, title, body: 'Full body\n\nincluding details',
  html_url: `https://github.com/${repository}/pull/${number}`, base: { ref: 'main', repo: { full_name: repository } },
} });

test('consecutive merged docs/chore/fix/features all receive independent sequence identities', () => {
  const identities = ['docs:', 'chore:', 'fix:', 'feat:'].map((title, index) =>
    mergedIdentity(event(index + 1, title), index + 31, repository));
  assert.deepEqual(identities.map(item => item.sequence), [31, 32, 33, 34]);
  const finished = [identities[3], identities[1], identities[0]];
  assert.equal(finished.reduce((latest, item) => latest.sequence > item.sequence ? latest : item).sequence, 34);
  assert.equal(mergedIdentity(event(4), 34, repository).tag, 'v0.0.0-rolling.34',
    'a failed earlier build does not block or renumber later merges');
  assert.deepEqual(mergedIdentity(event(1), 31, repository), mergedIdentity(event(1), 31, repository),
    'reruns retain workflow run number and original event');
  const rejected = event(1);
  rejected.pull_request.merged = false;
  assert.throws(() => mergedIdentity(rejected, 31, repository), /actually merged/);
});

test('version injection leaves committed development identity and includes full PR notes', async () => {
  assert.equal(JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version, '0.0.0-dev');
  assert.equal(JSON.parse(await readFile(new URL('../cockpit.module.json', import.meta.url))).version, '0.0.0-dev');
  assert.equal(buildIdentity('0.0.0-dev', sha, '').displayVersion, 'dev+aaaaaaa');
  assert.equal(buildIdentity('0.0.0-dev', sha, '9').version, '0.0.0-rolling.9');
  for (const sequence of ['0', '-1', '1.1', '01', '9007199254740992']) {
    assert.throws(() => rollingIdentity(sequence, sha));
  }
  const identity = mergedIdentity(event(4), 9, repository);
  const notes = releaseNotes(identity, ['archive.tgz']);
  assert.ok(notes.includes(identity.title) && notes.includes(identity.body) && notes.includes(sha));
});

test('source-derived module deployment contract declares real frontend capabilities and no fictional database', async () => {
  const product = await moduleProduct(root);
  assert.deepEqual(product.requiresCapabilities, ['module-api.v1', 'frontend-api.v2', 'ui.v1', 'uiSurface.v1', 'menu.v1']);
  assert.deepEqual(product.hostApi, { min: 1, max: 1 });
  assert.deepEqual(product.databases, []);
  assert.deepEqual(product.migrations, []);
  const descriptor = await deploymentDescriptor(root, rollingIdentity(1, sha));
  assert.equal(descriptor.format, 2);
  assert.equal(descriptor.channel, 'rolling');
  assert.equal(descriptor.archive.name, 'cockpit-notification-0.0.0-rolling.1.tgz');
  assert.deepEqual(Object.keys(descriptor.archive), ['name']);
});

test('immutable tag creation writes once and matching rerun never writes', async () => {
  let ref, writes = 0;
  const identity = rollingIdentity(12, sha);
  const read = () => Buffer.from(JSON.stringify(ref ? [ref] : []));
  const write = (_, path, body) => {
    writes++;
    assert.equal(path, `/repos/${repository}/git/refs`);
    assert.deepEqual(JSON.parse(body), { ref: `refs/tags/${identity.tag}`, sha });
    ref = { ref: `refs/tags/${identity.tag}`, object: { type: 'commit', sha } };
  };
  await ensureTag(repository, identity, { read, write });
  await ensureTag(repository, identity, { read, write });
  assert.equal(writes, 1);
  ref.object.sha = 'b'.repeat(40);
  await assert.rejects(ensureTag(repository, identity, { read, write }), /moved/);
  assert.equal(writes, 1);
});

test('lost tag write response is observed but never retried or continued', async () => {
  let writes = 0;
  await assert.rejects(ensureTag(repository, rollingIdentity(12, sha), {
    read: () => Buffer.from('[]'),
    write: () => { writes++; throw new Error('timeout after accepted'); },
  }), /uncertain/);
  assert.equal(writes, 1);
});

test('Milestone workflow is explicit confirmation only, without build/tag/asset writes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/milestone.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_tag:/);
  assert.match(workflow, /promote-milestone\.mjs/);
  assert.doesNotMatch(workflow, /pnpm|push:|pull_request:|upload-artifact|release create|git tag/);
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(ci, /concurrency:|cancel-in-progress/);
});
