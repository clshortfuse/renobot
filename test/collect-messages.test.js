import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChannelType } from 'discord.js';
import pino from 'pino';

import { collectReviewConversations } from '../src/reviews/collect-messages.js';

const guildId = '23456789012345678';
const sourceChannelId = '34567890123456789';
const since = new Date('2026-07-14T00:00:00.000Z');
const until = new Date('2026-07-21T00:00:00.000Z');
const silentLogger = pino({ level: 'silent' });

describe('review message collection', () => {
  it('collects configured channels and public threads while filtering messages', async () => {
    const publicThread = createThread({
      id: '45678901234567890',
      messages: [createMessage('thread-message', '2026-07-18T12:00:00.000Z')],
      name: 'discussion',
      type: ChannelType.PublicThread,
    });
    const privateThread = createThread({
      id: '56789012345678901',
      messages: [],
      name: 'private',
      type: ChannelType.PrivateThread,
    });
    const channel = createTextChannel({
      activeThreads: [publicThread, privateThread],
      messages: [
        createMessage('included', '2026-07-17T12:00:00.000Z'),
        createMessage('old', '2026-07-13T23:59:59.000Z'),
        createMessage('future', '2026-07-21T00:00:01.000Z'),
        createMessage('bot', '2026-07-17T12:00:00.000Z', {
          author: {
            bot: true,
            globalName: null,
            id: 'other-bot',
            username: 'bot',
          },
        }),
        createMessage('self', '2026-07-17T12:00:00.000Z', {
          author: {
            bot: true,
            globalName: null,
            id: 'renobot',
            username: 'Renobot',
          },
        }),
        createMessage('system', '2026-07-17T12:00:00.000Z', {
          system: true,
        }),
      ],
      name: 'updates',
    });

    const result = await collectReviewConversations(createOptions(channel));

    assert.equal(result.totalMessages, 2);
    assert.deepEqual(
      result.conversations.map((conversation) => [
        conversation.kind,
        conversation.name,
        conversation.messages.length,
      ]),
      [
        ['thread', 'discussion', 1],
        ['channel', 'updates', 1],
      ],
    );
  });

  it('paginates message history until a short page is reached', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createMessage(
        `message-${index + 2}`,
        new Date(until.getTime() - index * 1_000).toISOString(),
      ));
    const secondPage = [
      createMessage('message-1', '2026-07-15T00:00:00.000Z'),
    ];
    /** @type {import('discord.js').FetchMessagesOptions[]} */
    const fetchOptions = [];
    const channel = createTextChannel({
      fetchMessages: async (options) => {
        fetchOptions.push(options);
        return fetchOptions.length === 1 ? firstPage : secondPage;
      },
      messages: [],
    });

    const result = await collectReviewConversations(
      createOptions(channel, { maxMessages: 200 }),
    );

    assert.equal(result.totalMessages, 101);
    assert.equal(fetchOptions.length, 2);
    assert.equal(fetchOptions[0]?.limit, 100);
    assert.equal(fetchOptions[1]?.before, 'message-101');
  });

  it('paginates archived public threads with an archive timestamp', async () => {
    const firstArchiveTimestamp = new Date(
      '2026-07-20T12:00:00.000Z',
    ).getTime();
    const firstThread = createThread({
      archiveTimestamp: firstArchiveTimestamp,
      id: '45678901234567890',
      messages: [],
      name: 'newer-archive',
      type: ChannelType.PublicThread,
    });
    const secondThread = createThread({
      archiveTimestamp: new Date('2026-07-18T12:00:00.000Z').getTime(),
      id: '56789012345678901',
      messages: [],
      name: 'older-archive',
      type: ChannelType.PublicThread,
    });
    /** @type {import('discord.js').FetchArchivedThreadOptions[]} */
    const fetchOptions = [];
    /** @type {boolean[]} */
    const cacheOptions = [];
    const channel = createTextChannel({
      fetchArchived: async (options, cache) => {
        fetchOptions.push(options);
        cacheOptions.push(cache);

        return fetchOptions.length === 1
          ? createFetchedThreads([firstThread], true)
          : createFetchedThreads([secondThread], false);
      },
      messages: [],
    });

    await collectReviewConversations(createOptions(channel));

    assert.equal(fetchOptions.length, 2);
    assert.deepEqual(cacheOptions, [false, false]);
    assert.deepEqual(fetchOptions.map((options) => options.type), [
      'public',
      'public',
    ]);
    assert.equal(fetchOptions[0]?.before, undefined);
    const secondBefore = fetchOptions[1]?.before;
    assert.ok(secondBefore instanceof Date);
    assert.equal(
      secondBefore.toISOString(),
      new Date(firstArchiveTimestamp).toISOString(),
    );
  });

  it('enforces the configured global message limit', async () => {
    const channel = createTextChannel({
      messages: [
        createMessage('first', '2026-07-17T12:00:00.000Z'),
        createMessage('second', '2026-07-17T13:00:00.000Z'),
      ],
    });

    await assert.rejects(
      collectReviewConversations(createOptions(channel, { maxMessages: 1 })),
      /Review collection exceeded REVIEW_MAX_MESSAGES \(1\)/u,
    );
  });

  it('rejects configured channels without required permissions', async () => {
    const channel = createTextChannel({ messages: [], readable: false });

    await assert.rejects(
      collectReviewConversations(createOptions(channel)),
      /Renobot needs View Channel and Read Message History/u,
    );
  });

  it('rejects configured sources outside the invoking guild', async () => {
    const channel = createTextChannel({
      guildId: '99999999999999999',
      messages: [],
    });

    await assert.rejects(
      collectReviewConversations(createOptions(channel)),
      /No configured review channels belong to this server/u,
    );
  });

  it('propagates configured channel fetch failures', async () => {
    const channel = createTextChannel({ messages: [] });
    const client = /** @type {import('discord.js').Client} */ (
      /** @type {unknown} */ ({
        channels: {
          fetch: async () => {
            throw new Error('channel fetch failed');
          },
        },
        user: { id: 'renobot' },
      })
    );

    await assert.rejects(
      collectReviewConversations(createOptions(channel, { client })),
      /channel fetch failed/u,
    );
  });

  it('propagates message history fetch failures', async () => {
    const channel = createTextChannel({
      fetchMessages: async () => {
        throw new Error('message fetch failed');
      },
      messages: [],
    });

    await assert.rejects(
      collectReviewConversations(createOptions(channel)),
      /message fetch failed/u,
    );
  });

  it('propagates public thread fetch failures', async () => {
    const channel = createTextChannel({
      fetchActive: async () => {
        throw new Error('thread fetch failed');
      },
      messages: [],
    });

    await assert.rejects(
      collectReviewConversations(createOptions(channel)),
      /thread fetch failed/u,
    );
  });
});

