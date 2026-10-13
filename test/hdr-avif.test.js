import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { convertHdrPng, convertHdrPngBytes, hdrReplyOptions, inspectHdrPng } from '../src/hdr-avif.js';
import { buildHdrProfile } from '../src/hdr-profile.js';

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, 8 + data.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return bytes;
}

test('HDR scan identifies PQ before reading IDAT payload', () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(3840);
  header.writeUInt32BE(2160, 4);
  header[8] = 16;
  header[9] = 2;
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('cICP', Buffer.from([9, 16, 0, 1])),
    chunk('IDAT', Buffer.alloc(0)).subarray(0, 8)]);
  assert.equal(inspectHdrPng(bytes), 'hdr');
  assert.equal(inspectHdrPng(bytes.subarray(0, 20)), 'more');
  assert.equal(inspectHdrPng(Buffer.alloc(8)), 'unsupported');
});

test('HDR scan rejects oversized metadata', () => {
  const bytes = Buffer.alloc(16);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(2 * 1024 * 1024, 8);
  bytes.write('iCCP', 12);
  assert.throws(() => inspectHdrPng(bytes), /scan limit/);
});

test('public HDR reply preserves original caption and attribution without mentions', () => {
  const author = /** @type {import('discord.js').User} */ ({ username: 'Original author', id: '123456789012345678' });
  const content = '@everyone <@123456789012345678> Original caption\nSecond line';
  const files = [{ attachment: Buffer.from('avif'), name: 'hdr_1.avif' }];
  const options = hdrReplyOptions({ id: '234567890123456789', content, author }, files);
  assert.equal(options.content, 'Fixed for Discord');
  assert.deepEqual(options.embeds, [{ author: { name: author.username }, description: content }]);
  assert.equal(options.files, files);
  assert.deepEqual(options.reply, { messageReference: '234567890123456789', failIfNotExists: false });
  assert.deepEqual(options.allowedMentions, { parse: [], repliedUser: false });
});

test('captionless public HDR reply retains attribution without an empty description', () => {
  const author = /** @type {import('discord.js').User} */ ({ username: 'Original author', id: '123456789012345678' });
  const options = hdrReplyOptions({ id: '234567890123456789', content: '', author }, []);
  assert.deepEqual(options.embeds, [{ author: { name: author.username } }]);
});

test('native converter supports one-pixel-wide and one-pixel-high PNGs',
  { skip: !process.env.HDR_CONVERTER_PATH }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'renobot-hdr-narrow-test-'));
    try {
      /** @type {[number, number][]} */
      const dimensions = [[1, 4], [4, 1], [1, 1]];
      for (const [width, height] of dimensions) {
        const header = Buffer.alloc(13);
        header.writeUInt32BE(width);
        header.writeUInt32BE(height, 4);
        header[8] = 16;
        header[9] = 2;
        const rows = Buffer.alloc(height * (1 + width * 6));
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width * 3; x++) {
            rows.writeUInt16BE(32768, y * (1 + width * 6) + 1 + x * 2);
          }
        }
        const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
          chunk('IHDR', header), chunk('cICP', Buffer.from([9, 16, 0, 1])),
          chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
        const input = join(directory, `${width}x${height}.png`);
        const output = join(directory, `${width}x${height}.avif`);
        await writeFile(input, png);
        const result = await convertHdrPng(input, output);
        assert.equal(result.bytes.toString('ascii', 4, 8), 'ftyp');
        assert.ok(result.bytes.includes(buildHdrProfile()));
        const piped = await convertHdrPngBytes(png);
        assert.deepEqual(piped.bytes, result.bytes);
        assert.match(piped.timings, /decode_ms=.*convert_encode_ms=/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test('native bot converter embeds ICC and refuses to overwrite output',
  { skip: !process.env.HDR_CONVERTER_PATH }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'renobot-hdr-test-'));
    try {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(4);
      header.writeUInt32BE(4, 4);
      header[8] = 16;
      header[9] = 2;
      const rows = Buffer.alloc(4 * (1 + 4 * 6));
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 12; x++) rows.writeUInt16BE(32768 + y * 1000, y * 25 + 1 + x * 2);
      }
      const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
        chunk('IHDR', header), chunk('cICP', Buffer.from([9, 16, 0, 1])),
        chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
      const input = join(directory, 'input with spaces.png');
      const output = join(directory, 'output with spaces.avif');
      await writeFile(input, png);
      const result = await convertHdrPng(input, output);
      assert.equal(result.bytes.toString('ascii', 4, 8), 'ftyp');
      assert.ok(result.bytes.includes(buildHdrProfile()));
      assert.match(result.timings, /decode_ms=.*convert_encode_ms=/);
      assert.ok(result.milliseconds > 0);
      const piped = await convertHdrPngBytes(png);
      assert.deepEqual(piped.bytes, result.bytes);
      await assert.rejects(convertHdrPngBytes(png, 16));
      await assert.rejects(convertHdrPngBytes(png.subarray(0, 40)));
      await assert.rejects(convertHdrPngBytes(Buffer.from('not a PNG')));
      await assert.rejects(convertHdrPng(input, output));
      assert.deepEqual(await readFile(output), result.bytes);
      assert.deepEqual(await readFile(input), png);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });