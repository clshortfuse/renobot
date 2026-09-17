import { randomUUID } from 'node:crypto';

const defaultTimeToLiveMs = 15 * 60 * 1_000;

/**
 * @param {Readonly<{
 *   createId?: () => string,
 *   getCurrentTime?: () => number,
 *   timeToLiveMs?: number,
 * }>} [options]
 * @returns {import('./review.js').PendingReviewStore}
 */
export function createPendingReviewStore(options = {}) {
  const createId = options.createId ?? randomUUID;
  const getCurrentTime = options.getCurrentTime ?? Date.now;
  const timeToLiveMs = options.timeToLiveMs ?? defaultTimeToLiveMs;
  /** @type {Map<string, import('./review.js').PendingReview>} */
  const reviews = new Map();

  return Object.freeze({
    create(review) {
      pruneExpiredReviews();
      const id = createId();
      const pendingReview = Object.freeze({
        ...review,
        chunks: Object.freeze([...review.chunks]),
        expiresAt: getCurrentTime() + timeToLiveMs,
        id,
      });
      reviews.set(id, pendingReview);
      return pendingReview;
    },

    take(id, requesterId, guildId) {
      pruneExpiredReviews();
      const review = reviews.get(id);

      if (
        !review ||
        review.requesterId !== requesterId ||
        review.guildId !== guildId
      ) {
        return undefined;
      }

      reviews.delete(id);
      return review;
    },
  });

  function pruneExpiredReviews() {
    const currentTime = getCurrentTime();

    for (const [id, review] of reviews) {
      if (review.expiresAt <= currentTime) {
        reviews.delete(id);
      }
    }
  }
}