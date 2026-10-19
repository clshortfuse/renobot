import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createScamOcrProcess } from './scam-ocr-process.js';
import { imageSize } from 'image-size';

const KNOWN_DOMAINS = new Set(['wormwin.com', 'meviwin.com', 'basoowin.com']);
const MAX_BYTES = 8 * 1024 * 1024;

/** @param {{content: string, attachments: {width?: number | null, height?: number | null}[]}} message */
export function campaignMetadataStage({ content, attachments }) {
  if (content.trim()) return 'metadata:text';
  if (![2, 4].includes(attachments.length)) return 'metadata:attachment-count';
  const first = attachments[0];
  if (first?.width && first.height && first.height <= first.width) return 'metadata:landscape-hook';
  return undefined;
}

export class ImageInspectionAbort extends Error {
  /** @param {string} stage @param {number} bytes */
  constructor(stage, bytes) { super(stage); this.stage = stage; this.bytes = bytes; }
}

/** @param {string} text */
export function imageSignals(text) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ');
  const domainText = normalized.replace(/(?<=[a-z0-9])\s*\.\s*(?=[a-z])/gu, '.');
  const domains = [...new Set(domainText.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gu) ?? [])];
  const known = domains.filter((domain) => KNOWN_DOMAINS.has(domain)
    || [...KNOWN_DOMAINS].some((host) => domain.endsWith(`.${host}`)));
  const casino = /\b(?:crypto|cryptocurrency) casino\b/u.test(normalized);
  const giveaway = /\$\s*\d/u.test(normalized) && /giving away|\bbonus\b/u.test(normalized);
  const instructions = /promo\s*code|how to claim/u.test(normalized);
  const withdrawal = /withdraw.{0,100}(?:instantly|immediately)/u.test(normalized);
  const bonusPage = /activat/u.test(normalized) && /\bcode\b/u.test(normalized) && /\bbonus\b/u.test(normalized);
  const withdrawalPage = /withdrawal.{0,40}success/u.test(normalized);
  const compressedHook = domains.length > 0 && /how to claim your reward/u.test(normalized)
    && /promo\s*code/u.test(normalized) && /(?:withdraw|thdraw).{0,40}bonus.{0,30}(?:instantly|immediately)/u.test(normalized);
  const payout = /(?:withdrawal|nithdrawal|rawal).{0,25}(?:suc|success)/u.test(normalized)
    && /receiv(?:ed|eg)\b/u.test(normalized) && /\$\s*\d/u.test(normalized);
  return { domains, known, pitch: domains.length > 0 && casino && giveaway && (instructions || withdrawal),
    compressedHook, payout,
    support: bonusPage || withdrawalPage,
    rules: [casino ? 'crypto-casino' : '', giveaway ? 'cash-bonus' : '', instructions ? 'claim-instructions' : '',
      withdrawal ? 'instant-withdrawal' : '', bonusPage ? 'bonus-activation' : '', withdrawalPage ? 'withdrawal-success' : '',
      compressedHook ? 'claim-bonus-hook' : '', payout ? 'withdrawal-receipt' : ''].filter(Boolean) };
}

/** @param {string[]} texts */
export function detectCampaign(texts) {
  const images = texts.map(imageSignals);
  if (images.some((image) => image.known.length)) return { reason: 'Known scam domain', images };
  if (images.some((image, index) => image.compressedHook
    && images.some((other, otherIndex) => index !== otherIndex && other.payout))) {
    return { reason: 'Giveaway claim hook with separate withdrawal receipt', images };
  }
  if (images.some((image, index) => image.pitch && images.some((other, otherIndex) => otherIndex !== index && other.support))) {
    return { reason: 'Casino giveaway with supporting bonus/withdrawal image', images };
  }
  return undefined;
}

/** @param {string} url @param {typeof fetch} [request]
 * @param {{hook?: boolean, report?: (event: {stage: string, bytes: number}) => void}} [options] */
export async function downloadScamImage(url, request = fetch, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.discordapp.com'
    || parsed.port || parsed.username || parsed.password || !parsed.pathname.startsWith('/attachments/')) {
    throw new Error('Untrusted attachment URL');
  }
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('Attachment download rejected');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty attachment response');
  const chunks = [];
  let size = 0;
  let headerDone = false;
  let prefix = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error('Attachment exceeds byte limit');
      chunks.push(value);
      if (!headerDone) {
        prefix = Buffer.concat([prefix, value.subarray(0, Math.max(0, 65536 - prefix.length))]);
        let dimensions;
        try { dimensions = imageSize(prefix); } catch { /* Incomplete header: await another chunk, up to the budget. */ }
        if (dimensions) {
          headerDone = true;
          const { width, height, type, orientation } = dimensions;
          let stage;
          if (!['png', 'jpg', 'webp'].includes(type ?? '')) stage = 'header:unsupported-format';
          else if (!width || !height || width * height > 8_000_000) stage = 'header:pixel-limit';
          // Rotated JPEG EXIF can change presentation: do not exclude on raw dimensions in that case.
          else if (options.hook && (!orientation || orientation === 1) && height <= width) stage = 'header:landscape-hook';
          if (stage) { options.report?.({ stage, bytes: size }); throw new ImageInspectionAbort(stage, size); }
          options.report?.({ stage: 'header:accepted', bytes: size });
        } else if (prefix.length >= 65536) {
          headerDone = true;
          options.report?.({ stage: 'header:inconclusive', bytes: size });
        }
      }
    }
  } finally {
    await reader.cancel();
  }
  if (!headerDone) options.report?.({ stage: 'header:inconclusive', bytes: size });
  return Buffer.concat(chunks);
}

