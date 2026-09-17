/**
 * @typedef {'channel' | 'thread' | 'forum-post'} ConversationKind
 */

/**
 * @typedef {Readonly<{
 *   author: string,
 *   content: string,
 *   createdAt: string,
 * }>} ReviewMessage
 */

/**
 * @typedef {Readonly<{
 *   id: string,
 *   kind: ConversationKind,
 *   messages: readonly ReviewMessage[],
 *   name: string,
 *   parentName?: string,
 *   url: string,
 * }>} ReviewConversation
 */

/**
 * @typedef {Readonly<{
 *   conversations: readonly ReviewConversation[],
 *   totalMessages: number,
 * }>} ReviewCollection
 */

/**
 * @typedef {Readonly<{
 *   conversationCount: number,
 *   messageCount: number,
 *   periodEnd: Date,
 *   periodStart: Date,
 * }>} ReviewCollectionPreview
 */

/**
 * @typedef {Readonly<{
 *   collect: (options: Readonly<{
 *     channelId: string,
 *     client: import('discord.js').Client,
 *     guildId: string,
 *   }>) => Promise<ReviewCollectionPreview>,
 * }>} ReviewCollectionPreviewService
 */

/**
 * @typedef {Readonly<{
 *   content: string,
 *   conversationCount: number,
 *   messageCount: number,
 *   periodEnd: Date,
 *   periodStart: Date,
 * }>} GeneratedReview
 */

/**
 * @typedef {Readonly<{
 *   complete: (systemPrompt: string, userPrompt: string) => Promise<string>,
 * }>} ChatCompletionClient
 */

/**
 * @typedef {Readonly<{
 *   generate: (options: Readonly<{
 *     client: import('discord.js').Client,
 *     days: number,
 *     guildId: string,
 *   }>) => Promise<GeneratedReview>,
 * }>} WeeklyReviewService
 */

/**
 * @typedef {Readonly<{
 *   channelId: string,
 *   chunks: readonly string[],
 *   guildId: string,
 *   requesterId: string,
 * }>} PendingReviewInput
 */

/**
 * @typedef {PendingReviewInput & Readonly<{
 *   expiresAt: number,
 *   id: string,
 * }>} PendingReview
 */

/**
 * @typedef {Readonly<{
 *   create: (review: PendingReviewInput) => PendingReview,
 *   take: (id: string, requesterId: string, guildId: string) => PendingReview | undefined,
 * }>} PendingReviewStore
 */

export {};