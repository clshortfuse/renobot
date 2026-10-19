import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { campaignMetadataStage, createScamDetector, createScamOcr, detectCampaign, downloadScamImage, imageSignals } from '../src/scam-detection.js';
import sharp from 'sharp';

test('metadata gate excludes text, wrong counts and landscape hooks without downloads', () => {
  const portrait = { width: 600, height: 900 };
  assert.equal(campaignMetadataStage({ content: '', attachments: [portrait, portrait] }), undefined);
  assert.equal(campaignMetadataStage({ content: 'hello', attachments: [portrait, portrait] }), 'metadata:text');
  assert.equal(campaignMetadataStage({ content: '', attachments: [portrait] }), 'metadata:attachment-count');
  assert.equal(campaignMetadataStage({ content: '', attachments: [{ width: 900, height: 600 }, portrait] }), 'metadata:landscape-hook');
});

test('stream cancels landscape PNG/JPEG/WebP after header instead of consuming payload', async () => {
  for (const format of /** @type {const} */ (['png', 'jpeg', 'webp'])) {
    const bytes = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'red' } }).toFormat(format).toBuffer();
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
    await assert.rejects(downloadScamImage('https://cdn.discordapp.com/attachments/x/y', async () => new Response(stream), { hook: true }), /header:landscape-hook/u);
    assert.equal(cancelled, true);
  }
});

test('known domains match exact hosts/subdomains, not lookalike suffixes', () => {
  for (const host of ['wormwin.com', 'meviwin.com', 'basoowin.com', 'www.basoowin.com']) {
    assert.equal(detectCampaign([`Go to ${host}`])?.reason, 'Known scam domain');
  }
  assert.equal(detectCampaign(['wormwin.com.example.org']), undefined);
  assert.equal(detectCampaign(['notwormwin.com']), undefined);
});

test('all three observed campaign pitches support explicit bundle rules', () => {
  for (const [domain, amount, code] of [['wormwin.com', '2,500', 'TURBO'], ['meviwin.com', '5,600', 'BET'], ['basoowin.com', '3,500', 'CASH']]) {
    const pitch = `My cryptocurrency casino! Giving away $${amount}. Go to ${domain}. Enter the promo code: ${code}. Withdraw the bonus immediately.`;
    assert.equal(imageSignals(pitch).pitch, true);
    // Change the known hostname to exercise the rotated-domain fallback.
    assert.match(detectCampaign([pitch.replace(domain ?? '', 'rotated.invalid'), 'Activate Code for Bonus'])?.reason ?? '', /supporting/u);
  }
});

test('rotated domain needs separate supporting image; generic jokes and receipts do not match', () => {
  const pitch = 'crypto casino giving away $500 at newsite.invalid promo code CASH';
  assert.equal(detectCampaign([pitch]), undefined);
  assert.equal(detectCampaign([`${pitch} Withdrawal Success`]), undefined);
  assert.ok(detectCampaign([pitch, 'Your Withdrawal of $700 Was Successfully!']));
  assert.equal(detectCampaign(['MrBeast giving away $500 promo code JOKE', 'Withdrawal Success']), undefined);
  assert.equal(detectCampaign(['newsite.invalid', 'Withdrawal Success']), undefined);
  assert.equal(detectCampaign(['Crypto casino news at example.org', 'Activate Code for Bonus']), undefined);
});

test('downloads reject untrusted destinations, redirects and oversized bodies', async () => {
  for (const url of ['http://cdn.discordapp.com/attachments/x', 'https://example.org/attachments/x', 'https://cdn.discordapp.com.evil.org/attachments/x', 'https://cdn.discordapp.com/not-attachments/x']) {
    await assert.rejects(downloadScamImage(url), /Untrusted/u);
  }
  const url = 'https://cdn.discordapp.com/attachments/x/y/image.jpg';
  await assert.rejects(downloadScamImage(url, async () => new Response(null, { status: 302 })), /rejected/u);
  await assert.rejects(downloadScamImage(url, async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))), /byte limit/u);
  assert.deepEqual(await downloadScamImage(url, async () => new Response('abc')), Buffer.from('abc'));
});

/** @param {Record<string, unknown>} [overrides] */
function message(overrides = {}) {
  return /** @type {import('discord.js').Message} */ (/** @type {unknown} */ ({
    id: 'message', guildId: 'guild', channelId: 'source', author: { id: 'author', bot: false }, webhookId: null,
    attachments: new Map(['image', 'proof'].map((id) => [id, { id, name: 'image.jpg', size: 100, width: 100, height: 200, url: 'unused' }])),
    ...overrides,
  }));
}

