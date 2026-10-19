/**
 * Services available to every command execution.
 *
 * @typedef {Readonly<{
 *   commands: ReadonlyMap<string, Command>,
 *   logger: import('pino').Logger,
 *   messageContentIntent: boolean,
 *   ownerUserId: string,
 *   guildId?: string,
 *   securityChannelId?: string | undefined,
 *   securityAutodelete?: NonNullable<ReturnType<typeof import('../security-autodelete.js').readSecurityAutodeleteConfig>> | undefined,
 *   summarizeRoleId?: string | undefined,
 *   reviewCollection: import('../reviews/review.js').ReviewCollectionPreviewService,
 * }>} CommandContext
 */

/**
 * @typedef {Readonly<{
 *   access?: 'thread-owner' | 'summarize',
 *   data: import('discord.js').ContextMenuCommandBuilder | import('discord.js').SlashCommandBuilder |
 *     import('discord.js').SlashCommandOptionsOnlyBuilder |
 *     import('discord.js').SlashCommandSubcommandsOnlyBuilder,
 *   execute: (
 *     interaction: import('discord.js').ChatInputCommandInteraction,
 *     context: CommandContext,
 *   ) => Promise<void>,
 * }>} Command
 */

export {};