import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const git = (root, args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
export function source(root, strict = false) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source identity');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=normal'])) {
    if (strict) throw new Error('Commit all source changes before packaging');
    return null;
  }
  return sha;
}
export async function inventory(root, entries) {
  const files = [];
  async function visit(path) {
    if (path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path)) {
      throw new Error('Unsafe inventory path');
    }
    const info = await lstat(join(root, path));
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) await visit(`${path}/${name}`);
    } else if (info.isFile()) {
      const bytes = await readFile(join(root, path));
      files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    } else throw new Error('Package contains a symlink or special file');
  }
  for (const entry of entries) await visit(entry);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function sdkPin(root) {
  const pin = JSON.parse(await readFile(join(root, 'tooling/host-sdk.json'), 'utf8'));
  if (pin.repository !== 'waksana/cockpit' || !/^[a-f0-9]{40}$/.test(pin.commit) ||
      !/^\d+\.\d+\.\d+$/.test(pin.version) || pin.apiVersion !== 1) throw new Error('Invalid SDK pin');
  return pin;
}
export async function sdkIdentity(root) {
  const pin = await sdkPin(root);
  const saved = JSON.parse(await readFile(join(root, '.cockpit-sdk/pin.json'), 'utf8'));
  if (JSON.stringify(saved.pin) !== JSON.stringify(pin) ||
      JSON.stringify(saved.files) !== JSON.stringify(await inventory(join(root, '.cockpit-sdk'), ['module-api', 'protocol', 'LICENSE']))) {
    throw new Error('Generated SDK differs from pinned source');
  }
  return pin;
}
export async function checkedBuild(root) {
  const receipt = JSON.parse(await readFile(join(root, '.module-build.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (receipt.format !== 1 || receipt.product !== 'cockpit-notification' ||
      receipt.sourceSha !== source(root, true) || receipt.version !== metadata.version ||
      receipt.node !== process.versions.node ||
      JSON.stringify(receipt.sdk) !== JSON.stringify(await sdkIdentity(root)) ||
      JSON.stringify(receipt.files) !== JSON.stringify(await inventory(root, ['cockpit.module.json', 'dist', 'LICENSE']))) {
    throw new Error('Build output is stale or modified');
  }
  return receipt;
}
