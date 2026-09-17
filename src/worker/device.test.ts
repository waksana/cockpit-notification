import assert from 'node:assert/strict';
import test from 'node:test';
import { appClient, discoverModuleApi, navigationUrl, parseDeviceState, pushBadge, reconcile, workerConfiguration } from './device.ts';
import type { DeviceState, VisibleNotification } from './device.ts';
import type { NotificationPayload, Snapshot } from '../shared/protocol.ts';

export const configuration = workerConfiguration({ moduleId: 'cockpit-notification', digest: 'a'.repeat(64),
  apiBase: `../../cockpit-notification/${'a'.repeat(64)}/api` },
'https://host.test/deployment/_modules/workers/cockpit-notification/worker.js');
export function payload(nativeId = 'reply-a', generation = 'generation-a', revision = 10, createdRevision = 1): NotificationPayload {
  return { moduleId: 'cockpit-notification', generation,
    key: { sessionId: 'session-a', kind: 'reply', nativeId }, createdRevision, revision, total: 7,
    title: '会话有新回复', body: '请打开会话查看', navigationTarget: 'session/session-a' };
}
export function snapshot(revision = 10, names: string[] = [], generation = 'generation-a'): Snapshot {
  return { generation, revision, complete: true, total: names.length, sessions: names.length ? [{
    sessionId: 'session-a', count: names.length,
    items: names.map(nativeId => ({ kind: 'reply', nativeId, createdRevision: 1 })),
  }] : [] };
}
export function notification(data: unknown): VisibleNotification & { closed: boolean } {
  return { data, closed: false, close() { this.closed = true; } };
}
const device: DeviceState = { generation: 'generation-a', revision: 9, total: 5, retired: [] };

test('an old snapshot cannot delete a newer notification; duplicate data identities do not depend on tags', () => {
  const old = notification(payload('old'));
  const duplicate = notification(payload('old'));
  const newer = notification(payload('new', 'generation-a', 11, 11));
  const other = notification({ ...payload(), moduleId: 'other-module' });
  const result = reconcile(device, snapshot(), [old, duplicate, newer, other]);
  assert.deepEqual(result.close, [old, duplicate]);
  assert.equal(result.badge, 0);
  assert.equal(newer.closed, false);
});

test('badge derives from server total, never remaining OS notifications or dismissed cards', () => {
  const result = reconcile(device, snapshot(10, ['a', 'b', 'c']), []);
  assert.equal(result.badge, 3);
  assert.equal(result.state?.total, 3);
  const newer = pushBadge(result.state, payload('a', 'generation-a', 20));
  assert.equal(newer.badge, 7);
  assert.equal(pushBadge(newer.state, payload('a', 'generation-a', 19)).badge, null);
  assert.equal(reconcile(newer.state, snapshot(18), []).badge, null);
});

test('ACK identities clear matching notifications even with an older attached snapshot', () => {
  const card = notification(payload('ack', 'generation-a', 20, 15));
  const current = { ...device, revision: 25, total: 2 };
  const result = reconcile(current, snapshot(10), [card], [payload('ack').key]);
  assert.deepEqual(result.close, [card]);
  assert.equal(result.badge, null);
  assert.equal(result.state?.revision, 25);
});

test('different-generation snapshots cannot bind without a pre-GET baseline', () => {
  const card = notification(payload('old'));
  assert.deepEqual(reconcile(device, snapshot(0, [], 'generation-b'), [card]),
    { state: device, badge: null, close: [] });
});

test('cross-generation proof clears only pre-enumerated identities, preserving unfamiliar future generations', () => {
  const baselineCard = notification(payload('old', 'unknown-prior'));
  const futureCard = notification(payload('future', 'generation-c'));
  const result = reconcile(device, snapshot(0, [], 'generation-b'), [baselineCard, futureCard], [], [baselineCard]);
  assert.deepEqual(result.close, [baselineCard]);
  assert.equal(result.state?.generation, 'generation-b');
  assert.deepEqual(result.state?.retired, ['generation-a', 'unknown-prior']);
  const lateOld = notification(payload('late', 'unknown-prior'));
  const later = reconcile(result.state, snapshot(1, [], 'generation-b'), [lateOld, futureCard]);
  assert.deepEqual(later.close, [lateOld]);
  assert.equal(pushBadge(later.state, payload('future', 'generation-c')).badge, null);
});

