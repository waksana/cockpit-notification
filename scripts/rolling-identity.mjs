import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function rollingIdentity(sequence, sourceSha) {
  assert.match(String(sequence), /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(Number(sequence)), 'Invalid Rolling sequence');
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const version = `0.0.0-rolling.${sequence}`;
  return { version, tag: `v${version}`, sourceSha, sequence: Number(sequence) };
}

export function buildIdentity(version, sha, sequence = process.env.ROLLING_SEQUENCE) {
  assert.equal(version, '0.0.0-dev', 'Committed product version must remain development-only');
  if (sequence) return { ...rollingIdentity(sequence, sha), displayVersion: `0.0.0-rolling.${sequence}` };
  return { version, sourceSha: sha, displayVersion: `dev+${sha?.slice(0, 7) ?? 'unknown'}` };
}

// Each declaration is gated against the runtime contract that actually consumes it.
// Notification has a private JSON subscription store, no SQLite database or migration.
export async function moduleProduct(root) {
  const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  const frontend = await readFile(join(root, 'src/web/index.tsx'), 'utf8');
  const backend = await readFile(join(root, 'src/server/index.ts'), 'utf8');
  const storage = await readFile(join(root, 'src/server/storage.ts'), 'utf8');
  assert.equal(manifest.apiVersion, 1, 'Review changed module API compatibility');
  assert.equal(manifest.id, 'cockpit-notification');
  const requiresCapabilities = ['module-api.v1'];
  for (const [field, version, capability] of [
    ['apiVersion', 2, 'frontend-api.v2'], ['uiVersion', 1, 'ui.v1'],
    ['uiSurfaceVersion', 1, 'uiSurface.v1'], ['menuVersion', 1, 'menu.v1'],
  ]) {
    assert.ok(frontend.includes(`context.${field} !== ${version}`), `Review changed ${field} requirement`);
    requiresCapabilities.push(capability);
  }
  assert.doesNotMatch(backend, /context\.host\.(?:call|dispatch)/, 'Review new required host intents');
  assert.ok(storage.includes("'push-config.json'") && storage.includes('version: 1;'),
    'Review changed storage format');
  assert.doesNotMatch(storage, /node:sqlite|CREATE TABLE|user_version/, 'Declare database and migration requirements');
  return { kind: 'module', id: manifest.id, hostApi: { min: manifest.apiVersion, max: manifest.apiVersion },
    requiresCapabilities, requiredIntents: [], databases: [], migrations: [] };
}

export async function deploymentDescriptor(root, identity) {
  const { version, tag, sourceSha, sequence } = rollingIdentity(identity.sequence, identity.sourceSha);
  return { format: 2, channel: 'rolling', repository: 'waksana/cockpit-notification',
    tag, sourceSha, version, sequence, archive: { name: `cockpit-notification-${version}.tgz` },
    product: await moduleProduct(root) };
}

export function mergedIdentity(event, sequence, repository) {
  assert.equal(repository, 'waksana/cockpit-notification');
  assert.equal(event.action, 'closed');
  const pr = event.pull_request;
  assert.equal(pr?.merged, true, 'Only actually merged PRs publish');
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.base.repo.full_name, repository);
  assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0);
  assert.equal(typeof pr.title, 'string');
  assert.ok(pr.body === null || typeof pr.body === 'string');
  return { ...rollingIdentity(sequence, pr.merge_commit_sha), number: pr.number,
    title: pr.title, body: pr.body ?? '', url: pr.html_url };
}

export function releaseNotes(identity, names) {
  return `# ${identity.title}\n\n${identity.body}\n\n---\n\n` +
    `PR: ${identity.url}\nSource: ${identity.sourceSha}\nTag: ${identity.tag}\n` +
    `Version: ${identity.version}\nRolling sequence: ${identity.sequence}\n\n` +
    `Assets:\n${names.map(name => `- ${name}`).join('\n')}\n`;
}
