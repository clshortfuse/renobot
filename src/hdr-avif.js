import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxBytes = 64 * 1024 * 1024;
let busy = false;

/** Expected input/limit failures whose messages are safe to show to the user. */
export class HdrNotice extends Error {}

/** Scan only PNG metadata preceding image data. @param {Buffer} bytes */
export function inspectHdrPng(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) return 'unsupported';
  let pq = false;
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') return pq ? 'hdr' : 'unsupported';
    if (length > 1024 * 1024) throw new HdrNotice('PNG metadata exceeds scan limit.');
    if (offset + length + 12 > bytes.length) return 'more';
    if (type === 'IHDR') {
      if (length !== 13) throw new HdrNotice('Invalid PNG header.');
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width * height > 40_000_000) throw new HdrNotice('Image exceeds the 40-million-pixel limit.');
      if (bytes[offset + 17] !== 2) throw new HdrNotice('Only RGB PNGs are supported.');
    }
    if (type === 'cICP' && length === 4) {
      pq = bytes.subarray(offset + 8, offset + 12).equals(Buffer.from([9, 16, 0, 1]));
    }
    offset += length + 12;
  }
  return 'more';
}

/** @param {string} url @param {boolean} headerOnly */
async function download(url, headerOnly) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.discordapp.com') {
    throw Error('Only original Discord CDN attachments are supported.');
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok || !response.body) throw Error('Attachment download failed.');
  const reader = response.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (size > (headerOnly ? 2 * 1024 * 1024 : maxBytes)) {
        throw new HdrNotice(headerOnly ? 'PNG metadata exceeds scan limit.' : 'Attachment exceeds 64 MiB.');
      }
      if (headerOnly) {
        const state = inspectHdrPng(Buffer.concat(chunks));
        if (state !== 'more') return state === 'hdr' ? Buffer.concat(chunks) : null;
      }
    }
    return headerOnly ? null : Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

/** Convert using the same standalone executable as the drag-and-drop utility.
 * @param {string} input @param {string} output
 */
export async function convertHdrPng(input, output) {
  const started = performance.now();
  const { stdout } = await execute(process.env.HDR_CONVERTER_PATH || 'discord_hdr',
    ['--output', output, input], { timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true });
  return { bytes: await readFile(output), milliseconds: performance.now() - started, timings: stdout.trim() };
}

/** Convert PNG bytes without temporary files. @param {Buffer} input @param {number} [outputLimit] */
export async function convertHdrPngBytes(input, outputLimit = maxBytes) {
  if (input.length > maxBytes) throw Error('Attachment exceeds 64 MiB.');
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = execFile(process.env.HDR_CONVERTER_PATH || 'discord_hdr', ['--stdio'],
      { encoding: 'buffer', timeout: 180_000, maxBuffer: outputLimit, windowsHide: true },
      (error, stdout, stderr) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          && error.message === 'stdout maxBuffer length exceeded') {
          reject(new HdrNotice('Converted AVIF exceeds the server upload limit.'));
        } else if (error) reject(error);
        else resolve({ bytes: stdout, timings: stderr.toString().trim() });
      });
    child.stdin?.on('error', error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE') {
        child.kill();
        reject(error);
      }
    });
    child.stdin?.end(input);
  });
  return { ...result, milliseconds: performance.now() - started };
}

/** Preserve the caption independently of the reply reference, without pinging anyone.
 * @param {Pick<import('discord.js').Message, 'id' | 'content' | 'author'>} message
 * @param {import('discord.js').AttachmentPayload[]} files
 * @returns {import('discord.js').MessageCreateOptions}
 */
export function hdrReplyOptions(message, files) {
  return {
    content: 'Fixed for Discord',
    embeds: [{ author: { name: message.author.username },
      ...(message.content ? { description: message.content } : {}) }],
    files,
    reply: { messageReference: message.id, failIfNotExists: false },
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** @param {import('discord.js').MessageContextMenuCommandInteraction} interaction */
export async function fixHdrMessage(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (busy) {
    await interaction.editReply('An HDR conversion is already running. Please try again shortly.');
    return;
  }
  busy = true;
  const started = performance.now();
  try {
    const message = interaction.targetMessage;
    const attachments = [...message.attachments.values()].filter(a => a.name?.toLowerCase().endsWith('.png'));
    if (attachments.length > 10) throw new HdrNotice('Convert at most ten PNG attachments per message.');
    /** @type {import('discord.js').AttachmentPayload[]} */
    const files = [];
    for (const attachment of attachments) {
      if (attachment.size > maxBytes) throw new HdrNotice('Attachment exceeds 64 MiB.');
      if (!await download(attachment.url, true)) continue;
      const bytes = await download(attachment.url, false);
      if (!bytes || inspectHdrPng(bytes) !== 'hdr') throw new HdrNotice('Unsupported PNG metadata.');
      const { bytes: result } = await convertHdrPngBytes(bytes, interaction.attachmentSizeLimit);
      if (result.length > interaction.attachmentSizeLimit) {
        throw new HdrNotice('Converted AVIF exceeds the server upload limit.');
      }
      files.push({ attachment: result, name: `hdr_${attachment.id}.avif` });
    }
    if (!files.length) {
      await interaction.editReply('No supported RGB BT.2020/PQ PNG attachments found.');
      return;
    }
    if (!('send' in message.channel)) throw Error('Cannot post HDR conversions in this channel.');
    const posted = await message.channel.send(hdrReplyOptions(message, files));
    await interaction.editReply(`Posted ${files.length} AVIF(s) in ${(performance.now() - started) / 1000 | 0}s: ${posted.url}`);
  } catch (error) {
    if (error instanceof HdrNotice) await interaction.editReply(error.message);
    else throw error;
  } finally {
    busy = false;
  }
}