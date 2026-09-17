import { ChannelType, PermissionFlagsBits } from 'discord.js';

/**
 * @typedef {import('discord.js').TextChannel |
 *   import('discord.js').NewsChannel |
 *   import('discord.js').ForumChannel |
 *   import('discord.js').MediaChannel} ReviewSourceChannel
 */

/**
 * @typedef {import('discord.js').TextChannel |
 *   import('discord.js').NewsChannel |
 *   import('discord.js').AnyThreadChannel} MessageSourceChannel
 */

/**
 * @typedef {{ total: number }} CollectionState
 */

/**
 * @param {Readonly<{
 *   channelIds: readonly string[],
 *   client: import('discord.js').Client,
 *   guildId: string,
 *   includeBots: boolean,
 *   logger: import('pino').Logger,
 *   maxMessages: number,
 *   since: Date,
 *   until: Date,
 * }>} options
 * @returns {Promise<import('./review.js').ReviewCollection>}
 */
export async function collectReviewConversations(options) {
  /** @type {import('./review.js').ReviewConversation[]} */
  const conversations = [];
  /** @type {CollectionState} */
  const state = { total: 0 };
  let matchingChannelCount = 0;

  for (const channelId of options.channelIds) {
    const channel = await options.client.channels.fetch(channelId);

    if (!isReviewSourceChannel(channel) || channel.guildId !== options.guildId) {
      options.logger.debug(
        { channelId, guildId: options.guildId },
        'Skipping review source outside the invoking guild or with an unsupported type',
      );
      continue;
    }

    matchingChannelCount += 1;
    assertReadable(channel);

    if (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement
    ) {
      const conversation = await collectConversation(
        channel,
        'channel',
        undefined,
        options,
        state,
      );

      if (conversation) {
        conversations.push(conversation);
      }
    }

    const threads = await fetchRecentPublicThreads(channel, options.since);

    for (const thread of threads) {
      const conversation = await collectConversation(
        thread,
        channel.type === ChannelType.GuildForum ||
          channel.type === ChannelType.GuildMedia
          ? 'forum-post'
          : 'thread',
        channel.name,
        options,
        state,
      );

      if (conversation) {
        conversations.push(conversation);
      }
    }
  }

  if (matchingChannelCount === 0) {
    throw new Error(
      'No configured review channels belong to this server or have a supported type.',
    );
  }

  conversations.sort((left, right) => left.name.localeCompare(right.name));

  return Object.freeze({
    conversations: Object.freeze(conversations),
    totalMessages: state.total,
  });
}

/**
 * @param {MessageSourceChannel} channel
 * @param {import('./review.js').ConversationKind} kind
 * @param {string | undefined} parentName
 * @param {Parameters<typeof collectReviewConversations>[0]} options
 * @param {CollectionState} state
 * @returns {Promise<import('./review.js').ReviewConversation | undefined>}
 */
async function collectConversation(
  channel,
  kind,
  parentName,
  options,
  state,
) {
  /** @type {import('./review.js').ReviewMessage[]} */
  const collectedMessages = [];
  /** @type {string | undefined} */
  let before;
  let reachedCutoff = false;

  while (!reachedCutoff) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (page.size === 0) {
      break;
    }

    const messages = [...page.values()];
    const oldestMessage = messages.reduce((oldest, message) =>
      message.createdTimestamp < oldest.createdTimestamp ? message : oldest,
    );
    before = oldestMessage.id;

    for (const message of messages) {
      if (message.createdTimestamp < options.since.getTime()) {
        reachedCutoff = true;
        continue;
      }

      if (message.createdTimestamp > options.until.getTime()) {
        continue;
      }

      if (
        message.system ||
        (!options.includeBots && message.author.bot) ||
        message.author.id === options.client.user?.id
      ) {
        continue;
      }

      const content = formatMessageContent(message);

      if (!content) {
        continue;
      }

      state.total += 1;

      if (state.total > options.maxMessages) {
        throw new Error(
          `Review collection exceeded REVIEW_MAX_MESSAGES (${options.maxMessages}).`,
        );
      }

      collectedMessages.push(
        Object.freeze({
          author:
            message.member?.displayName ??
            message.author.globalName ??
            message.author.username,
          content,
          createdAt: message.createdAt.toISOString(),
        }),
      );
    }

    if (page.size < 100) {
      break;
    }
  }

  if (collectedMessages.length === 0) {
    return undefined;
  }

  collectedMessages.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

  return Object.freeze({
    id: channel.id,
    kind,
    messages: Object.freeze(collectedMessages),
    name: channel.name,
    ...(parentName ? { parentName } : {}),
    url: channel.url,
  });
}

/**
 * @param {ReviewSourceChannel} channel
 * @param {Date} since
 * @returns {Promise<import('discord.js').AnyThreadChannel[]>}
 */
async function fetchRecentPublicThreads(channel, since) {
  /** @type {Map<string, import('discord.js').AnyThreadChannel>} */
  const threads = new Map();
  const active = await channel.threads.fetchActive(false);

  for (const thread of active.threads.values()) {
    if (thread.type !== ChannelType.PrivateThread) {
      threads.set(thread.id, thread);
    }
  }

  /** @type {Date | undefined} */
  let before;

  while (true) {
    const archived = await channel.threads.fetchArchived(
      {
        type: 'public',
        limit: 100,
        ...(before ? { before } : {}),
      },
      false,
    );
    const archivedThreads = [...archived.threads.values()];

    for (const thread of archivedThreads) {
      threads.set(thread.id, thread);
    }

    if (!archived.hasMore || archivedThreads.length === 0) {
      break;
    }

    const oldestThread = archivedThreads.reduce((oldest, thread) =>
      (thread.archiveTimestamp ?? Number.POSITIVE_INFINITY) <
      (oldest.archiveTimestamp ?? Number.POSITIVE_INFINITY)
        ? thread
        : oldest,
    );

    if (
      oldestThread.archiveTimestamp !== null &&
      oldestThread.archiveTimestamp < since.getTime()
    ) {
      break;
    }

    if (oldestThread.archiveTimestamp === null) {
      break;
    }

    before = new Date(oldestThread.archiveTimestamp);
  }

  return [...threads.values()];
}

/**
 * @param {import('discord.js').Message<true>} message
 * @returns {string}
 */
export function formatMessageContent(message) {
  const content = message.cleanContent
    .replaceAll('\r', '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const attachments = [...message.attachments.values()].map(
    (attachment) => `[attachment: ${attachment.name ?? 'file'}]`,
  );
  const stickers = [...message.stickers.values()].map(
    (sticker) => `[sticker: ${sticker.name}]`,
  );

  return [content, ...attachments, ...stickers].filter(Boolean).join(' ');
}

/**
 * @param {import('discord.js').Channel | null} channel
 * @returns {channel is ReviewSourceChannel}
 */
function isReviewSourceChannel(channel) {
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement ||
    channel?.type === ChannelType.GuildForum ||
    channel?.type === ChannelType.GuildMedia
  );
}

/**
 * @param {ReviewSourceChannel} channel
 */
function assertReadable(channel) {
  const botMember = channel.guild.members.me;
  const permissions = botMember && channel.permissionsFor(botMember);

  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    throw new Error(
      `Renobot needs View Channel and Read Message History in #${channel.name}.`,
    );
  }
}