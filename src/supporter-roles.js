import { DiscordAPIError } from 'discord.js';
import { testSupporterDiscordUserId } from './early-access.js';

/**
 * Reconcile one durable job without using Discord message/member gateway intents.
 * A pre-existing role is never adopted as Renobot-managed.
 * @param {import('./database.js').PortalDatabase} database
 * @param {import('discord.js').Client} bot
 * @param {string} guildId
 * @param {string} roleId
 * @param {Date} [now]
 */
export async function reconcileSupporterRole(database, bot, guildId, roleId, now = new Date()) {
  const sync = await database.dueSupporterSync(now);
  if (!sync) return false;
  try {
    const leases = await database.activeSupporterLeases(sync.discordUserId, now);
    const managed = await database.hasManagedSupporterRole(sync.discordUserId, roleId);
    const guild = await bot.guilds.fetch(guildId);
    /** @type {import('discord.js').GuildMember | undefined} */
    let member;
    try {
      member = await guild.members.fetch({ user: sync.discordUserId, force: true, cache: false });
    } catch (error) {
      if (!(error instanceof DiscordAPIError && error.code === 10007)) throw error;
    }
    if (member) {
      const hasRole = member.roles.cache.has(roleId);
      if (leases.length && !hasRole) {
        const role = await guild.roles.fetch(roleId);
        if (!role?.editable) throw new Error('Supporter role cannot be managed');
        await member.roles.add(roleId, 'Active Renobot supporter membership');
        await database.markManagedSupporterRole(sync.discordUserId, roleId);
      } else if (!leases.length && hasRole && managed) {
        const role = await guild.roles.fetch(roleId);
        if (!role?.editable) throw new Error('Supporter role cannot be managed');
        await member.roles.remove(roleId, 'Renobot supporter membership expired');
        await database.clearManagedSupporterRole(sync.discordUserId, roleId);
      } else if (!leases.length && managed) {
        await database.clearManagedSupporterRole(sync.discordUserId, roleId);
      }
    } else if (managed) {
      // A departed guild member no longer has this guild's role.
      await database.clearManagedSupporterRole(sync.discordUserId, roleId);
    }
    // Check again after Discord I/O. Do not lose a concurrent new payment's queue update.
    const updatedLeases = await database.activeSupporterLeases(sync.discordUserId, new Date());
    await database.settleSupporterSync(sync, updatedLeases.length
      ? new Date(Math.min(updatedLeases[0]?.expiresAt.getTime() ?? Infinity, Date.now() + 5 * 60_000)) : null);
  } catch {
    await database.settleSupporterSync(sync, new Date(Date.now() + Math.min(60 * 60_000,
      30_000 * 2 ** Math.min(sync.attemptCount, 7))), 'reconciliation-failed');
  }
  return true;
}

/**
 * @param {import('./database.js').PortalDatabase} database
 * @param {import('discord.js').Client} bot
 * @param {string} guildId
 * @param {string} roleId
 * @param {Date} [now]
 */
export async function reconcileEarlyAccessRole(database, bot, guildId, roleId, now = new Date()) {
  const sync = await database.dueEarlyAccessSync(now);
  if (!sync) return false;
  if (sync.discordUserId === testSupporterDiscordUserId) {
    await database.settleEarlyAccessSync(sync, null);
    return true;
  }
  try {
    const expiresAt = await database.earlyAccessExpiry(sync.discordUserId);
    const active = Boolean(expiresAt && expiresAt > now);
    const managed = await database.hasManagedSupporterRole(sync.discordUserId, roleId);
    const guild = await bot.guilds.fetch(guildId);
    /** @type {import('discord.js').GuildMember | undefined} */
    let member;
    try {
      member = await guild.members.fetch({ user: sync.discordUserId, force: true, cache: false });
    } catch (error) {
      if (!(error instanceof DiscordAPIError && error.code === 10007)) throw error;
    }
    if (member) {
      const hasRole = member.roles.cache.has(roleId);
      if (active && !hasRole) {
        const role = await guild.roles.fetch(roleId);
        if (!role?.editable) throw new Error('Early-access role cannot be managed');
        await member.roles.add(roleId, 'Active Renobot early-access period');
        await database.markManagedSupporterRole(sync.discordUserId, roleId);
      } else if (!active && hasRole && managed) {
        const role = await guild.roles.fetch(roleId);
        if (!role?.editable) throw new Error('Early-access role cannot be managed');
        await member.roles.remove(roleId, 'Renobot early-access period expired');
        await database.clearManagedSupporterRole(sync.discordUserId, roleId);
      } else if (!active && managed) {
        await database.clearManagedSupporterRole(sync.discordUserId, roleId);
      }
    } else if (managed) {
      await database.clearManagedSupporterRole(sync.discordUserId, roleId);
    }
    const updatedExpiry = await database.earlyAccessExpiry(sync.discordUserId);
    await database.settleEarlyAccessSync(sync, updatedExpiry && updatedExpiry > new Date()
      ? new Date(Math.min(updatedExpiry.getTime(), Date.now() + 5 * 60_000)) : null);
  } catch {
    await database.settleEarlyAccessSync(sync, new Date(Date.now() + Math.min(60 * 60_000,
      30_000 * 2 ** Math.min(sync.attemptCount, 7))), 'reconciliation-failed');
  }
  return true;
}

/**
 * @param {import('./database.js').PortalDatabase} database
 * @param {import('discord.js').Client} bot
 * @param {string} guildId
 * @param {string} roleId
 * @param {import('pino').Logger} logger
 */
export function startSupporterRoleWorker(database, bot, guildId, roleId, logger) {
  return startRoleWorker(database, bot, guildId, roleId, logger, reconcileSupporterRole);
}

/**
 * @param {import('./database.js').PortalDatabase} database
 * @param {import('discord.js').Client} bot
 * @param {string} guildId
 * @param {string} roleId
 * @param {import('pino').Logger} logger
 */
export function startEarlyAccessRoleWorker(database, bot, guildId, roleId, logger) {
  return startRoleWorker(database, bot, guildId, roleId, logger, reconcileEarlyAccessRole);
}

/**
 * @param {import('./database.js').PortalDatabase} database
 * @param {import('discord.js').Client} bot
 * @param {string} guildId
 * @param {string} roleId
 * @param {import('pino').Logger} logger
 * @param {typeof reconcileSupporterRole} reconcile
 */
function startRoleWorker(database, bot, guildId, roleId, logger, reconcile) {
  let running = false;
  let stopped = false;
  async function tick() {
    if (stopped || running || !bot.isReady()) return;
    running = true;
    try {
      for (let count = 0; count < 50 && !stopped; count++) {
        if (!await reconcile(database, bot, guildId, roleId)) break;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Supporter role reconciliation unavailable');
    } finally { running = false; }
  }
  const timer = setInterval(() => { void tick(); }, 30_000);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}