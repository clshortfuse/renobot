/** @param {Buffer} source @param {Buffer} profile */
export function embedAvifProfile(source, profile) {
  /** @type {{offset:number,size:number,type:string,parents:number[]}[]} */
  const boxes = [];
  /** @param {number} start @param {number} end @param {number[]} parents */
  function scan(start, end, parents) {
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) throw Error('Truncated AVIF box.');
      const size = source.readUInt32BE(offset);
      const type = source.toString('ascii', offset + 4, offset + 8);
      if (size < 8 || offset + size > end) throw Error('Unsupported AVIF box size.');
      boxes.push({ offset, size, type, parents });
      if (['meta', 'iprp', 'ipco'].includes(type)) {
        scan(offset + 8 + (type === 'meta' ? 4 : 0), offset + size, [...parents, offset]);
      }
      offset += size;
    }
  }
  scan(0, source.length, []);
  // libavif's first color property belongs to the primary image. Fail closed
  // for layouts without the expected PQ primary, rather than editing an alternate.
  const color = boxes.find(box => box.type === 'colr');
  if (!color || source.toString('ascii', color.offset + 8, color.offset + 12) !== 'nclx'
    || source.readUInt16BE(color.offset + 12) !== 9
    || source.readUInt16BE(color.offset + 14) !== 16) throw Error('Expected primary BT.2020/PQ nclx.');
  const replacement = Buffer.alloc(profile.length + 12);
  replacement.writeUInt32BE(replacement.length);
  replacement.write('colrprof', 4);
  profile.copy(replacement, 12);
  const delta = replacement.length - color.size;
  const boundary = color.offset + color.size;
  const adjusted = Buffer.from(source);
  for (const parent of color.parents) adjusted.writeUInt32BE(source.readUInt32BE(parent) + delta, parent);
  /** @param {number} position @param {number} size */
  function integer(position, size) {
    if (size > 6 || position + size > source.length) throw Error('Unsupported item offset.');
    return size ? source.readUIntBE(position, size) : 0;
  }
  for (const location of boxes.filter(box => box.type === 'iloc')) {
    let p = location.offset + 8;
    const version = source.readUInt8(p);
    if (version > 2) throw Error('Unsupported iloc version.');
    p += 4;
    const offsetSize = source.readUInt8(p) >> 4;
    const lengthSize = source.readUInt8(p++) & 15;
    const baseSize = source.readUInt8(p) >> 4;
    const indexSize = version ? source.readUInt8(p) & 15 : 0;
    p++;
    const countSize = version < 2 ? 2 : 4;
    const count = integer(p, countSize);
    p += countSize;
    for (let i = 0; i < count; i++) {
      p += version < 2 ? 2 : 4;
      let method = 0;
      if (version) { method = source.readUInt16BE(p) & 15; p += 2; }
      if (source.readUInt16BE(p) !== 0 || method > 1) throw Error('Unsupported item storage.');
      p += 2;
      const basePosition = p;
      const base = integer(p, baseSize);
      p += baseSize;
      const countExtents = source.readUInt16BE(p);
      p += 2;
      const shiftBase = method === 0 && baseSize > 0 && base >= boundary;
      if (shiftBase) adjusted.writeUIntBE(base + delta, basePosition, baseSize);
      for (let j = 0; j < countExtents; j++) {
        p += indexSize;
        const offset = integer(p, offsetSize);
        if (method === 0 && !shiftBase && base + offset >= boundary) {
          adjusted.writeUIntBE(offset + delta, p, offsetSize);
        }
        p += offsetSize + lengthSize;
      }
      if (p > location.offset + location.size) throw Error('Truncated item locations.');
    }
  }
  const result = Buffer.concat([adjusted.subarray(0, color.offset), replacement, adjusted.subarray(boundary)]);
  for (const media of boxes.filter(box => box.type === 'mdat')) {
    const shifted = media.offset >= boundary ? delta : 0;
    if (!source.subarray(media.offset + 8, media.offset + media.size)
      .equals(result.subarray(media.offset + shifted + 8, media.offset + shifted + media.size))) {
      throw Error('Encoded AVIF payload changed.');
    }
  }
  return result;
}