import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { git } from './identity.mjs';
import { checkedIntegrationHost, integrationHost } from './integration-host.mjs';

test('integration accepts only its exact clean host source, independently from the SDK package', async t => {
  const root = await mkdtemp(resolve('node_modules/.integration-host-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tooling'));
  const host = join(root, 'host');
  await mkdir(host);
  execFileSync('git', ['init', '-q', host]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic host', '--allow-empty'], { cwd: host });
  const pairing = { repository: 'waksana/cockpit', commit: git(host, ['rev-parse', 'HEAD']) };
  const save = () => writeFile(join(root, 'tooling/integration-host.json'), JSON.stringify(pairing));
  await save();
  assert.deepEqual(await checkedIntegrationHost(root, host), pairing);
  pairing.commit = 'a'.repeat(40);
  await save();
  await assert.rejects(checkedIntegrationHost(root, host), /exact paired host/);
  pairing.commit = git(host, ['rev-parse', 'HEAD']);
  await save();
  await writeFile(join(host, 'untracked'), 'synthetic');
  await assert.rejects(checkedIntegrationHost(root, host), /exact paired host/);
  pairing.commit = 'main';
  await save();
  await assert.rejects(integrationHost(root), /Invalid integration/);
});
