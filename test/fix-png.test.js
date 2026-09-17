import assert from 'node:assert/strict';
import { it } from 'node:test';
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32, downloadPng, fixPng, MAX_PNG_BYTES } from '../src/fix-png.js';
import { iccp } from '../src/png-profile.js';
import command from '../src/commands/definitions/fixpng.js';

/** @param {string} type @param {Buffer} payload */
function chunk(type, payload) {
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length);
  result.write(type, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const pixels = chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30])));
/** @param {Buffer} [cicp] */
function png(cicp = Buffer.from([9, 16, 0, 1])) {
  return Buffer.concat([signature, chunk('IHDR', header), chunk('iCCP', Buffer.from('old')), chunk('cICP', cicp), pixels, chunk('IEND', Buffer.alloc(0))]);
}

it('embeds the exact reference profile and has owner-only access', () => {
  assert.equal(command.access, undefined);
  assert.equal(iccp.length, 2168);
  const profile = inflateSync(iccp.subarray(5), { maxOutputLength: 4324 });
  assert.equal(profile.length, 4324);
  // Compare against the reference source's complete digest, not a shortened display.
  assert.equal(createHash('sha256').update(profile).digest('hex'), '745265d126b3bbfdb6a0e481936d5e51752d4bfed11387b83536bcba9ce1884a');
});

it('replaces metadata exactly while preserving compressed pixels', () => {
  const input = png();
  const copy = Buffer.from(input);
  const output = fixPng(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(output, Buffer.concat([signature, chunk('IHDR', header), chunk('iCCP', iccp), pixels, chunk('IEND', Buffer.alloc(0))]));
});

it('rejects incorrect signaling, CRCs, truncation, trailing data and oversized chunks', () => {
  assert.throws(() => fixPng(png(Buffer.from([1, 13, 0, 1]))), /cICP/u);
  const corrupt = png();
  corrupt.writeUInt8(corrupt.readUInt8(29) ^ 1, 29);
  assert.throws(() => fixPng(corrupt), /CRC/u);
  assert.throws(() => fixPng(png().subarray(0, -1)), /Truncated/u);
  assert.throws(() => fixPng(Buffer.concat([png(), Buffer.from([0])])), /ending/u);
  const huge = png();
  huge.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => fixPng(huge), /Truncated/u);
  assert.throws(() => fixPng(Buffer.alloc(MAX_PNG_BYTES + 1)), /50 MiB/u);
});

it('rejects non-CDN URLs before any download', async () => {
  for (const url of ['http://cdn.discordapp.com/attachments/a', 'https://example.com/a', 'https://cdn.discordapp.com:123/attachments/a']) {
    await assert.rejects(downloadPng(url, async () => { assert.fail('must not fetch'); }), /Discord/u);
  }
});

it('bounds declared and actual download sizes and cancels oversized streams', async () => {
  const url = 'https://cdn.discordapp.com/attachments/a/b/test.png';
  await assert.rejects(downloadPng(url, async () => new Response('', { headers: { 'content-length': String(MAX_PNG_BYTES + 1) } })), /50 MiB/u);
  let cancelled = false;
  let sent = 0;
  await assert.rejects(downloadPng(url, async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(sent++ === 0 ? MAX_PNG_BYTES : 1)); },
    cancel() { cancelled = true; },
  }))), /50 MiB/u);
  assert.equal(cancelled, true);
  assert.deepEqual(await downloadPng(url, async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return new Response(png());
  }), png());
});