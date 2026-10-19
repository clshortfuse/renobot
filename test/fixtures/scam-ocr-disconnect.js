import '../../src/scam-ocr-child.js';
import { Worker } from 'node:worker_threads';

// Model a Tesseract thread whose initialization never settles, without network.
const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
worker.once('online', () => { process.send?.('ready'); });