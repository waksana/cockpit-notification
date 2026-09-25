import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './identity.mjs';

export async function integrationHost(root) {
  const pairing = JSON.parse(await readFile(join(root, 'tooling/integration-host.json'), 'utf8'));
  if (pairing.repository !== 'waksana/cockpit' || !/^[a-f0-9]{40}$/.test(pairing.commit)) {
    throw new Error('Invalid integration host pairing');
  }
  return pairing;
}

export async function checkedIntegrationHost(root, directory) {
  const pairing = await integrationHost(root);
  if (git(directory, ['rev-parse', 'HEAD']) !== pairing.commit ||
      git(directory, ['status', '--porcelain=v1', '--untracked-files=normal'])) {
    throw new Error('Integration requires the clean exact paired host source');
  }
  return pairing;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: integration-host.mjs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pairing = await integrationHost(root);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  console.log(`repository=${pairing.repository}\ncommit=${pairing.commit}\narchive=${metadata.name}-${metadata.version}.tgz`);
}
