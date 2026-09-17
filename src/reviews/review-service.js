import { collectReviewConversations } from './collect-messages.js';
import { compactWeeklyReview } from './compact-review.js';

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export class ReviewGenerationError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'ReviewGenerationError';
  }
}

/**
 * @param {Readonly<{
 *   channelIds: readonly string[],
 *   includeBots: boolean,
 *   logger: import('pino').Logger,
 *   maxInputCharacters: number,
 *   maxMessages: number,
 *   modelClient: import('./review.js').ChatCompletionClient,
 * }>} options
 * @param {() => Date} [getCurrentTime]
 * @returns {import('./review.js').WeeklyReviewService}
 */
export function createWeeklyReviewService(options, getCurrentTime = () => new Date()) {
  return Object.freeze({
    async generate({ client, days, guildId }) {
      const periodEnd = getCurrentTime();
      const periodStart = new Date(
        periodEnd.getTime() - days * millisecondsPerDay,
      );

      try {
        const collection = await collectReviewConversations({
          channelIds: options.channelIds,
          client,
          guildId,
          includeBots: options.includeBots,
          logger: options.logger,
          maxMessages: options.maxMessages,
          since: periodStart,
          until: periodEnd,
        });

        if (collection.totalMessages === 0) {
          throw new ReviewGenerationError(
            `No reviewable messages were found in the last ${days} day${days === 1 ? '' : 's'}.`,
          );
        }

        options.logger.info(
          {
            conversationCount: collection.conversations.length,
            guildId,
            messageCount: collection.totalMessages,
          },
          'Collected weekly review source material',
        );

        const content = await compactWeeklyReview(collection.conversations, {
          maxInputCharacters: options.maxInputCharacters,
          modelClient: options.modelClient,
          periodEnd,
          periodStart,
        });

        return Object.freeze({
          content,
          conversationCount: collection.conversations.length,
          messageCount: collection.totalMessages,
          periodEnd,
          periodStart,
        });
      } catch (error) {
        if (error instanceof ReviewGenerationError) {
          throw error;
        }

        throw new ReviewGenerationError(
          'Renobot could not generate the review. Check channel permissions, bot logs, and model configuration.',
          { cause: error },
        );
      }
    },
  });
}