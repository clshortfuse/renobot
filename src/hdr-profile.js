import { createHash } from 'node:crypto';

/** Absolute ST 2084 luminance in cd/m². @param {number} value */
export function pqLuminance(value) {
  const power = value ** (32 / 2523);
  return 10000 * (Math.max(power - 3424 / 4096, 0)
    / (2413 / 128 - 2392 / 128 * power)) ** (16384 / 2610);
}

/** @param {number[]} values */
function xyz(values) {
  const bytes = Buffer.alloc(20);
  bytes.write('XYZ ');
  values.forEach((value, i) => bytes.writeInt32BE(Math.round(value * 65536), 8 + i * 4));
  return bytes;
}

/** Independently authored ICC v4 matrix-shaper profile. */
export function buildHdrProfile() {
  // Bradford-adapted BT.2020 RGB → D50 XYZ, without luminance scaling.
  // CICP-aware PQ conversion supplies its own reference-white normalization;
  // scaling the gamut matrix as well can apply that normalization twice.
  /** @type {[number[], number[], number[]]} */
  const matrix = [
    [0.673459, 0.279033, -0.001931],
    [0.165661, 0.675338, 0.029979],
    [0.125100, 0.045629, 0.797162],
  ];
  const curve = Buffer.alloc(12 + 4096 * 2);
  curve.write('curv');
  curve.writeUInt32BE(4096, 8);
  for (let i = 0; i < 4096; i++) {
    curve.writeUInt16BE(Math.round(pqLuminance(i / 4095) / 10000 * 65535), 12 + i * 2);
  }
  const text = Buffer.from('Renobot BT.2020 PQ 203nit', 'utf16le');
  text.swap16();
  const description = Buffer.alloc(28 + text.length);
  description.write('mluc');
  description.writeUInt32BE(1, 8);
  description.writeUInt32BE(12, 12);
  description.write('enUS', 16);
  description.writeUInt32BE(text.length, 20);
  description.writeUInt32BE(28, 24);
  text.copy(description, 28);
  const cicp = Buffer.from([99, 105, 99, 112, 0, 0, 0, 0, 9, 16, 0, 1]);
  const adaptation = Buffer.alloc(44);
  adaptation.write('sf32');
  [1.047882, 0.022919, -0.050201, 0.029587, 0.990479, -0.017059,
    -0.009232, 0.015076, 0.751678].forEach((v, i) => adaptation.writeInt32BE(Math.round(v * 65536), 8 + i * 4));
  const tags = new Map([
    ['desc', description], ['cprt', description], ['wtpt', xyz([0.9642, 1, 0.8249])],
    ['chad', adaptation], ['cicp', cicp], ['lumi', xyz([0, 203, 0])],
    ['rXYZ', xyz(matrix[0])],
    ['gXYZ', xyz(matrix[1])],
    ['bXYZ', xyz(matrix[2])],
    ['rTRC', curve], ['gTRC', curve], ['bTRC', curve],
  ]);
  let offset = 132 + tags.size * 12;
  const table = Buffer.alloc(offset);
  table.writeUInt32BE(tags.size, 128);
  /** @type {Buffer[]} */
  const payloads = [];
  let index = 0;
  for (const [name, payload] of tags) {
    const entry = 132 + index++ * 12;
    table.write(name, entry);
    table.writeUInt32BE(offset, entry + 4);
    table.writeUInt32BE(payload.length, entry + 8);
    const padded = Buffer.alloc((payload.length + 3) & ~3);
    payload.copy(padded);
    payloads.push(padded);
    offset += padded.length;
  }
  const profile = Buffer.concat([table, ...payloads]);
  profile.writeUInt32BE(profile.length);
  profile.writeUInt32BE(0x04300000, 8);
  profile.write('mntr', 12);
  profile.write('RGB ', 16);
  profile.write('XYZ ', 20);
  [2026, 10, 13, 0, 0, 0].forEach((v, i) => profile.writeUInt16BE(v, 24 + i * 2));
  profile.write('acsp', 36);
  xyz([0.9642, 1, 0.8249]).copy(profile, 68, 8, 20);
  profile.write('Reno', 80);
  createHash('md5').update(profile).digest().copy(profile, 84);
  return profile;
}