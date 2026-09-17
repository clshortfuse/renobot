export class SummaryAdmission {
  constructor() {
    /** @type {Set<string>} */
    this.active = new Set();
    /** @type {Map<string, number>} */
    this.cooldowns = new Map();
  }

  /** @param {string} userId @param {number} [now] */
  acquire(userId, now = Date.now()) {
    for (const [user, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(user);
    }
    if (this.active.has(userId)) return 'You already have a summary queued or running.';
    if (this.cooldowns.has(userId)) return 'Please wait 30 seconds between summary requests.';
    if (this.active.size >= 6) return 'The summary queue is full. Please try again later.';
    this.active.add(userId);
    this.cooldowns.set(userId, now + 30000);
    return undefined;
  }

  /** @param {string} userId @param {boolean} [succeeded] */
  release(userId, succeeded = true) {
    this.active.delete(userId);
    if (!succeeded) this.cooldowns.delete(userId);
  }
}