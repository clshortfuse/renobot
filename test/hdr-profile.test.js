import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHdrProfile, pqLuminance } from '../src/hdr-profile.js';

test('PQ endpoints and diffuse white retain absolute luminance', () => {
  assert.equal(pqLuminance(0), 0);
  assert.equal(pqLuminance(1), 10000);
  assert.ok(Math.abs(pqLuminance(0.580688881) - 203) < 0.001);
});

test('compiled ICC retains 203-nit metadata without scaling the BT.2020 matrix', () => {
  const profile = buildHdrProfile();
  assert.deepEqual(profile, buildHdrProfile());
  assert.equal(profile.readUInt32BE(0), profile.length);
  assert.equal(profile.toString('ascii', 36, 40), 'acsp');
  const tags = new Map();
  for (let i = 0; i < profile.readUInt32BE(128); i++) {
    const entry = 132 + i * 12;
    tags.set(profile.toString('ascii', entry, entry + 4), profile.readUInt32BE(entry + 4));
  }
  assert.equal(profile.readInt32BE(tags.get('lumi') + 12) / 65536, 203);
  const y = ['rXYZ', 'gXYZ', 'bXYZ'].reduce((sum, tag) =>
    sum + profile.readInt32BE(tags.get(tag) + 12) / 65536, 0);
  for (const nits of [100, 203, 1000, 10000]) {
    assert.ok(Math.abs(y * nits / 10000 - nits / 10000) < 0.00002);
  }
  const curve = tags.get('rTRC');
  let previous = 0;
  for (let i = 0; i < 4096; i++) {
    const value = profile.readUInt16BE(curve + 12 + 2 * i);
    assert.ok(value >= previous);
    previous = value;
  }
});