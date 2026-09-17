import { collectReviewConversations } from './collect-messages.js';

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

/**
 * @param {Readonly<{
 *   includeBots: boolean,
 *   logger: import('pino').Logger,
 *   lookbackDays: number,
 *   maxMessages: number,
 * }>} options
 * @param {() => Date} [getCurrentTime]
 * @returns {import('./review.js').ReviewCollectionPreviewService}
 */
export function createReviewCollectionPreview(
  options,
  getCurrentTime = () => new Date(),
) {
  return Object.freeze({
    async collect({ channelId, client, guildId }) {
      const periodEnd = getCurrentTime();
      const periodStart = new Date(
        periodEnd.getTime() - options.lookbackDays * millisecondsPerDay,
      );
      const collection = await collectReviewConversations({
        channelIds: [channelId],
        client,
        guildId,
        includeBots: options.includeBots,
        logger: options.logger,
        maxMessages: options.maxMessages,
        since: periodStart,
        until: periodEnd,
      });
      const preview = Object.freeze({
        conversationCount: collection.conversations.length,
        messageCount: collection.totalMessages,
        periodEnd,
        periodStart,
      });

      options.logger.info(
        {
          channelId,
          conversationCount: preview.conversationCount,
          guildId,
          messageCount: preview.messageCount,
        },
        'Collected review source preview',
      );

      return preview;
    },
  });
}