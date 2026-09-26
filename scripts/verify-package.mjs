import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, git, sdkIdentity } from './identity.mjs';
import { deploymentDescriptor, rollingIdentity } from './rolling-identity.mjs';

export async function verifyPackage(root, archive, sourceSha = git(root, ['rev-parse', 'HEAD'])) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok((await stat(archive)).size < 32 * 1024 * 1024);
  const sha256 = digest(await readFile(archive));
  assert.equal((await readFile(`${archive}.sha256`, 'utf8')).trim(), `${sha256}  ${basename(archive)}`);
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => !name.startsWith('/') && !name.split('/').includes('..') && !name.includes('\\')));
  const read = name => execFileSync('tar', ['-xOzf', archive, name], { maxBuffer: 32 * 1024 * 1024 });
  const receipt = JSON.parse(read('module-build.json'));
  const manifest = JSON.parse(read('cockpit.module.json'));
  assert.equal(receipt.format, 1);
  assert.equal(receipt.product, 'cockpit-notification');
  assert.equal(receipt.sourceSha, sourceSha);
  assert.deepEqual(receipt.sdk, await sdkIdentity(root));
  assert.equal(receipt.node, (await readFile(join(root, '.node-version'), 'utf8')).trim());
  const sourceManifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  if (receipt.sequence) {
    assert.equal(sourceManifest.version, '0.0.0-dev');
    assert.equal(receipt.version, rollingIdentity(receipt.sequence, sourceSha).version);
  }
  assert.deepEqual(manifest, { ...sourceManifest, version: receipt.sequence ? receipt.version : sourceManifest.version });
  assert.equal(receipt.version, manifest.version);
  assert.equal(basename(archive), `cockpit-notification-${manifest.version}.tgz`);
  const expected = new Set(['module-build.json']);
  for (const item of receipt.files) {
    assert.ok(item.path === 'LICENSE' || item.path === 'cockpit.module.json' ||
      (receipt.sequence && item.path === 'cockpit-deployment.json') || item.path.startsWith('dist/'));
    assert.ok(!item.path.split('/').some(part => !part || part === '.' || part === '..'));
    assert.ok(!expected.has(item.path));
    assert.doesNotMatch(item.path, /\.test\.|\.spec\.|node_modules|\.cockpit-sdk/);
    expected.add(item.path);
    const bytes = read(item.path);
    assert.equal(bytes.length, item.bytes);
    assert.equal(digest(bytes), item.sha256);
  }
  for (const name of names.filter(name => !name.endsWith('/'))) assert.ok(expected.delete(name), `Unexpected archive file: ${name}`);
  assert.equal(expected.size, 0);
  if (receipt.sequence) {
    const embedded = read('cockpit-deployment.json');
    const sidecar = await readFile(join(resolve(archive, '..'), 'cockpit-deployment.json'));
    assert.deepEqual(embedded, sidecar, 'Deployment sidecar differs from archive');
    assert.equal((await readFile(join(resolve(archive, '..'), 'cockpit-deployment.json.sha256'), 'utf8')).trim(),
      `${digest(sidecar)}  cockpit-deployment.json`);
    assert.deepEqual(JSON.parse(sidecar), await deploymentDescriptor(root, receipt));
  }
  return { version: manifest.version, sourceSha, sha256, files: receipt.files.length, sdk: receipt.sdk };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, sha, ...rest] = process.argv.slice(2);
  if (!archive || rest.length) throw new Error('Usage: verify-package.mjs ARCHIVE [SOURCE_SHA]');
  console.log(JSON.stringify(await verifyPackage(fileURLToPath(new URL('..', import.meta.url)), resolve(archive), sha)));
}
