import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { convertHdrPng, convertHdrPngBytes, fixHdrMessage, hdrReplyOptions, inspectHdrPng } from '../src/hdr-avif.js';

test('converter reports stdout overflow as a user notice but preserves stderr failures', async (t) => {
  let stream = 'stdout';
  const mock = t.mock.method(childProcess, 'execFile', (/** @type {[string, string[], object, (error: Error, stdout: Buffer, stderr: Buffer) => void]} */ ...args) => {
    const callback = args[3];
    const error = Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    queueMicrotask(() => callback(error, Buffer.alloc(16), Buffer.alloc(0)));
    return { stdin: { on() {}, end() {} } };
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(convertHdrPngBytes(Buffer.from('input'), 16), {
      name: 'Error', message: 'Converted AVIF exceeds the server upload limit.',
    });
    stream = 'stderr';
    await assert.rejects(convertHdrPngBytes(Buffer.from('input'), 16), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stderr maxBuffer length exceeded',
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('HDR command shows safe notices, accepts five PNGs, and propagates internal failures', async (t) => {
  /** @type {string[]} */
  const replies = [];
  const attachments = new Map();
  const interaction = /** @type {import('discord.js').MessageContextMenuCommandInteraction} */ (/** @type {unknown} */ ({
    deferReply: async () => {},
    editReply: async (/** @type {string} */ content) => { replies.push(content); },
    targetMessage: { attachments },
  }));
  for (let i = 0; i < 5; i++) {
    attachments.set(String(i), { name: `${i}.png`, size: 100, url: 'https://cdn.discordapp.com/test.png' });
  }
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloads++;
    return new Response(new Uint8Array(8));
  });
  await fixHdrMessage(interaction);
  assert.equal(downloads, 5);
  assert.equal(replies.pop(), 'No supported RGB BT.2020/PQ PNG attachments found.');

  attachments.get('0').size = 65 * 1024 * 1024;
  await fixHdrMessage(interaction);
  assert.equal(replies.pop(), 'Attachment exceeds 64 MiB.');
  attachments.get('0').size = 100;

  t.mock.method(globalThis, 'fetch', async () => { throw Error('internal transport details'); });
  await assert.rejects(fixHdrMessage(interaction), /internal transport details/);
  assert.deepEqual(replies, []);

  for (let i = 5; i < 11; i++) attachments.set(String(i), { name: `${i}.png` });
  await fixHdrMessage(interaction);
  assert.equal(replies.pop(), 'Convert at most ten PNG attachments per message.');
});

test('HDR command converts forwarded snapshot PNGs and enforces shared limits', async (t) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 16;
  header[9] = 2;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('cICP', Buffer.from([9, 16, 0, 1])),
    chunk('IDAT', Buffer.alloc(0))]);
  const attachment = { id: '123', name: 'forwarded.PNG', size: png.length,
    url: 'https://cdn.discordapp.com/attachments/123/456/forwarded.png' };
  const attachments = new Map([[attachment.id, attachment]]);
  const direct = new Map();
  /** @type {string[]} */
  const replies = [];
  /** @type {import('discord.js').MessageCreateOptions[]} */
  const posts = [];
  /** @type {string[]} */
  const downloads = [];
  const interaction = /** @type {import('discord.js').MessageContextMenuCommandInteraction} */ (/** @type {unknown} */ ({
    attachmentSizeLimit: 1024,
    deferReply: async () => {},
    editReply: async (/** @type {string} */ content) => { replies.push(content); },
    targetMessage: { id: 'forward', content: '', author: { username: 'Forwarder' },
      attachments: direct, messageSnapshots: new Map([['original', { content: 'Forwarded caption', attachments }]]),
      channel: { send: async (/** @type {import('discord.js').MessageCreateOptions} */ options) => {
        posts.push(options);
        return { url: 'https://discord.com/channels/guild/channel/result' };
      } },
    },
  }));
  t.mock.method(globalThis, 'fetch', async (/** @type {URL} */ url) => {
    downloads.push(String(url));
    return new Response(new Uint8Array(png));
  });
  const mock = t.mock.method(childProcess, 'execFile', (/** @type {[string, string[], object, (error: null, stdout: Buffer, stderr: Buffer) => void]} */ ...args) => {
    queueMicrotask(() => args[3](null, Buffer.from('avif'), Buffer.alloc(0)));
    return { stdin: { on() {}, end() {} } };
  });
  syncBuiltinESMExports();
  try {
    await fixHdrMessage(interaction);
    assert.deepEqual(downloads, [attachment.url, attachment.url]);
    assert.equal(posts.length, 1);
    assert.ok(posts[0]);
    assert.deepEqual(posts[0].files, [{ attachment: Buffer.from('avif'), name: 'hdr_123.avif' }]);
    assert.deepEqual(posts[0].reply, { messageReference: 'forward', failIfNotExists: false });
    assert.deepEqual(posts[0].embeds, [{ title: 'Forwarded by Forwarder',
      description: '**Forwarded message**\nForwarded caption' }]);
    assert.match(replies.pop() ?? '', /^Posted 1 AVIF/);

    interaction.targetMessage.content = 'Forwarder note';
    await fixHdrMessage(interaction);
    assert.deepEqual(posts[1]?.embeds, [{ title: 'Forwarded by Forwarder',
      description: 'Forwarder note\n\n**Forwarded message**\nForwarded caption' }]);
    assert.match(replies.pop() ?? '', /^Posted 1 AVIF/);

    attachment.size = 65 * 1024 * 1024;
    await fixHdrMessage(interaction);
    assert.equal(replies.pop(), 'Attachment exceeds 64 MiB.');
    attachment.size = png.length;
    for (let i = 0; i < 10; i++) direct.set(String(i), { name: `${i}.png` });
    await fixHdrMessage(interaction);
    assert.equal(replies.pop(), 'Convert at most ten PNG attachments per message.');
    assert.equal(downloads.length, 4);
    assert.equal(posts.length, 2);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

/** @param {Buffer} avif */
function assertHdrProfile(avif) {
  const marker = avif.indexOf(Buffer.from('colrprof'));
  assert.ok(marker >= 4);
  const profile = avif.subarray(marker + 8, marker - 4 + avif.readUInt32BE(marker - 4));
  assert.equal(profile.readUInt32BE(0), profile.length);
  assert.equal(profile.toString('ascii', 36, 40), 'acsp');
  const tags = new Map();
  for (let i = 0; i < profile.readUInt32BE(128); i++) {
    const entry = 132 + i * 12;
    const offset = profile.readUInt32BE(entry + 4);
    const size = profile.readUInt32BE(entry + 8);
    assert.ok(offset + size <= profile.length);
    tags.set(profile.toString('ascii', entry, entry + 4), profile.subarray(offset, offset + size));
  }
  assert.deepEqual(tags.get('cicp').subarray(8), Buffer.from([9, 16, 0, 1]));
  assert.equal(tags.get('lumi').readInt32BE(12) / 65536, 203);
  const whiteY = ['rXYZ', 'gXYZ', 'bXYZ'].reduce((sum, tag) =>
    sum + tags.get(tag).readInt32BE(12) / 65536, 0);
  assert.ok(Math.abs(whiteY - 1) < 0.00002);
  const curve = tags.get('rTRC');
  assert.deepEqual(tags.get('gTRC'), curve);
  assert.deepEqual(tags.get('bTRC'), curve);
  assert.equal(curve.readUInt32BE(8), 4096);
  assert.equal(curve.readUInt16BE(12), 0);
  assert.equal(curve.readUInt16BE(12 + 4095 * 2), 65535);
  let previous = 0;
  for (let i = 0; i < 4096; i++) {
    const value = curve.readUInt16BE(12 + i * 2);
    assert.ok(value >= previous);
    previous = value;
  }
  // ST 2084 encodes 203 cd/m² at approximately 0.580689.
  const diffuseWhite = curve.readUInt16BE(12 + Math.round(0.580688881 * 4095) * 2);
  assert.ok(Math.abs(diffuseWhite / 65535 * 10000 - 203) < 0.5);
}

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
        assertHdrProfile(result.bytes);
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
      assertHdrProfile(result.bytes);
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