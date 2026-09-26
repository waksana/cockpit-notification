import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest } from './identity.mjs';
import { deploymentDescriptor, rollingIdentity } from './rolling-identity.mjs';
import { verifyRollingAssets } from './verify-rolling-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const identity = rollingIdentity(18, 'a'.repeat(40));
const repository = 'waksana/cockpit-notification';

async function fixture(t, { missingEntrypoints = false } = {}) {
  const base = await mkdtemp(resolve('node_modules/.rolling-archive-test-'));
  t.after(() => rm(base, { recursive: true }));
  const contents = join(base, 'contents'), output = join(base, 'output');
  await mkdir(contents);
  await mkdir(output);
  const descriptor = await deploymentDescriptor(root, identity);
  const manifest = { ...JSON.parse(await readFile(join(root, 'cockpit.module.json'))), version: identity.version };
  const files = { 'cockpit-deployment.json': JSON.stringify(descriptor),
    'cockpit.module.json': JSON.stringify(manifest),
    'dist/package.json': JSON.stringify({ name: manifest.id, version: identity.version, type: 'module' }),
    ...(missingEntrypoints ? {} : {
      'dist/server/index.js': 'export const synthetic = true;',
      'dist/web/index.js': 'export const synthetic = true;',
      'dist/worker/index.js': 'const synthetic = true;',
      'dist/web/styles.css': '.synthetic {}',
    }) };
  for (const directory of ['dist/server', 'dist/web', 'dist/worker']) {
    await mkdir(join(contents, directory), { recursive: true });
  }
  const receipt = { format: 1, product: manifest.id, ...identity, files: Object.entries(files).map(
    ([path, data]) => ({ path, bytes: Buffer.byteLength(data), sha256: digest(data) })) };
  for (const [name, data] of Object.entries({ ...files, 'module-build.json': JSON.stringify(receipt) })) {
    await writeFile(join(contents, name), data);
  }
  const archive = join(output, descriptor.archive.name);
  execFileSync('tar', ['-czf', archive, '-C', contents, ...Object.keys(files), 'module-build.json']);
  const checksum = async name => writeFile(join(output, `${name}.sha256`),
    `${digest(await readFile(join(output, name)))}  ${name}\n`);
  await checksum(descriptor.archive.name);
  await writeFile(join(output, 'cockpit-deployment.json'), files['cockpit-deployment.json']);
  await checksum('cockpit-deployment.json');
  return { output, archive, descriptor, checksum,
    verify: extra => verifyRollingAssets(output, { repository, ...identity, ...extra }) };
}

test('real archive validates both checksums, inventory, source, version and byte-identical embedded descriptor', async t => {
  const { descriptor, verify } = await fixture(t);
  assert.deepEqual(await verify(), descriptor);
  await assert.rejects(verify({ sourceSha: 'b'.repeat(40) }));
  await assert.rejects(verify({ tag: 'v0.0.0-rolling.19' }));
  await assert.rejects(verify({ repository: 'other/repo' }));
});

test('rehashed sidecar replacement cannot hide disagreement with embedded bytes', async t => {
  const { output, descriptor, checksum, verify } = await fixture(t);
  await writeFile(join(output, 'cockpit-deployment.json'), JSON.stringify({ ...descriptor, sequence: 99 }));
  await checksum('cockpit-deployment.json');
  await assert.rejects(verify(), /Embedded descriptor/);
});

test('missing asset and changed archive bytes prevent promotion verification', async t => {
  const { archive, output, verify } = await fixture(t);
  await writeFile(archive, 'changed archive');
  await assert.rejects(verify(), /Checksum/);
  await rm(join(output, 'cockpit-deployment.json.sha256'));
  await assert.rejects(verify());
});

test('self-consistent archive and checksums cannot omit declared runtime entrypoints', async t => {
  const { verify } = await fixture(t, { missingEntrypoints: true });
  await assert.rejects(verify(), /Missing or invalid runtime entrypoint/);
});
