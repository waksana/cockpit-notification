import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRelease, checkTagTarget } from './check-release.mjs';
import { digest, sdkIdentity } from './identity.mjs';

test('Rolling workflow binds every merged PR to exact source without filtering or cancellation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const text of ['uses: ./.github/workflows/ci.yml', 'actions: read', 'types: [closed]',
    'github.event.pull_request.merged == true', 'github.event.pull_request.merge_commit_sha',
    'github.run_number', 'node scripts/publish-rolling.mjs release-artifact']) {
    assert.ok(workflow.includes(text), text);
  }
  assert.doesNotMatch(workflow, /releases\/tags\/|gh release (?:edit|download)/);
  assert.doesNotMatch(workflow, /--clobber|pnpm (?:build|package)|secrets\.|pull_request\.head/);
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /\nconcurrency:|paths:|paths-ignore:|labels|run_attempt|push:/);
  for (const [, use] of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
    if (!use.startsWith('./')) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
  }
});

test('remote tag must still resolve to the checked source', () => {
  const sha = 'a'.repeat(40);
  checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${sha}\trefs/tags/v0.1.0^{}`);
  assert.throws(() => checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0`), /moved/);
  assert.throws(() => checkTagTarget('v0.1.0', sha, ''), /missing/);
});

test('release identity gate rejects wrong version, source and package bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notification-release-identity-'));
  t.after(() => rm(root, { recursive: true }));
  const sdkName = '@waksana/cockpit-module-sdk';
  const sdkVersion = '0.2.0';
  const sdk = join(root, 'node_modules', sdkName);
  const artifact = join(root, 'artifact');
  const contents = join(root, 'contents');
  for (const directory of [sdk, artifact, contents, join(root, 'docs'), join(root, 'tooling')]) {
    await mkdir(directory, { recursive: true });
  }
  const save = (path, data) => writeFile(join(root, path), JSON.stringify(data));
  const metadata = { version: '1.2.3', devDependencies: { [sdkName]: sdkVersion } };
  const manifest = { id: 'cockpit-notification', version: '1.2.3' };
  await save('package.json', metadata);
  await save('cockpit.module.json', manifest);
  await save('pnpm-lock.yaml', {
    importers: { '.': { devDependencies: { [sdkName]: { specifier: sdkVersion, version: sdkVersion } } } },
    packages: { [`${sdkName}@${sdkVersion}`]: { resolution: {
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      tarball: `https://npm.pkg.github.com/download/${sdkName}/${sdkVersion}/synthetic`,
    } } },
  });
  await save(`node_modules/${sdkName}/package.json`, { name: sdkName, version: sdkVersion });
  await save('tooling/integration-host.json', { repository: 'waksana/cockpit', commit: 'b'.repeat(40) });
  await writeFile(join(root, '.node-version'), '24.20.0');
  await writeFile(join(root, 'docs/release-notes.md'), '# Cockpit Notification 1.2.3\n');
  await save('contents/cockpit.module.json', manifest);
  const manifestBytes = await readFile(join(contents, 'cockpit.module.json'));
  const sha = 'a'.repeat(40);
  await save('contents/module-build.json', {
    format: 1, product: 'cockpit-notification', version: '1.2.3', sourceSha: sha,
    node: '24.20.0', sdk: await sdkIdentity(root),
    files: [{ path: 'cockpit.module.json', bytes: manifestBytes.length, sha256: digest(manifestBytes) }],
  });
  const archive = join(artifact, 'cockpit-notification-1.2.3.tgz');
  execFileSync('tar', ['-czf', archive, '-C', contents, 'cockpit.module.json', 'module-build.json']);
  await writeFile(`${archive}.sha256`, `${digest(await readFile(archive))}  cockpit-notification-1.2.3.tgz\n`);
  assert.equal((await checkRelease(root, 'v1.2.3', sha, artifact)).sourceSha, sha);
  await assert.rejects(checkRelease(root, 'v1.2.3', 'c'.repeat(40), artifact));
  await save('package.json', { ...metadata, version: '1.2.4' });
  await assert.rejects(checkRelease(root, 'v1.2.3', sha, artifact), /Tag and package version differ/);
  await save('package.json', metadata);
  await save('cockpit.module.json', { ...manifest, version: '1.2.4' });
  await assert.rejects(checkRelease(root, 'v1.2.3', sha, artifact), /Tag and module version differ/);
  await save('cockpit.module.json', manifest);
  await writeFile(archive, 'changed archive');
  await assert.rejects(checkRelease(root, 'v1.2.3', sha, artifact));
});
