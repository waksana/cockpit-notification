import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { digest, inventory } from './identity.mjs';

test('package metadata and install manifest share one semantic version identity', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../cockpit.module.json', import.meta.url), 'utf8'));
  assert.equal(metadata.name, manifest.id);
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, metadata.version);
});

test('build inventory hashes exact bytes and rejects links and unsafe paths', async t => {
  const root = await mkdtemp(resolve('node_modules/.identity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.js'), 'synthetic');
  assert.deepEqual(await inventory(root, ['dist']), [
    { path: 'dist/index.js', bytes: 9, sha256: digest('synthetic') },
  ]);
  await symlink('index.js', join(root, 'dist/link.js'));
  await assert.rejects(inventory(root, ['dist']), /symlink/);
  await assert.rejects(inventory(root, ['../outside']), /Unsafe/);
});
