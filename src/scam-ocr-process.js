import { fork } from 'node:child_process';

/** Own the process before model initialization starts, so deadlines can kill it. */
export async function createScamOcrProcess() {
  const child = fork(new URL('./scam-ocr-child.js', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', execArgv: [],
  });
  /** @type {((error: Error) => void) | undefined} */
  let rejectJob;
  /** @type {((value: {data: {text: string}}) => void) | undefined} */
  let resolveJob;
  child.on('message', (message) => {
    const result = /** @type {{text?: string, error?: string}} */ (message);
    if (result.error) rejectJob?.(new Error(result.error));
    else resolveJob?.({ data: { text: result.text ?? '' } });
    resolveJob = undefined; rejectJob = undefined;
  });
  child.on('error', (error) => { rejectJob?.(error); });
  child.on('exit', () => {
    rejectJob?.(new Error('OCR process exited'));
    resolveJob = undefined; rejectJob = undefined;
  });
  return {
    /** @param {Buffer} image */
    recognize(image) {
      return new Promise((resolve, reject) => {
        resolveJob = resolve; rejectJob = reject;
        child.send(image, (error) => { if (error) reject(error); });
      });
    },
    async terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      });
    },
  };
}