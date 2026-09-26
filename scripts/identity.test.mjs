import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { digest, inventory, sdkIdentity } from './identity.mjs';

test('package metadata and install manifest share one semantic version identity', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../cockpit.module.json', import.meta.url), 'utf8'));
  assert.equal(metadata.name, manifest.id);
  assert.equal(metadata.version, '0.0.0-dev');
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

test('SDK receipt binds the exact registry resolution and installed package bytes without host source', async t => {
  const root = await mkdtemp(resolve('node_modules/.sdk-identity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = '@waksana/cockpit-module-sdk', version = '0.2.0';
  const installed = join(root, 'node_modules', name);
  await mkdir(installed, { recursive: true });
  const metadata = { devDependencies: { [name]: version } };
  const resolution = { integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    tarball: `https://npm.pkg.github.com/download/${name}/${version}/synthetic` };
  const dependency = { specifier: version, version: `${version}(react@19.3.0)` };
  const lock = { importers: { '.': { devDependencies: { [name]: dependency } } },
    packages: { [`${name}@${version}`]: { resolution } } };
  const save = async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
    await writeFile(join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
  };
  await save();
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(installed, 'runtime.js'), 'export const value = 1;');
  const identity = await sdkIdentity(root);
  assert.deepEqual({ ...identity, files: undefined }, {
    name, version, registry: 'https://npm.pkg.github.com', ...resolution, files: undefined,
  });
  await writeFile(join(installed, 'runtime.js'), 'export const value = 2;');
  assert.notDeepEqual(await sdkIdentity(root), identity, 'installed SDK edits invalidate the build receipt');
  const cases = [
    () => { metadata.devDependencies[name] = '^0.2.0'; },
    () => { dependency.specifier = '0.1.1'; },
    () => { dependency.version = 'file:local-sdk'; },
    () => { resolution.integrity = ''; },
    () => { resolution.tarball = 'file:local-sdk.tgz'; },
    () => { resolution.tarball += '?token=must-not-enter-a-receipt'; },
  ];
  for (const mutate of cases) {
    metadata.devDependencies[name] = version;
    dependency.specifier = version;
    dependency.version = version;
    resolution.integrity = identity.integrity;
    resolution.tarball = identity.tarball;
    mutate();
    await save();
    await assert.rejects(sdkIdentity(root), /SDK/);
  }
  resolution.tarball = identity.tarball;
  await save();
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name, version: '0.1.1' }));
  await assert.rejects(sdkIdentity(root), /Installed SDK differs/);
});

test('published SDK public ESM entry points expose constants and a type-only frontend', async () => {
  const common = await import('@waksana/cockpit-module-sdk');
  const backend = await import('@waksana/cockpit-module-sdk/backend');
  const frontend = await import('@waksana/cockpit-module-sdk/frontend');
  const runtime = await import('@waksana/cockpit-module-sdk/runtime');
  assert.equal(runtime.MAX_MODULE_EVENT_BYTES, 64 * 1024);
  assert.equal(common.MAX_MODULE_EVENT_BYTES, runtime.MAX_MODULE_EVENT_BYTES);
  assert.equal(backend.MAX_MODULE_EVENT_BYTES, runtime.MAX_MODULE_EVENT_BYTES);
  assert.deepEqual(Object.keys(frontend), []);
});