/** Creates an isolated worker; never sends images to an external service.
 * @param {{spawn?: typeof import('tesseract.js').createWorker | typeof createScamOcrProcess, cooldownMs?: number}} [options] */
export function createScamOcr({ spawn = createScamOcrProcess, cooldownMs = 30_000 } = {}) {
  /** @type {Awaited<ReturnType<NonNullable<typeof spawn>>> | undefined} */
  let worker;
  let jobs = 0;
  let closed = false;
  let retryAt = 0;
  let generation = 0;
  /** @type {Promise<void> | undefined} */
  let initializing;
  return {
    /** @param {Buffer} bytes */
    async recognize(bytes) {
      if (closed) throw new Error('OCR is closed');
      if (initializing || Date.now() < retryAt) throw new Error('OCR recovery pending');
      const image = await sharp(bytes, { limitInputPixels: 8_000_000, animated: false })
        .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).timeout({ seconds: 5 }).png().toBuffer();
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const currentGeneration = generation;
      const operation = (async () => {
        if (!worker) {
          initializing = (async () => {
            // Job promises carry errors; avoid Tesseract's additional callback throw.
            const created = await spawn('eng', 1, { errorHandler: () => {} });
            if (closed || generation !== currentGeneration) {
              await created.terminate();
              throw new Error('OCR initialization cancelled');
            }
            worker = created;
          })();
          try { await initializing; } finally { initializing = undefined; }
        }
        if (!worker) throw new Error('OCR worker unavailable');
        return (await worker.recognize(image)).data.text.slice(0, 30_000);
      })();
      try {
        const text = await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new Error('OCR deadline exceeded')); }, 20_000);
        })]);
        jobs++;
        if (jobs >= 100) { await worker?.terminate(); worker = undefined; jobs = 0; }
        return /** @type {string} */ (text);
      } catch (error) {
        generation++;
        retryAt = Date.now() + cooldownMs;
        await worker?.terminate();
        worker = undefined;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() { closed = true; await worker?.terminate(); worker = undefined; },
  };
}

/**
 * @param {{guildId: string, channelId: string, logger: import('pino').Logger,
 * send: (alert: {message: import('discord.js').Message, reason: string, image: Buffer | undefined}) => Promise<unknown>,
 * ocr?: ReturnType<typeof createScamOcr>, download?: typeof downloadScamImage}} options
 */
export function createScamDetector({ guildId, channelId, logger, send, ocr = createScamOcr(), download = downloadScamImage }) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  let pending = 0;
  let closed = false;
  let chain = Promise.resolve();
  return {
    /** @param {import('discord.js').Message} message */
    enqueue(message) {
      if (closed || message.guildId !== guildId || message.channelId === channelId
        || message.author.bot || message.webhookId || seen.has(message.id)) return Promise.resolve();
      const attachments = [...message.attachments.values(),
        ...[...(message.messageSnapshots?.values() ?? [])].flatMap((snapshot) => [...snapshot.attachments.values()])];
      const metadataStage = campaignMetadataStage({ content: message.content ?? '', attachments });
      if (metadataStage) {
        logger.debug({ messageId: message.id, stage: metadataStage, bytes: 0 }, 'Scam inspection aborted');
        return Promise.resolve();
      }
      if (pending >= 20) {
        logger.warn({ messageId: message.id }, 'Scam detector queue full; skipped message');
        return Promise.resolve();
      }
      seen.add(message.id);
      if (seen.size > 1000) seen.delete(/** @type {string} */ (seen.values().next().value));
      pending++;
      chain = chain.then(async () => {
        if (closed) return;
        const texts = [];
        /** @type {Buffer | undefined} */
        let evidenceImage;
        /** @type {string[]} */
        const hashes = [];
        for (const attachment of attachments) {
          try {
            const bytes = await download(attachment.url, undefined, { hook: texts.length === 0,
              report: (event) => logger.debug({ messageId: message.id, attachmentId: attachment.id, ...event }, 'Scam header inspection') });
            const hash = createHash('sha256').update(bytes).digest('hex');
            evidenceImage ??= bytes;
            const text = cache.get(hash) ?? await ocr.recognize(bytes);
            cache.set(hash, text);
            if (cache.size > 500) cache.delete(/** @type {string} */ (cache.keys().next().value));
            texts.push(text);
            hashes.push(hash);
          } catch (error) {
            if (error instanceof ImageInspectionAbort && texts.length === 0) return;
            logger.warn({ err: error, messageId: message.id, attachmentId: attachment.id }, 'Scam image inspection failed');
            texts.push(''); hashes.push('unavailable');
          }
          const finding = detectCampaign(texts);
          if (texts.length === 1 && !finding) {
            const hook = imageSignals(texts[0] ?? '');
            if (!hook.pitch && !hook.compressedHook) {
              logger.debug({ messageId: message.id, stage: 'ocr:no-hook' }, 'Scam inspection aborted');
              return;
            }
          }
          if (finding) {
            logger.info({ messageId: message.id, authorId: message.author.id, hashes, images: finding.images,
              reason: finding.reason }, 'Scam evidence detected');
            await send({ message, reason: finding.reason, image: evidenceImage });
            break;
          }
        }
      }).catch((error) => { logger.error({ err: error, messageId: message.id }, 'Scam detection failed'); })
        .finally(() => { pending--; });
      return chain;
    },
    async close() { closed = true; await ocr.close(); await chain; },
  };
}