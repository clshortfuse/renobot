/**
 * Services available to every command execution.
 *
 * @typedef {Readonly<{
 *   commands: ReadonlyMap<string, Command>,
 *   logger: import('pino').Logger,
 *   messageContentIntent: boolean,
 *   ownerUserId: string,
 *   guildId?: string,
 *   summarizeRoleId?: string | undefined,
 *   reviewCollection: import('../reviews/review.js').ReviewCollectionPreviewService,
 * }>} CommandContext
 */

/**
 * @typedef {Readonly<{
 *   access?: 'thread-owner' | 'summarize',
 *   data: import('discord.js').SlashCommandBuilder |
 *     import('discord.js').SlashCommandOptionsOnlyBuilder |
 *     import('discord.js').SlashCommandSubcommandsOnlyBuilder,
 *   execute: (
 *     interaction: import('discord.js').ChatInputCommandInteraction,
 *     context: CommandContext,
 *   ) => Promise<void>,
 * }>} Command
 */

export {};