test('device version record roundtrips without full unread history and validates corruption', () => {
  assert.deepEqual(parseDeviceState(JSON.parse(JSON.stringify(device))), device);
  assert.equal(parseDeviceState(undefined), null);
  for (const invalid of [{ ...device, total: -1 }, { ...device, revision: 1.2 },
    { ...device, retired: ['generation-a'] }, { ...device, retired: Array(65).fill('old') }]) {
    assert.throws(() => parseDeviceState(invalid));
  }
  assert.throws(() => pushBadge(device, { ...payload(), revision: 9, total: 9 }), /不一致/);
});

test('bootstrap pins exact same-origin module worker, API, digest and deployment base', () => {
  assert.equal(configuration.appBase, 'https://host.test/deployment/');
  assert.equal(configuration.apiBase, `https://host.test/deployment/_modules/cockpit-notification/${'a'.repeat(64)}/api`);
  for (const change of [
    { apiBase: 'https://outside.test/api' }, { apiBase: '../../other/api' }, { digest: '../x' },
    { moduleId: 'other-module' },
  ]) {
    assert.throws(() => workerConfiguration({ moduleId: 'cockpit-notification', digest: 'a'.repeat(64),
      apiBase: configuration.apiBase, ...change }, configuration.workerUrl));
  }
  assert.throws(() => workerConfiguration({ moduleId: 'cockpit-notification', digest: 'a'.repeat(64),
    apiBase: configuration.apiBase }, `${configuration.workerUrl}?override`));
});

test('host bootstrap discovery requires one successfully loaded module and binds URLs to its exact deployment digest', () => {
  const digest = 'b'.repeat(64);
  const api = `/_modules/cockpit-notification/${digest}/api`;
  const module = { id: 'cockpit-notification', digest, apiBase: api };
  const value = { modules: [module], active: [{ id: module.id, digest }], errors: [] };
  const expected = { digest, apiBase: `https://host.test/deployment${api}` };
  assert.deepEqual(discoverModuleApi(value, configuration), expected);
  assert.deepEqual(discoverModuleApi({ ...value, modules: [{ ...module, apiBase: expected.apiBase }] }, configuration), expected);
  for (const invalid of [
    { ...value, modules: [] },
    { ...value, modules: [module, module] },
    { ...value, active: [] },
    { ...value, active: [{ id: module.id, digest: 'a'.repeat(64) }] },
    { ...value, errors: [{ id: module.id, error: 'failed to load' }] },
    { ...value, apiVersion: 2 },
    { ...value, modules: [{ ...module, apiBase: 'https://outside.test/api' }] },
    { ...value, modules: [{ ...module, apiBase: `https://host.test/different-prefix${api}` }] },
    { ...value, modules: [{ ...module, apiBase: `${api}?override` }] },
    { ...value, modules: [{ ...module, apiBase: `/_modules/another-module/${digest}/api` }] },
    { ...value, modules: [{ ...module, apiBase: `/_modules/cockpit-notification/${'c'.repeat(64)}/api` }] },
  ]) assert.throws(() => discoverModuleApi(invalid, configuration));
});

test('navigation is a canonical encoded session path, with no external URL or prefix escape', () => {
  assert.equal(navigationUrl(payload(), configuration), 'https://host.test/deployment/session/session-a');
  for (const navigationTarget of ['https://outside.test/', '//outside.test/', '../escape', '/session/session-a',
    'session/session-a?next=outside', 'session/session-a#fragment', 'session/%2e%2e']) {
    assert.throws(() => navigationUrl({ ...payload(), navigationTarget }, configuration));
  }
  assert.equal(appClient('https://host.test/deployment/session/a', configuration), true);
  for (const url of ['https://outside.test/deployment/', 'https://host.test/deployment-other/',
    'https://user@host.test/deployment/', 'not a URL']) assert.equal(appClient(url, configuration), false);
  const encoded = { ...payload(), key: { ...payload().key, sessionId: 'a/b?c#d' }, navigationTarget: 'session/a%2Fb%3Fc%23d' };
  assert.equal(navigationUrl(encoded, configuration), 'https://host.test/deployment/session/a%2Fb%3Fc%23d');
  assert.throws(() => navigationUrl({ ...payload(), key: { ...payload().key, sessionId: '..' }, navigationTarget: 'session/..' }, configuration));
});
