import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedBuild, digest } from './identity.mjs';

export async function packageModule(root, output) {
  const receipt = await checkedBuild(root);
  const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  if (manifest.id !== receipt.product || manifest.version !== receipt.version) throw new Error('Module identity mismatch');
  for (const path of [manifest.backend, manifest.frontend.entry, manifest.frontend.worker, ...manifest.frontend.styles]) {
    if (!receipt.files.some(file => file.path === path)) throw new Error('Unbuilt module entry');
  }
  if (receipt.files.some(file => /\.(?:test|spec)\./.test(file.path) || file.path.includes('node_modules'))) {
    throw new Error('Development files must not ship');
  }
  await mkdir(output);
  const name = `${manifest.id}-${manifest.version}.tgz`;
  const path = join(output, name);
  try {
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--hard-dereference',
      '--transform=s/^\\.module-build\\.json$/module-build.json/', '-czf', path, 'cockpit.module.json', 'dist', 'LICENSE', '.module-build.json'],
    { cwd: root, stdio: 'pipe' });
    await checkedBuild(root);
    await writeFile(`${path}.sha256`, `${digest(await readFile(path))}  ${name}\n`, { flag: 'wx' });
    return path;
  } catch (error) {
    await rm(`${path}.sha256`, { force: true });
    await rm(path, { force: true });
    await rmdir(output);
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: package.mjs [NEW_OUTPUT_DIRECTORY]');
  console.log(await packageModule(fileURLToPath(new URL('..', import.meta.url)), resolve(process.argv[2] ?? 'module-output')));
}