/**
 * @param {import('discord.js').TextChannel} channel
 * @param {Partial<Parameters<typeof collectReviewConversations>[0]>} [overrides]
 */
function createOptions(channel, overrides = {}) {
  return {
    channelIds: [sourceChannelId],
    client: /** @type {import('discord.js').Client} */ (
      /** @type {unknown} */ ({
        channels: {
          fetch: async (/** @type {string} */ channelId) =>
            channelId === sourceChannelId ? channel : null,
        },
        user: { id: 'renobot' },
      })
    ),
    guildId,
    includeBots: false,
    logger: silentLogger,
    maxMessages: 100,
    since,
    until,
    ...overrides,
  };
}

/**
 * @param {Readonly<{
 *   activeThreads?: import('discord.js').AnyThreadChannel[],
 *   fetchActive?: () => Promise<Readonly<{
 *     threads: Map<string, import('discord.js').AnyThreadChannel>,
 *   }>>,
 *   fetchArchived?: (
 *     options: import('discord.js').FetchArchivedThreadOptions,
 *     cache: boolean,
 *   ) => Promise<Readonly<{
 *     hasMore: boolean,
 *     threads: Map<string, import('discord.js').AnyThreadChannel>,
 *   }>>,
 *   fetchMessages?: (
 *     options: import('discord.js').FetchMessagesOptions,
 *   ) => Promise<import('discord.js').Message<true>[]>,
 *   guildId?: string,
 *   messages: import('discord.js').Message<true>[],
 *   name?: string,
 *   readable?: boolean,
 * }>} options
 * @returns {import('discord.js').TextChannel}
 */
function createTextChannel(options) {
  const channel = {
    guildId: options.guildId ?? guildId,
    guild: { members: { me: { id: 'renobot' } } },
    id: sourceChannelId,
    messages: {
      fetch: async (/** @type {import('discord.js').FetchMessagesOptions} */ fetchOptions) => {
        const messages = options.fetchMessages
          ? await options.fetchMessages(fetchOptions)
          : options.messages;

        return new Map(messages.map((message) => [message.id, message]));
      },
    },
    name: options.name ?? 'source',
    permissionsFor: () => ({ has: () => options.readable ?? true }),
    threads: {
      fetchActive: options.fetchActive ?? (async () => ({
        threads: new Map(
          (options.activeThreads ?? []).map((thread) => [thread.id, thread]),
        ),
      })),
      fetchArchived: options.fetchArchived ?? (async () =>
        createFetchedThreads([], false)),
    },
    type: ChannelType.GuildText,
    url: `https://discord.com/channels/${guildId}/${sourceChannelId}`,
  };

  return /** @type {import('discord.js').TextChannel} */ (
    /** @type {unknown} */ (channel)
  );
}

/**
 * @param {Readonly<{
 *   archiveTimestamp?: number | null,
 *   id: string,
 *   messages: import('discord.js').Message<true>[],
 *   name: string,
 *   type: ChannelType.PublicThread | ChannelType.PrivateThread,
 * }>} options
 * @returns {import('discord.js').AnyThreadChannel}
 */
function createThread(options) {
  return /** @type {import('discord.js').AnyThreadChannel} */ (
    /** @type {unknown} */ ({
      archiveTimestamp: options.archiveTimestamp ?? null,
      id: options.id,
      messages: {
        fetch: async () => new Map(
          options.messages.map((message) => [message.id, message]),
        ),
      },
      name: options.name,
      type: options.type,
      url: `https://discord.com/channels/${guildId}/${options.id}`,
    })
  );
}

/**
 * @param {import('discord.js').AnyThreadChannel[]} threads
 * @param {boolean} hasMore
 */
function createFetchedThreads(threads, hasMore) {
  return {
    hasMore,
    threads: new Map(threads.map((thread) => [thread.id, thread])),
  };
}

/**
 * @param {string} id
 * @param {string} createdAt
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('discord.js').Message<true>}
 */
function createMessage(id, createdAt, overrides = {}) {
  const createdDate = new Date(createdAt);

  return /** @type {import('discord.js').Message<true>} */ (
    /** @type {unknown} */ ({
      attachments: new Map(),
      author: {
        bot: false,
        globalName: null,
        id: `author-${id}`,
        username: `user-${id}`,
      },
      cleanContent: `content-${id}`,
      createdAt: createdDate,
      createdTimestamp: createdDate.getTime(),
      id,
      member: null,
      stickers: new Map(),
      system: false,
      ...overrides,
    })
  );
}