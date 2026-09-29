import { DiscordAPIError } from 'discord.js';

/**
 * Re-check member roles via Discord REST for each privileged request; OAuth
 * sessions identify users but do not carry authoritative role claims.
 * @param {import('discord.js').Client} bot
 * @param {import('./web-config.js').WebConfig} config
 * @param {string} userId
 */
export async function resolveCapabilities(bot, config, userId) {
  if (userId === config.ownerUserId) return new Set(['authenticated', 'admin', 'modder', 'appeal:review']);
  const capabilities = new Set(['authenticated']);
  if (!config.modderRoleId && !config.moderatorRoleId) return capabilities;
  const guild = await bot.guilds.fetch(config.guildId);
  try {
    const member = await guild.members.fetch({ user: userId, force: true, cache: false });
    if (config.modderRoleId && member.roles.cache.has(config.modderRoleId)) capabilities.add('modder');
    if (config.moderatorRoleId && member.roles.cache.has(config.moderatorRoleId)) capabilities.add('appeal:review');
  } catch (error) {
    if (!(error instanceof DiscordAPIError && error.code === 10007)) throw error;
  }
  return capabilities;
}

/** @param {string} path */
export function requiredCapability(path) {
  if (path === '/app/modder' || path.startsWith('/app/modder/')) return 'modder';
  if (path === '/app/admin/appeals' || path.startsWith('/app/admin/appeals/')) return 'appeal:review';
  if (path === '/app/admin' || path.startsWith('/app/admin/')) return 'admin';
  return undefined;
}
