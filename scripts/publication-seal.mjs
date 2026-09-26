import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const marker = '\n\n<!-- cockpit-rolling-publication-v1\n';
const suffix = '\n-->\n';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function publicationSeal(notes, identity, assets, bytes) {
  const record = { format: 1, ...identity, assets: assets.map(asset => ({
    id: asset.id, name: asset.name, size: asset.size, sha256: sha256(bytes.get(asset.name)),
  })).sort((a, b) => a.name.localeCompare(b.name)) };
  return `${notes}${marker}${JSON.stringify(record)}${suffix}`;
}

export function readPublicationSeal(body) {
  assert.equal(typeof body, 'string');
  const index = body.lastIndexOf(marker);
  assert.ok(index >= 0 && body.endsWith(suffix), 'Missing original publication asset identity');
  const record = JSON.parse(body.slice(index + marker.length, -suffix.length));
  assert.equal(record.format, 1);
  assert.deepEqual(Object.keys(record).sort(), ['format', 'releaseId', 'tag', 'sourceSha', 'assets'].sort());
  assert.ok(Array.isArray(record.assets));
  for (const asset of record.assets) {
    assert.deepEqual(Object.keys(asset).sort(), ['id', 'name', 'size', 'sha256'].sort());
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
  return { notes: body.slice(0, index), record };
}

export function verifyPublicationSeal(body, identity, assets, bytes) {
  const { record } = readPublicationSeal(body);
  for (const key of ['releaseId', 'tag', 'sourceSha']) assert.equal(record[key], identity[key]);
  assert.deepEqual(record.assets.map(({ id, name, size }) => ({ id, name, size })),
    assets.map(({ id, name, size }) => ({ id, name, size })).sort((a, b) => a.name.localeCompare(b.name)),
    'Assets differ from original publication identity');
  if (bytes) for (const asset of record.assets) {
    assert.equal(sha256(bytes.get(asset.name)), asset.sha256, 'Bytes differ from original publication');
  }
  return record;
}
