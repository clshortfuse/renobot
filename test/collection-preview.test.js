import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChannelType } from 'discord.js';

import { createReviewCollectionPreview } from '../src/reviews/collection-preview.js';

const channelId = '34567890123456789';
const guildId = '23456789012345678';

describe('review collection preview', () => {
  it('returns and logs count-only metadata for a deterministic period', async () => {
    const currentTime = new Date('2026-07-21T12:00:00.000Z');
    const sensitiveContent = 'private review source content';
    const { logger, records } = createLogger();
    const service = createReviewCollectionPreview(
      {
        includeBots: false,
        logger,
        lookbackDays: 7,
        maxMessages: 100,
      },
      () => currentTime,
    );

    const preview = await service.collect({
      channelId,
      client: createClient(sensitiveContent),
      guildId,
    });

    assert.deepEqual(preview, {
      conversationCount: 1,
      messageCount: 1,
      periodEnd: currentTime,
      periodStart: new Date('2026-07-14T12:00:00.000Z'),
    });
    assert.deepEqual(Object.keys(preview), [
      'conversationCount',
      'messageCount',
      'periodEnd',
      'periodStart',
    ]);
    assert.ok(Object.isFrozen(preview));
    assert.deepEqual(records, [
      {
        data: {
          channelId,
          conversationCount: 1,
          guildId,
          messageCount: 1,
        },
        message: 'Collected review source preview',
      },
    ]);
    assert.equal(JSON.stringify({ preview, records }).includes(sensitiveContent), false);
  });
});

/**
 * @param {string} content
 * @returns {import('discord.js').Client}
 */
function createClient(content) {
  const createdAt = new Date('2026-07-18T12:00:00.000Z');
  const message = {
    attachments: new Map(),
    author: {
      bot: false,
      globalName: null,
      id: '45678901234567890',
      username: 'reviewer',
    },
    cleanContent: content,
    createdAt,
    createdTimestamp: createdAt.getTime(),
    id: '56789012345678901',
    member: null,
    stickers: new Map(),
    system: false,
  };
  const channel = {
    guildId,
    guild: { members: { me: { id: 'renobot' } } },
    id: channelId,
    messages: {
      fetch: async () => new Map([[message.id, message]]),
    },
    name: 'review-source',
    permissionsFor: () => ({ has: () => true }),
    threads: {
      fetchActive: async () => ({ threads: new Map() }),
      fetchArchived: async () => ({ hasMore: false, threads: new Map() }),
    },
    type: ChannelType.GuildText,
    url: `https://discord.com/channels/${guildId}/${channelId}`,
  };

  return /** @type {import('discord.js').Client} */ (
    /** @type {unknown} */ ({
      channels: { fetch: async () => channel },
      user: { id: 'renobot' },
    })
  );
}

function createLogger() {
  /** @type {{ data: Record<string, unknown>, message: string }[]} */
  const records = [];
  const logger = /** @type {import('pino').Logger} */ (
    /** @type {unknown} */ ({
      debug() {},
      info(
        /** @type {Record<string, unknown>} */ data,
        /** @type {string} */ message,
      ) {
        records.push({ data, message });
      },
    })
  );

  return { logger, records };
}