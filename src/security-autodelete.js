import { PermissionFlagsBits } from 'discord.js';
import { deleteAlertSource } from './scam-alerts.js';

const WINDOW = 60_000;
const RATE_WINDOW = 10 * 60_000;
const WARNING_WINDOW = 60_000;

/** @param {NodeJS.ProcessEnv} [env] */
export function readSecurityAutodeleteConfig(env = process.env) {
  const channelId = env.DISCORD_HONEYPOT_CHANNEL_ID?.trim();
  if (!channelId) return undefined;
  if (!/^\d{17,20}$/u.test(channelId)) throw new Error('Invalid DISCORD_HONEYPOT_CHANNEL_ID');
  const mode = env.SECURITY_AUTODELETE_MODE?.trim() || 'dry-run';
  if (!['dry-run', 'enforce'].includes(mode)) throw new Error('Invalid SECURITY_AUTODELETE_MODE');
  /** @param {string} name */
  const ids = name => {
    const values = (env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (values.some(value => !/^\d{17,20}$/u.test(value))) throw new Error(`Invalid ${name}`);
    return values;
  };
  /** @param {string} name @param {number} fallback */
  const limit = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error(`Invalid ${name}`);
    return value;
  };
  return { channelId, mode,
    exemptUsers: ids('SECURITY_AUTODELETE_EXEMPT_USER_IDS'), exemptRoles: ids('SECURITY_AUTODELETE_EXEMPT_ROLE_IDS'),
    userLimit: limit('SECURITY_AUTODELETE_USER_LIMIT', 10), guildLimit: limit('SECURITY_AUTODELETE_GUILD_LIMIT', 30) };
}

/** @typedef {NonNullable<ReturnType<typeof readSecurityAutodeleteConfig>>} Config */
/** @param {{config: Config, guildId: string, ownerUserId: string,
 * report: (text: string) => Promise<unknown>,
 * onDelete: (message: {guildId: string, channelId: string, id: string}) => Promise<unknown>,
 * logger: import('pino').Logger,
 * alert: (message: import('discord.js').Message, reason: string) => Promise<unknown>,
 * annotate: (message: import('discord.js').Message, status: string) => Promise<unknown>,
 * now?: () => number}} options */
