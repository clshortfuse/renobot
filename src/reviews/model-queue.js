/** Shared process-local inference scheduler. */
export class ModelQueue {
  /** @param {{ maxPending?: number, maxWaitMs?: number }} [options] */
  constructor({ maxPending = 5, maxWaitMs = 300000 } = {}) {
    this.maxPending = maxPending;
    this.maxWaitMs = maxWaitMs;
    this.active = false;
    /** @type {Array<{ run: () => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pending = [];
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @param {(position: number, waiting: number) => Promise<void>} [onQueued]
   * @returns {Promise<T>}
   */
  run(task, onQueued) {
    if (this.active && this.pending.length >= this.maxPending) {
      return Promise.reject(new Error('The LLM queue is full. Please try again later.'));
    }
    return new Promise((resolve, reject) => {
      const position = this.active ? this.pending.length + 1 : 0;
      // Observe admission immediately; UI failures must not block inference.
      const notification = Promise.resolve().then(() => onQueued?.(position, position)).catch(() => {});
      const run = () => {
        this.active = true;
        notification.then(task).then(resolve, reject).finally(() => {
          const next = this.pending.shift();
          if (next) {
            clearTimeout(next.timer);
            next.run();
          } else this.active = false;
        });
      };
      if (!this.active) { run(); return; }
      const job = { run, timer: setTimeout(() => {
        const index = this.pending.indexOf(job);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error('The LLM queue wait expired. Please try again later.'));
      }, this.maxWaitMs) };
      this.pending.push(job);
    });
  }
}

export const sharedModelQueue = new ModelQueue();