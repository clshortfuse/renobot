import { iccp } from './png-profile.js';

export const MAX_PNG_BYTES = 50 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Buffer} input */
export function fixPng(input) {
  if (input.length > MAX_PNG_BYTES) throw new Error('PNG exceeds 50 MiB.');
  if (!input.subarray(0, 8).equals(signature)) throw new Error('Not a PNG.');
  let cicp = false;
  let ihdr = false;
  let idat = false;
  let iend = false;
  let outputSize = 8 + 12 + iccp.length;
  let count = 0;
  for (let pos = 8; pos < input.length;) {
    if (++count > 10000) throw new Error('Too many PNG chunks.');
    if (input.length - pos < 12) throw new Error('Truncated PNG chunk.');
    const size = input.readUInt32BE(pos);
    if (size > input.length - pos - 12) throw new Error('Truncated PNG chunk.');
    const end = pos + size + 12;
    const type = input.toString('ascii', pos + 4, pos + 8);
    if (crc32(input.subarray(pos + 4, end - 4)) !== input.readUInt32BE(end - 4)) throw new Error('PNG chunk has a bad CRC.');
    if (pos === 8 && type !== 'IHDR') throw new Error('Missing initial IHDR.');
    if (type === 'IHDR') {
      if (ihdr || pos !== 8 || size !== 13) throw new Error('Invalid IHDR.');
      const depth = input[pos + 16];
      if (![2, 6].includes(input[pos + 17] ?? -1) || ![8, 16].includes(depth ?? -1)) throw new Error('Requires RGB or RGBA PNG.');
      if (!input.readUInt32BE(pos + 8) || !input.readUInt32BE(pos + 12)
        || input[pos + 18] !== 0 || input[pos + 19] !== 0 || (input[pos + 20] ?? 2) > 1) throw new Error('Invalid IHDR.');
      ihdr = true;
    } else if (type === 'cICP') {
      if (cicp || idat || size !== 4 || !input.subarray(pos + 8, pos + 12).equals(Buffer.from([9, 16, 0, 1]))) throw new Error('Expected cICP 9/16/0/1 before pixel data.');
      cicp = true;
    } else if (type === 'IDAT') idat = true;
    else if (type === 'IEND') {
      if (size !== 0 || end !== input.length) throw new Error('Invalid PNG ending.');
      iend = true;
    }
    if (type !== 'cICP' && type !== 'iCCP') outputSize += size + 12;
    pos = end;
  }
  if (!ihdr || !cicp || !idat || !iend) throw new Error('Incomplete PNG or missing cICP 9/16/0/1.');
  const output = Buffer.alloc(outputSize);
  signature.copy(output);
  let dest = 8;
  for (let pos = 8; pos < input.length;) {
    const size = input.readUInt32BE(pos);
    const type = input.toString('ascii', pos + 4, pos + 8);
    if (type !== 'cICP' && type !== 'iCCP') {
      input.copy(output, dest, pos, pos + size + 12);
      dest += size + 12;
    }
    if (type === 'IHDR') {
      output.writeUInt32BE(iccp.length, dest);
      output.write('iCCP', dest + 4, 'ascii');
      iccp.copy(output, dest + 8);
      output.writeUInt32BE(crc32(output.subarray(dest + 4, dest + 8 + iccp.length)), dest + 8 + iccp.length);
      dest += iccp.length + 12;
    }
    pos += size + 12;
  }
  return output;
}

/** @param {string} address @param {typeof fetch} fetchImpl */
export async function downloadPng(address, fetchImpl = fetch) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
    || !url.pathname.startsWith('/attachments/')) throw new Error('Only Discord attachments are supported.');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const length = Number(response.headers.get('content-length'));
  if (!response.ok || !response.body || length > MAX_PNG_BYTES) {
    await response.body?.cancel();
    throw new Error('Attachment unavailable or exceeds 50 MiB.');
  }
  // Fixed capacity avoids retaining arbitrary numbers of network chunks or trusting Content-Length.
  const data = Buffer.alloc(MAX_PNG_BYTES);
  const reader = response.body.getReader();
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > MAX_PNG_BYTES - used) throw new Error('PNG exceeds 50 MiB.');
      data.set(value, used);
      used += value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return data.subarray(0, used);
}