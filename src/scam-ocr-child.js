import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from 'tesseract.js';

// Do not await Tesseract: model initialization may never settle.
process.once('disconnect', () => { process.exit(0); });

/** @type {ReturnType<typeof createWorker> | undefined} */
let worker;
process.on('message', async (image) => {
  try {
    worker ??= (async () => {
      const cachePath = join(tmpdir(), 'renobot-ocr');
      await mkdir(cachePath, { recursive: true });
      return createWorker('eng', 1, { cachePath, errorHandler: () => {} });
    })();
    const result = await (await worker).recognize(/** @type {Buffer} */ (image));
    process.send?.({ text: result.data.text.slice(0, 30_000) });
  } catch (error) {
    process.send?.({ error: String(error) });
  }
});