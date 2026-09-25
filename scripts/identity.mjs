import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

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
export async function sdkIdentity(root) {
  const name = '@waksana/cockpit-module-sdk';
  const registry = 'https://npm.pkg.github.com';
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = metadata.devDependencies?.[name];
  const lock = parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const dependency = lock.importers?.['.']?.devDependencies?.[name];
  const resolution = lock.packages?.[`${name}@${version}`]?.resolution;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      dependency?.specifier !== version || typeof dependency.version !== 'string' ||
      dependency.version.split('(')[0] !== version ||
      typeof resolution?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(resolution.integrity) ||
      typeof resolution.tarball !== 'string' ||
      !resolution.tarball.startsWith(`${registry}/download/${name}/${version}/`)) {
    throw new Error('SDK must resolve to an exact GitHub Packages version with integrity');
  }
  const url = new URL(resolution.tarball);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid SDK package URL');
  const directory = await realpath(join(root, 'node_modules', name));
  const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (installed.name !== name || installed.version !== version) throw new Error('Installed SDK differs from lockfile');
  return { name, version, registry, tarball: resolution.tarball, integrity: resolution.integrity,
    files: await inventory(directory, (await readdir(directory)).sort()) };
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
