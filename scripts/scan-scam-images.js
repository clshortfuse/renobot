/* eslint-disable no-console -- Operator-facing scan CLI. */
import { REST } from 'discord.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchHitMessages } from '../src/scam-search.js';
import { campaignMetadataStage, createScamOcr, detectCampaign, downloadScamImage, imageSignals, ImageInspectionAbort } from '../src/scam-detection.js';

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN ?? '');
const guild = process.env.DISCORD_GUILD_ID;
if (!guild) throw new Error('DISCORD_GUILD_ID is required');
const directory = join(tmpdir(), `renobot-scam-scan-${Date.now()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const retainOcr = process.argv.includes('--retain-ocr');
const audit = join(directory, 'audit.jsonl');
/** @param {Record<string, unknown>} record */
async function record(record) { await appendFile(audit, `${JSON.stringify(record)}\n`, { mode: 0o600 }); }
const ocr = createScamOcr();
const seen = new Set();
const start = performance.now();
let pages = 0;
let candidates = 0;
rest.on('rateLimited', () => { console.log('Rate limited: REST client waiting'); });
try {
  for (let offset = 0; offset < 500; offset += 25) {
    const result = /** @type {{code?: number, total_results: number, messages: (import('discord-api-types/v10').APIMessage & {hit?: boolean})[][]}} */ (
      await rest.get(`/guilds/${guild}/messages/search`, { query: new URLSearchParams({ has: 'image', sort_by: 'timestamp', sort_order: 'desc', offset: String(offset) }) }));
    pages++;
    if (result.code === 110000) { await record({ stage: 'search:indexing-incomplete' }); break; }
    for (const message of searchHitMessages(result.messages)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const attachments = message.attachments;
      const url = `https://discord.com/channels/${guild}/${message.channel_id}/${message.id}`;
      const metadata = attachments.map((a) => ({ filename: a.filename, width: a.width, height: a.height, reportedBytes: a.size }));
      const stage = campaignMetadataStage({ content: message.content, attachments });
      const isPair = !message.content.trim() && attachments.length === 2;
      if (stage) {
        await record({ id: message.id, url, stage, bytes: 0, metadata });
        if (isPair) { candidates++; console.log(JSON.stringify({ url, stage, bytes: 0 })); }
        continue;
      }
      candidates++;
      const texts = [];
      try {
        for (const [index, attachment] of attachments.entries()) {
          /** @type {{stage: string, bytes: number}[]} */
          const events = [];
          const bytes = await downloadScamImage(attachment.url, undefined, { hook: index === 0, report: (event) => events.push(event) });
          const text = await ocr.recognize(bytes);
          texts.push(text);
          await record({ id: message.id, stage: 'ocr:image', image: index + 1, bytes: bytes.length, events,
            signals: imageSignals(text), ...(retainOcr ? { text } : {}) });
          if (detectCampaign(texts)) break;
          if (index === 0 && !imageSignals(text).pitch && !imageSignals(text).compressedHook) break;
        }
        const finding = detectCampaign(texts);
        const final = { id: message.id, url, stage: finding ? 'result:match' : texts.length === 1 ? 'ocr:no-hook' : 'result:no-rule-match', reason: finding?.reason, metadata };
        await record(final); console.log(JSON.stringify(final));
      } catch (error) {
        const final = { id: message.id, url, stage: error instanceof ImageInspectionAbort ? error.stage : 'inspection:error',
          bytes: error instanceof ImageInspectionAbort ? error.bytes : undefined, error: String(error) };
        await record(final); console.log(JSON.stringify(final));
      }
    }
    if (offset + 25 >= result.total_results) break;
  }
} finally { await ocr.close(); }
console.log(JSON.stringify({ audit, pages, messages: seen.size, candidates, seconds: (performance.now() - start) / 1000 }));