import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { convertHdrPng, inspectHdrPng } from '../src/hdr-avif.js';

const inputs = process.argv.slice(2);
if (!inputs.length) throw Error('Supply original HDR PNG paths to benchmark.');
const directory = await mkdtemp(join(tmpdir(), 'renobot-hdr-benchmark-'));
try {
  for (const input of inputs) {
    if (inspectHdrPng(await readFile(input)) !== 'hdr') throw Error(`Unsupported HDR PNG: ${input}`);
    for (let trial = 1; trial <= 3; trial++) {
      const result = await convertHdrPng(resolve(input), join(directory, `${trial}-${basename(input)}.avif`));
      process.stdout.write(`${JSON.stringify({ input: basename(input), trial, milliseconds: result.milliseconds,
        bytes: result.bytes.length, nativeTimings: result.timings })}\n`);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}