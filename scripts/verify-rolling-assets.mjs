import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rollingIdentity } from './rolling-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function rollingAssetNames(tag) {
  assert.match(tag, /^v0\.0\.0-rolling\.[1-9]\d*$/);
  const archive = `cockpit-notification-${tag.slice(1)}.tgz`;
  return [archive, `${archive}.sha256`, 'cockpit-deployment.json', 'cockpit-deployment.json.sha256'].sort();
}

// Standalone verification for promotion: never compares an old package to today's source.
export async function verifyRollingAssets(directory, { repository, tag, sourceSha }) {
  const identity = rollingIdentity(tag.split('.').at(-1), sourceSha);
  assert.equal(identity.tag, tag);
  const names = rollingAssetNames(tag);
  assert.deepEqual((await readdir(directory)).sort(), names);
  const archiveName = `cockpit-notification-${identity.version}.tgz`;
  const archive = join(directory, archiveName);
  for (const name of [archiveName, 'cockpit-deployment.json']) {
    const bytes = await readFile(join(directory, name));
    assert.equal((await readFile(join(directory, `${name}.sha256`), 'utf8')),
      `${digest(bytes)}  ${name}\n`, 'Checksum mismatch');
  }
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  assert.ok(types.every(entry => entry.startsWith('-') || entry.startsWith('d')),
    'Archive must contain only regular files and directories');
  assert.equal(new Set(entries).size, entries.length);
  assert.ok(entries.every(name => !name.startsWith('/') && !name.includes('\\') &&
    !name.split('/').some(part => part === '.' || part === '..')));
  const read = name => execFileSync('tar', ['-xOzf', archive, name], { maxBuffer: 32 * 1024 * 1024 });
  const bytes = await readFile(join(directory, 'cockpit-deployment.json'));
  assert.deepEqual(read('cockpit-deployment.json'), bytes, 'Embedded descriptor changed');
  const descriptor = JSON.parse(bytes);
  assert.deepEqual(Object.keys(descriptor).sort(),
    ['format', 'channel', 'repository', 'tag', 'sourceSha', 'version', 'sequence', 'archive', 'product'].sort());
  assert.equal(descriptor.format, 2);
  assert.equal(descriptor.channel, 'rolling');
  assert.equal(descriptor.repository, repository);
  for (const key of ['tag', 'sourceSha', 'version', 'sequence']) assert.equal(descriptor[key], identity[key]);
  assert.deepEqual(descriptor.archive, { name: archiveName });
  const product = descriptor.product;
  assert.deepEqual(Object.keys(product).sort(),
    ['kind', 'id', 'hostApi', 'requiresCapabilities', 'requiredIntents', 'databases', 'migrations'].sort());
  assert.equal(product.kind, 'module');
  assert.equal(product.id, 'cockpit-notification');
  assert.deepEqual(Object.keys(product.hostApi).sort(), ['max', 'min']);
  assert.ok(Number.isSafeInteger(product.hostApi.min) && product.hostApi.min > 0);
  assert.ok(Number.isSafeInteger(product.hostApi.max) && product.hostApi.max >= product.hostApi.min);
  for (const [values, pattern] of [
    [product.requiresCapabilities, /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/],
    [product.requiredIntents, /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/],
  ]) {
    assert.ok(Array.isArray(values) && values.every(value => typeof value === 'string' && pattern.test(value)));
    assert.equal(new Set(values).size, values.length);
  }
  // This module has never owned a SQLite database; introducing one needs a reviewed verifier.
  assert.deepEqual(product.databases, []);
  assert.deepEqual(product.migrations, []);
  const receipt = JSON.parse(read('module-build.json'));
  const manifest = JSON.parse(read('cockpit.module.json'));
  assert.equal(receipt.format, 1);
  assert.equal(receipt.product, product.id);
  for (const key of ['version', 'sourceSha', 'sequence']) assert.equal(receipt[key], identity[key]);
  assert.equal(manifest.id, product.id);
  assert.equal(manifest.version, identity.version);
  assert.deepEqual(JSON.parse(read('dist/package.json')),
    { name: manifest.id, version: identity.version, type: 'module' });
  assert.ok(manifest.apiVersion >= product.hostApi.min && manifest.apiVersion <= product.hostApi.max);
  assert.ok(manifest.frontend && typeof manifest.frontend === 'object');
  assert.ok(Array.isArray(manifest.frontend.styles));
  const expected = new Set(['module-build.json']);
  for (const file of receipt.files) {
    assert.ok(typeof file.path === 'string' && !file.path.startsWith('/') && !file.path.includes('\\') &&
      file.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!expected.has(file.path), 'Duplicate inventory file');
    expected.add(file.path);
    const data = read(file.path);
    assert.equal(data.length, file.bytes);
    assert.equal(digest(data), file.sha256);
  }
  assert.ok(expected.has('cockpit-deployment.json') && expected.has('cockpit.module.json'));
  for (const entry of [manifest.backend, manifest.frontend.entry, manifest.frontend.worker,
    ...manifest.frontend.styles]) {
    assert.ok(typeof entry === 'string' && entry.startsWith('dist/') &&
      !/[\\\x00-\x1f\x7f]/.test(entry) &&
      entry.split('/').every(part => part && part !== '.' && part !== '..') &&
      expected.has(entry) && entries.includes(entry),
    `Missing or invalid runtime entrypoint: ${entry}`);
  }
  assert.deepEqual(entries.filter(name => !name.endsWith('/')).sort(), [...expected].sort());
  return descriptor;
}