test('intake exclusions, deduplication, hash cache and alert evidence', async () => {
  /** @type {{message: import('discord.js').Message, reason: string, image: Buffer | undefined}[]} */
  const sent = [];
  let recognitions = 0;
  const detector = createScamDetector({ guildId: 'guild', channelId: 'security', logger: pino({ level: 'silent' }),
    download: async () => Buffer.from('same image'),
    ocr: { recognize: async () => { recognitions++; return 'basoowin.com'; }, close: async () => {} },
    send: async (content) => { sent.push(content); } });
  for (const overrides of [{ guildId: 'foreign' }, { channelId: 'security' }, { author: { bot: true } }, { webhookId: 'webhook' }]) {
    await detector.enqueue(message(overrides));
  }
  assert.equal(sent.length, 0);
  await detector.enqueue(message());
  await detector.enqueue(message());
  await detector.enqueue(message({ id: 'second' }));
  assert.equal(sent.length, 2);
  assert.equal(recognitions, 1);
  assert.equal(sent[0]?.reason, 'Known scam domain');
  assert.equal(sent[0]?.message.author.id, 'author');
  assert.deepEqual(sent[0]?.image, Buffer.from('same image'));
  await detector.close();
  await detector.enqueue(message({ id: 'closed' }));
  assert.equal(sent.length, 2);
});

test('non-hook first image stops before supporting downloads', async () => {
  let downloads = 0;
  const detector = createScamDetector({ guildId: 'guild', channelId: 'security', logger: pino({ level: 'silent' }),
    download: async () => { downloads++; return Buffer.from('ordinary image'); },
    ocr: { recognize: async () => 'ordinary game screenshot', close: async () => {} },
    send: async () => { assert.fail('unexpected alert'); } });
  await detector.enqueue(message());
  assert.equal(downloads, 1);
  await detector.close();
});

test('queue drops excess work and supports forwarded attachments', async () => {
  let sent = 0;
  const detector = createScamDetector({ guildId: 'guild', channelId: 'security', logger: pino({ level: 'silent' }),
    download: async () => Buffer.from('image'),
    ocr: { recognize: async () => 'meviwin.com', close: async () => {} },
    send: async () => { sent++; } });
  const sample = message();
  await Promise.all(Array.from({ length: 25 }, (_, i) => detector.enqueue(message({ id: `${i}`, attachments: new Map(),
    messageSnapshots: new Map([['forward', { attachments: sample.attachments }]]) }))));
  assert.equal(sent, 20);
  await detector.close();
});

test('degraded 1+1 sample matches without a known domain or readable casino phrase', () => {
  const hook = 'CO thdraw the bonus immediately\nHow to claim your reward:\n1. Go to ruakax. com\nLe the special promo code: CUT\nReceive $3.700 bonus';
  const proof = 'ssful\nSuccess\nNithdrawal Suc\nWitha\nVV\n25a\nrawal was suc\nr withdra!\nReceiveg i\n/ x $3400,';
  assert.ok(detectCampaign([hook, proof]));
  assert.ok(detectCampaign([hook.replace('ruakax', 'anotherhost'), proof]));
  assert.equal(detectCampaign([hook]), undefined);
  assert.equal(detectCampaign([hook, 'Success! Receive your newsletter']), undefined);
  assert.equal(detectCampaign(['Go to shop. com promo code CUT', proof]), undefined);
  assert.equal(detectCampaign(['How to claim your reward: promo code CUT; bonus immediately', proof]), undefined);
});

test('OCR recognition failure terminates worker and next job can recover', async () => {
  let spawned = 0;
  let terminated = 0;
  const spawn = /** @type {typeof import('tesseract.js').createWorker} */ (/** @type {unknown} */ (
    async (/** @type {unknown} */ language, /** @type {unknown} */ engine, /** @type {{errorHandler: (error: string) => void}} */ options) => {
      spawned++;
      const fail = spawned === 1;
      return { recognize: async () => {
        if (fail) { options.errorHandler('failure'); throw new Error('recognition failed'); }
        return { data: { text: 'recovered' } };
      }, terminate: async () => { terminated++; } };
    }));
  const ocr = createScamOcr({ spawn, cooldownMs: 0 });
  const bytes = await sharp({ create: { width: 10, height: 20, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(ocr.recognize(bytes), /recognition failed/u);
  assert.equal(terminated, 1);
  assert.equal(await ocr.recognize(bytes), 'recovered');
  assert.equal(spawned, 2);
  await ocr.close();
});

test('owned OCR process can terminate before model initialization settles', async () => {
  const { createScamOcrProcess } = await import('../src/scam-ocr-process.js');
  const worker = await createScamOcrProcess();
  const rejected = assert.rejects(worker.recognize(Buffer.from('pending image')), /OCR process exited|closed|channel/iu);
  try {
    await worker.terminate();
    await rejected;
    await worker.terminate();
  } finally {
    await worker.terminate();
  }
});

test('OCR child exits on parent disconnect even with a live worker thread', async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = fork(new URL('./fixtures/scam-ocr-disconnect.js', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
  });
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2000) });
    child.disconnect();
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

test('indexed search excludes context before deduplication', async () => {
  const { searchHitMessages } = await import('../src/scam-search.js');
  const hit = { id: 'hit', hit: true };
  const legacy = /** @type {{id: string, hit?: boolean}} */ ({ id: 'legacy' });
  assert.deepEqual(searchHitMessages([[{ id: 'hit', hit: false }, hit], [legacy]]), [hit, legacy]);
});