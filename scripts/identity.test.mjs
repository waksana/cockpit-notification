import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { digest, inventory } from './identity.mjs';

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
