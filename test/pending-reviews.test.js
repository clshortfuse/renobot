import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPendingReviewStore } from '../src/reviews/pending-reviews.js';

describe('pending review store', () => {
  it('allows the requester to consume a preview once', () => {
    const store = createPendingReviewStore({
      createId: () => 'review-id',
      getCurrentTime: () => 1_000,
      timeToLiveMs: 500,
    });
    const review = store.create({
      channelId: 'channel',
      chunks: ['review'],
      guildId: 'guild',
      requesterId: 'moderator',
    });

    assert.equal(review.id, 'review-id');
    assert.equal(store.take('review-id', 'someone-else', 'guild'), undefined);
    assert.equal(store.take('review-id', 'moderator', 'guild')?.id, 'review-id');
    assert.equal(store.take('review-id', 'moderator', 'guild'), undefined);
  });

  it('expires stale previews', () => {
    let currentTime = 1_000;
    const store = createPendingReviewStore({
      createId: () => 'review-id',
      getCurrentTime: () => currentTime,
      timeToLiveMs: 500,
    });
    store.create({
      channelId: 'channel',
      chunks: ['review'],
      guildId: 'guild',
      requesterId: 'moderator',
    });
    currentTime = 1_500;

    assert.equal(store.take('review-id', 'moderator', 'guild'), undefined);
  });
});