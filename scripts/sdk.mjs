import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, inventory, sdkPin } from './identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [operation, directory, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: sdk.mjs info | prepare HOST_SOURCE');
const pin = await sdkPin(root);
if (operation === 'info' && !directory) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  console.log(`repository=${pin.repository}\ncommit=${pin.commit}\narchive=cockpit-notification-${metadata.version}.tgz`);
} else if (operation === 'prepare' && directory) {
  const host = resolve(directory);
  if (git(host, ['rev-parse', 'HEAD']) !== pin.commit || git(host, ['status', '--porcelain=v1', '--untracked-files=normal'])) {
    throw new Error('SDK requires the clean exact pinned host source');
  }
  for (const name of ['module-api', 'protocol']) {
    const metadata = JSON.parse(await readFile(join(host, 'packages', name, 'package.json'), 'utf8'));
    if (metadata.version !== pin.version) throw new Error('SDK version mismatch');
  }
  await mkdir(join(root, 'node_modules'), { recursive: true });
  const temporary = await mkdtemp(join(root, 'node_modules/.sdk-prepare-'));
  try {
    const prepared = join(temporary, 'sdk');
    execFileSync(process.execPath, [join(host, 'scripts/export-module-api.mjs'), prepared], { stdio: 'pipe' });
    const files = await inventory(prepared, ['module-api', 'protocol', 'LICENSE']);
    const target = join(root, '.cockpit-sdk');
    let exists = false;
    try { const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid SDK directory'); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      if (JSON.stringify(files) !== JSON.stringify(await inventory(target, ['module-api', 'protocol', 'LICENSE']))) {
        throw new Error('Existing SDK differs; remove only the generated .cockpit-sdk before preparing');
      }
    } else await rename(prepared, target);
    await writeFile(join(target, 'pin.json'), `${JSON.stringify({ pin, files }, null, 2)}\n`);
    console.log(JSON.stringify(pin));
  } finally { await rm(temporary, { recursive: true }); }
} else throw new Error('Usage: sdk.mjs info | prepare HOST_SOURCE');