export function createSecurityAutodelete({ config, guildId, ownerUserId, report, onDelete, logger,
  alert, annotate, now = Date.now }) {
  /** @type {Map<string, {at: number, messageId: string}>} */
  const triggers = new Map();
  /** @type {Map<string, {message: import('discord.js').Message, at: number, done: boolean}>} */
  const candidates = new Map();
  /** @type {Map<string, {message: import('discord.js').Message, at: number, warnedAt?: number}>} */
  const activity = new Map();
  /** @type {Map<string, Promise<void>>} */
  const pendingWarnings = new Map();
  let warningChain = Promise.resolve();
  /** @type {{at: number, userId: string}[]} */
  const actions = [];
  let paused = false;
  let pending = 0;
  let chain = Promise.resolve();
  /** @type {Map<string, {cancelled: boolean, message: import('discord.js').Message, timer?: ReturnType<typeof setTimeout> | undefined, reaction?: import('discord.js').MessageReaction | undefined}>} */
  const scheduled = new Map();
  /** @param {string} id */
  async function cancel(id) {
    const item = scheduled.get(id);
    if (!item || item.cancelled) return;
    item.cancelled = true;
    clearTimeout(item.timer);
    await item.reaction?.users.remove(item.message.client.user.id).catch(error => logger.warn({ err: error }, 'Reaction cleanup failed'));
    await annotate(item.message, 'Auto-delete cancelled.').catch(error => logger.warn({ err: error }, 'Cancellation status failed'));
  }

  /** @param {string} text */
  async function notify(text) {
    logger.info({ mode: config.mode }, text);
    await report(text).catch(error => logger.error({ err: error }, 'Auto-delete notification failed'));
  }
  /** @param {string} reason */
  async function pause(reason) {
    if (paused) return;
    paused = true;
    await Promise.all([...scheduled.keys()].map(cancel));
    await notify(`Security auto-delete paused: ${reason}. Manual review required.`);
  }
  function prune() {
    for (const [id, item] of activity) if (now() - item.at >= WARNING_WINDOW) activity.delete(id);
    for (const [id, item] of triggers) if (now() - item.at >= WINDOW) triggers.delete(id);
    for (const [id, item] of candidates) if (now() - item.at >= WINDOW) candidates.delete(id);
    while (actions[0] && now() - actions[0].at >= RATE_WINDOW) actions.shift();
  }
  /** @param {import('discord.js').Message} message */
  async function eligible(message) {
    if (message.guildId !== guildId || !message.guild || message.author.bot || message.webhookId
      || message.author.id === ownerUserId || config.exemptUsers.includes(message.author.id)) return false;
    try {
      const member = await message.guild.members.fetch({ user: message.author.id, force: true });
      return !config.exemptRoles.some(id => member.roles.cache.has(id));
    } catch (error) {
      // Departed/banned users have no current roles; other lookup failures fail closed.
      if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return true;
      throw error;
    }
  }
  /** @param {string} userId */
  async function warn(userId) {
    const trigger = triggers.get(userId);
    const recent = activity.get(userId);
    if (!trigger || !recent || Math.abs(trigger.at - recent.at) >= WARNING_WINDOW
      || now() - recent.at >= WARNING_WINDOW || now() - trigger.at >= WARNING_WINDOW
      || (recent.warnedAt !== undefined && now() - recent.warnedAt < WARNING_WINDOW)) return;
    if (!await eligible(recent.message) || paused) return;
    recent.warnedAt = now();
    const current = activity.get(userId);
    if (current) current.warnedAt = recent.warnedAt;
    await alert(recent.message, `Honeypot activity: ${trigger.messageId} within 60 seconds.`);
    if (!candidates.has(recent.message.id) && candidates.size < 200) {
      candidates.set(recent.message.id, { message: recent.message, at: recent.at, done: false });
    }
    await enqueue(() => correlate(userId));
  }
  /** @param {string} userId */
  function enqueueWarning(userId) {
    const existing = pendingWarnings.get(userId);
    if (existing) return existing;
    const recent = activity.get(userId);
    if (paused || !recent || !triggers.has(userId) || pendingWarnings.size >= 20
      || (recent.warnedAt !== undefined && now() - recent.warnedAt < WARNING_WINDOW)) return Promise.resolve();
    const work = warningChain.then(async () => { if (!paused) await warn(userId); }).catch(error => {
      logger.error({ err: error }, 'Security activity alert failed');
    }).finally(() => { pendingWarnings.delete(userId); });
    pendingWarnings.set(userId, work);
    warningChain = work;
    return work;
  }
  /** @param {string} userId */
  async function correlate(userId) {
    prune();
    const trigger = triggers.get(userId);
    if (!trigger || paused) return;
    for (const candidate of candidates.values()) {
      const { message } = candidate;
      if (candidate.done || scheduled.has(message.id) || message.author.id !== userId || Math.abs(candidate.at - trigger.at) >= WINDOW) continue;
      candidate.done = true;
      try {
        await alert(message, `Honeypot triggered: ${trigger.messageId}`);
        const source = await message.channel.messages.fetch({ message: message.id, force: true, cache: false }).catch(error => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 10008) return null;
          throw error;
        });
        if (!source) {
          await onDelete({ guildId, channelId: message.channelId, id: message.id });
          await annotate(message, 'Already deleted.');
          continue;
        }
        if (!source.inGuild() || source.author.id !== userId || source.guildId !== guildId || !await eligible(source)) {
          await annotate(message, 'Auto-delete skipped: author/context mismatch or exemption.');
          continue;
        }
        const bot = await source.guild.members.fetchMe({ force: true });
        if (!source.channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages])) {
          await annotate(message, 'Auto-delete skipped: missing source permissions.');
          continue;
        }
        prune();
        if (paused || !triggers.has(userId) || now() - candidate.at >= WINDOW) continue;
        if (actions.length >= config.guildLimit || actions.filter(item => item.userId === userId).length >= config.userLimit) {
          await pause('safety limit reached'); return;
        }
        actions.push({ at: now(), userId });
        if (config.mode === 'dry-run') {
          await annotate(message, `Dry-run: would delete — honeypot triggered (${trigger.messageId}).`);
          continue;
        }
        if (scheduled.size >= 200) { await pause('scheduled action capacity reached'); return; }
        const item = { cancelled: false, message: source, timer: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined),
          reaction: /** @type {import('discord.js').MessageReaction | undefined} */ (undefined) };
        scheduled.set(message.id, item);
        await annotate(message, `Auto-delete pending — honeypot triggered (${trigger.messageId}). Deleting in 15 seconds.`);
        const emoji = source.guild.emojis.cache.find(value => value.name === 'banme');
        if (emoji) item.reaction = await source.react(emoji).catch(error => { logger.warn({ err: error }, 'Pending marker unavailable'); return undefined; });
        if (item.cancelled || paused) {
          await item.reaction?.users.remove(source.client.user.id).catch(error => logger.warn({ err: error }, 'Reaction cleanup failed'));
          continue;
        }
        item.timer = setTimeout(() => {
          void enqueue(async () => {
            if (item.cancelled || paused) return;
            try {
              const fresh = await message.channel.messages.fetch({ message: message.id, force: true, cache: false }).catch(error => {
                if (error && typeof error === 'object' && 'code' in error && error.code === 10008) return null;
                throw error;
              });
              if (!fresh) {
                item.cancelled = true;
                await onDelete({ guildId, channelId: message.channelId, id: message.id }).catch(updateError => logger.warn({ err: updateError }, 'Already deleted; controls update failed'));
                await annotate(message, 'Already deleted.').catch(updateError => logger.warn({ err: updateError }, 'Already deleted; status update failed'));
                return;
              }
              if (!fresh.inGuild() || fresh.guildId !== guildId || !await eligible(fresh)) throw new Error('Source context or exemption changed');
              const currentBot = await fresh.guild.members.fetchMe({ force: true });
              if (!fresh.channel.permissionsFor(currentBot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages])) throw new Error('Source permissions changed');
              await annotate(message, 'Auto-deleting — honeypot triggered.');
              if (item.cancelled || paused) return;
              await deleteAlertSource(fresh, { messageId: message.id, channelId: message.channelId, userId });
              item.cancelled = true;
              await onDelete({ guildId, channelId: message.channelId, id: message.id }).catch(error => logger.error({ err: error }, 'Deleted source; controls update failed'));
              await annotate(message, `Auto-deleted — honeypot triggered (${trigger.messageId}).`).catch(error => logger.error({ err: error }, 'Deleted source; status update failed'));
            } catch (error) {
              await cancel(message.id);
              await annotate(message, 'Auto-delete failed; manual review required.');
              logger.error({ err: error }, 'Scheduled deletion failed');
            }
          });
        }, 15_000);
        item.timer.unref();
      } catch (error) {
        logger.error({ err: error, messageId: message.id }, 'Security auto-delete failed');
        await annotate(message, 'Auto-delete failed; manual review required.');
      }
    }
  }
  /** @param {() => Promise<void>} work */
  function enqueue(work) {
    if (paused) return Promise.resolve();
    if (pending >= 20) return pause('queue capacity reached');
    pending++;
    chain = chain.then(async () => { if (!paused) { prune(); await work(); } }).catch(async error => {
      logger.error({ err: error }, 'Security correlation failed');
      await notify('Security correlation failed; no automatic action taken. Manual review required.');
    }).finally(() => { pending--; });
    return chain;
  }
  return {
    cancel,
    suspend: () => pause('suspended by moderator'),
    /** @param {import('discord.js').Message} message */
    observe(message) {
      const at = now();
      if (paused || message.guildId !== guildId || !message.guild || message.author.bot || message.webhookId
        || message.author.id === ownerUserId || config.exemptUsers.includes(message.author.id)) return Promise.resolve();
      if (message.channelId !== config.channelId) {
        prune();
        activity.delete(message.author.id);
        activity.set(message.author.id, { message, at });
        // Bounded recent observations; an alert and policy checks precede scheduling.
        if (activity.size > 200) activity.delete(activity.keys().next().value ?? '');
        if (!triggers.has(message.author.id)) return Promise.resolve();
        return enqueueWarning(message.author.id);
      }
      return enqueue(async () => {
        if (!await eligible(message)) return;
        if (!triggers.has(message.author.id) && triggers.size >= 200) { await pause('trigger capacity reached'); return; }
        triggers.set(message.author.id, { at, messageId: message.id });
        // Warning failures are handled by their queue; shutdown drains it separately.
        void enqueueWarning(message.author.id);
        await correlate(message.author.id);
      });
    },
    /** @param {{message: import('discord.js').Message, observedAt: number, reason: string, image: Buffer | undefined}} evidence */
    flag({ message, observedAt: at, image }) {
      return enqueue(async () => {
        if (now() - at >= WINDOW) return;
        if (message.channelId === config.channelId || candidates.has(message.id) || !await eligible(message)) return;
        if (!image) { await notify(`Security auto-delete skipped ${message.url}: evidence unavailable.`); return; }
        if (candidates.size >= 200) { await pause('candidate capacity reached'); return; }
        candidates.set(message.id, { message, at, done: false });
        await correlate(message.author.id);
      });
    },
    async close() {
      paused = true;
      await Promise.all([...scheduled.keys()].map(cancel));
      await chain;
      await warningChain;
      triggers.clear(); candidates.clear(); activity.clear();
    },
  };
}