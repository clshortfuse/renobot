import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits, escapeMarkdown } from 'discord.js';

/** @typedef {{channelId: string, messageId: string, userId: string}} Target */
/** @param {unknown} error @param {number} code */
function hasCode(error, code) { return error !== null && typeof error === 'object' && 'code' in error && error.code === code; }

/** @param {import('discord.js').Guild} guild @param {string} userId */
async function banState(guild, userId) {
  try {
    await guild.bans.fetch({ user: userId, force: true, cache: false });
    return 'Already banned';
  } catch (error) {
    if (hasCode(error, 10026)) return 'Not banned';
    if (hasCode(error, 50013) || hasCode(error, 50001)) return 'Unknown — bot needs Ban Members permission';
    throw error;
  }
}

/** @param {Target} target @param {string} state @param {boolean} [deleted] */
function controls(target, state, deleted = false) {
  const suffix = `${target.channelId}:${target.messageId}:${target.userId}`;
  /** @type {ActionRowBuilder<ButtonBuilder>} */
  const row = new ActionRowBuilder();
  return row.addComponents(
    new ButtonBuilder().setLabel('Delete message').setStyle(ButtonStyle.Danger)
      .setCustomId(`scam:delete:${suffix}`).setDisabled(deleted),
    new ButtonBuilder().setLabel('Ban user').setStyle(ButtonStyle.Danger)
      .setCustomId(`scam:ban:${suffix}`).setDisabled(state !== 'Not banned'),
  );
}

/** @typedef {{executorId?: string | undefined, reason?: string | undefined}} BanDetails */
/** @param {{target: Target, guildId: string, state: string, reason: string, imageUrl?: string | undefined, deleted?: boolean, forwarded?: boolean, banDetails?: BanDetails | undefined}} options
 * @returns {import('discord.js').APIContainerComponent} */
export function securityCard({ target, guildId, state, reason, imageUrl, deleted = false, forwarded = false, banDetails }) {
  const status = state === 'Already banned'
    ? `Banned${banDetails?.executorId ? ` by <@${banDetails.executorId}>` : ''}${banDetails?.reason ? `\n-# ${escapeMarkdown(banDetails.reason.replace(/[\r\n]/gu, ' ')).replaceAll('@', '@\u200b')}` : ''}`
    : state.startsWith('Unknown') ? 'Ban status unknown' : state;
  return { type: ComponentType.Container, accent_color: 0xe59b38, components: [
    { type: ComponentType.TextDisplay, id: 3, content: `**${reason}**` },
    { type: ComponentType.TextDisplay, id: 1, content: `<@${target.userId}> · ${status}` },
    ...(imageUrl ? [/** @type {import('discord.js').APIMediaGalleryComponent} */ ({ type: ComponentType.MediaGallery,
      items: [{ media: { url: imageUrl } }] })] : []),
    ...(imageUrl || forwarded ? [] : [/** @type {import('discord.js').APITextDisplayComponent} */ ({ type: ComponentType.TextDisplay, id: 4, content: 'Image unavailable' })]),
    { type: ComponentType.TextDisplay, id: 2, content: `https://discord.com/channels/${guildId}/${target.channelId}/${target.messageId}${deleted ? ' (deleted)' : ''}` },
    controls(target, state, deleted).toJSON(),
  ] };
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('./commands/command.js').CommandContext} context
 */
export function createScamAlerts(client, context) {
  /** @type {Map<string, {alert: import('discord.js').Message, target: Target}>} */
  const recent = new Map();
  /** @type {Map<string, {actorId: string, action: string, target: Target, alert: import('discord.js').Message, expires: number}>} */
  const confirmations = new Map();
  /** @type {Set<string>} */
  const deletedMessages = new Set();
  /** @type {Map<string, {state: string, event: object | undefined, auditAfter?: number | undefined, details?: BanDetails | undefined}>} */
  const banStates = new Map();
  /** @type {Map<string, Promise<void>>} */
  const edits = new Map();

  /** @param {string} userId @param {string} state @param {boolean} [event] */
  function rememberBanState(userId, state, event = false) {
    const previous = banStates.get(userId);
    banStates.set(userId, { state, event: event ? {} : previous?.event,
      auditAfter: state === 'Not banned' ? Date.now() : previous?.auditAfter,
      details: !event && state === 'Already banned' && previous?.state === state ? previous.details : undefined });
    if (banStates.size > 1000) banStates.delete(/** @type {string} */ (banStates.keys().next().value));
  }

  /** @param {import('discord.js').Guild} guild @param {string} userId */
  async function readBanState(guild, userId) {
    const before = banStates.get(userId);
    const state = await banState(guild, userId);
    // An event received during the request is newer than its potentially stale response.
    if (banStates.get(userId) === before) rememberBanState(userId, state);
    return banStates.get(userId)?.state ?? state;
  }

  /** @param {import('discord.js').Guild} guild @param {string} userId */
  async function readBanDetails(guild, userId) {
    const snapshot = banStates.get(userId);
    if (snapshot?.state !== 'Already banned') return;
    try {
      const ban = await guild.bans.fetch({ user: userId, force: true, cache: false });
      /** @type {BanDetails} */
      const details = { reason: ban.reason ?? undefined };
      try {
        // Include removals so a previous ban is not attributed across a visible unban.
        const audit = await guild.fetchAuditLogs({ limit: 100 });
        const entry = audit.entries.find(item => item.targetId === userId
          && (item.action === AuditLogEvent.MemberBanAdd || item.action === AuditLogEvent.MemberBanRemove));
        if (entry?.action === AuditLogEvent.MemberBanAdd && entry.reason === ban.reason
          && (snapshot.auditAfter === undefined || entry.createdTimestamp > snapshot.auditAfter)) {
          details.executorId = entry.executorId ?? undefined;
        }
      } catch (error) {
        context.logger.warn({ err: error, userId }, 'Security ban attribution unavailable');
      }
      if (banStates.get(userId) === snapshot) snapshot.details = details;
    } catch (error) {
      context.logger.warn({ err: error, userId }, 'Security ban reason unavailable');
    }
  }

  /** @param {import('discord.js').Message} alert @param {Target} target @param {string | undefined} state @param {boolean} [deleted] */
  function update(alert, target, state, deleted = false) {
    const task = (edits.get(alert.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await renderUpdate(recent.get(alert.id)?.alert ?? alert, target, banStates.get(target.userId)?.state ?? state,
        deleted || deletedMessages.has(target.messageId));
    });
    edits.set(alert.id, task);
    return task.finally(() => { if (edits.get(alert.id) === task) edits.delete(alert.id); });
  }

  /** @param {import('discord.js').Message} alert @param {Target} target @param {string | undefined} state @param {boolean} deleted */
  async function renderUpdate(alert, target, state, deleted) {
    const original = alert.components[0]?.toJSON();
    if (original?.type !== ComponentType.Container) throw new Error('Security alert is missing its card');
    const row = original.components.find(item => item.type === ComponentType.ActionRow);
    if (row?.type !== ComponentType.ActionRow) throw new Error('Security alert is missing its controls');
    const next = { ...original, components: original.components.map(item => item !== row ? item : {
      ...row, components: row.components.map(button => {
        if (button.type !== ComponentType.Button || !('custom_id' in button)) return button;
        if (button.custom_id.startsWith('scam:delete:')) return { ...button, disabled: deleted || button.disabled };
        if (button.custom_id.startsWith('scam:ban:') && state !== undefined) return { ...button, disabled: state !== 'Not banned' };
        return button;
      }),
    }) };
    const edited = await alert.edit({ components: [next], allowedMentions: { parse: [] } });
    if (recent.has(alert.id)) recent.set(alert.id, { alert: edited, target });
  }

  /** @param {import('discord.js').ButtonInteraction} interaction @param {Target} target @param {string} action */
  async function authorize(interaction, target, action) {
    const guild = interaction.guild;
    if (!guild) throw new Error('Server unavailable');
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    const bot = await guild.members.fetchMe({ force: true });
    const security = await guild.channels.fetch(interaction.channelId);
    if (!security || !actor.permissionsIn(security).has(PermissionFlagsBits.ViewChannel)) throw new Error('You cannot view the security channel');
    const channel = await guild.channels.fetch(target.channelId);
    if (!channel?.isTextBased()) throw new Error('Source channel unavailable');
    if (!actor.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) throw new Error('You cannot view the source channel');
    if (action === 'delete') {
      for (const member of [actor, bot]) {
        if (!member.permissionsIn(channel).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages])) {
          throw new Error('You and the bot need View Channel, Read Message History, and Manage Messages in the source channel');
        }
      }
    } else if (action === 'ban') {
      if (!actor.permissions.has(PermissionFlagsBits.BanMembers) || !bot.permissions.has(PermissionFlagsBits.BanMembers)) {
        throw new Error('You and the bot need Ban Members permission');
      }
      if ([guild.ownerId, actor.id, bot.id].includes(target.userId)) throw new Error('This user cannot be banned');
      const member = await guild.members.fetch({ user: target.userId, force: true }).catch((error) => {
        if (hasCode(error, 10007)) return null;
        throw error;
      });
      if (member && (!member.bannable || (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(member.roles.highest) <= 0))) {
        throw new Error('The target must be below both your role and the bot’s role');
      }
    } else if (!actor.permissions.has(PermissionFlagsBits.BanMembers)
      && !actor.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages)) {
      throw new Error('Moderator permission required');
    }
    return { guild, channel };
  }

  return {
    /** @param {{message: import('discord.js').Message, reason: string, image: Buffer | undefined}} evidence */
    async send({ message, reason, image }) {
      if (!context.securityChannelId || !context.guildId) throw new Error('Security alerts are not configured');
      const channel = await client.channels.fetch(context.securityChannelId);
      if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== context.guildId || !message.guild) {
        throw new Error('Security destination is not a sendable channel in the configured guild');
      }
      const state = await readBanState(message.guild, message.author.id).catch((error) => {
        context.logger.warn({ err: error }, 'Security ban lookup failed');
        return 'Unknown — lookup failed';
      });
      const target = { channelId: message.channelId, messageId: message.id, userId: message.author.id };
      let forwarded = false;
      if (!deletedMessages.has(message.id)) {
        try {
          await message.forward(channel.id);
          forwarded = true;
        } catch (error) {
          if (hasCode(error, 10008)) {
            deletedMessages.add(message.id);
            if (deletedMessages.size > 1000) deletedMessages.delete(/** @type {string} */ (deletedMessages.values().next().value));
          }
          context.logger.warn({ err: error, messageId: message.id }, 'Forward unavailable; using cached image evidence');
        }
      }
      await readBanDetails(message.guild, target.userId);
      const displayedState = banStates.get(target.userId)?.state ?? state;
      const alert = await channel.send({ flags: MessageFlags.IsComponentsV2,
        components: [securityCard({ target, guildId: context.guildId, state: displayedState, reason,
          banDetails: banStates.get(target.userId)?.details,
          deleted: deletedMessages.has(target.messageId),
          forwarded, imageUrl: !forwarded && image ? 'attachment://evidence.png' : undefined })],
        files: !forwarded && image ? [{ attachment: image, name: 'evidence.png' }] : [], allowedMentions: { parse: [] } });
      recent.set(alert.id, { alert, target });
      if (recent.size > 200) recent.delete(/** @type {string} */ (recent.keys().next().value));
      // A honeypot may ban the author while Discord is accepting the evidence uploads.
      try {
        const latest = await readBanState(message.guild, message.author.id);
        await update(alert, target, latest);
      } catch (error) { context.logger.warn({ err: error, alertId: alert.id }, 'Security post-delivery status check failed'); }
    },
    /** @param {import('discord.js').GuildBan} ban @param {boolean} [banned] */
    async onBan(ban, banned = true) {
      if (ban.guild.id !== context.guildId) return;
      const state = banned ? 'Already banned' : 'Not banned';
      rememberBanState(ban.user.id, state, true);
      for (const { alert, target } of recent.values()) {
        if (target.userId === ban.user.id) {
          await update(alert, target, state).catch((error) => {
            context.logger.warn({ err: error, alertId: alert.id }, 'Security alert ban update failed');
          });
        }
      }
    },
    /** @param {{guildId: string | null, channelId: string, id: string}} message */
    async onDelete(message) {
      if (message.guildId !== context.guildId) return;
      if (message.channelId === context.securityChannelId) { recent.delete(message.id); return; }
      deletedMessages.add(message.id);
      if (deletedMessages.size > 1000) deletedMessages.delete(/** @type {string} */ (deletedMessages.values().next().value));
      for (const { alert, target } of recent.values()) {
        if (target.messageId === message.id && target.channelId === message.channelId) {
          await update(alert, target, undefined, true).catch((error) => {
            context.logger.warn({ err: error, alertId: alert.id }, 'Security alert deletion update failed');
          });
        }
      }
    },
    /** @param {import('discord.js').BaseInteraction} base */
    async handle(base) {
      if (!base.isButton() || !base.customId.startsWith('scam:')) return false;
      const interaction = base;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (!context.guildId || interaction.guildId !== context.guildId || interaction.channelId !== context.securityChannelId
          || interaction.message.author.id !== client.user?.id) throw new Error('Invalid security alert context');
        const [, action, ...parts] = interaction.customId.split(':');
        if (action === 'confirm') {
          const token = parts[0] ?? '';
          const pending = confirmations.get(token);
          if (!pending || pending.actorId !== interaction.user.id || pending.expires < Date.now()) throw new Error('Confirmation expired or belongs to another moderator');
          confirmations.delete(token);
          const { target, action: operation, alert } = pending;
          const { guild, channel } = await authorize(interaction, target, operation);
          const state = await readBanState(guild, target.userId);
          let result;
          if (operation === 'ban') {
            if (state.startsWith('Unknown')) throw new Error(state);
            if (state === 'Already banned') result = 'User was already banned; no additional action taken.';
            else {
              const before = banStates.get(target.userId)?.event;
              await guild.members.ban(target.userId, { deleteMessageSeconds: 0,
                reason: `Scam alert ${alert.id}; confirmed by ${interaction.user.id}` });
              if (banStates.get(target.userId)?.event === before) rememberBanState(target.userId, 'Already banned');
              result = 'User banned. No other messages were bulk-deleted.';
            }
          } else {
            try {
              const source = await channel.messages.fetch(target.messageId);
              if (source.author.id !== target.userId) throw new Error('Source author does not match the alert');
              await source.delete();
              result = 'Message deleted.';
            } catch (error) {
              if (!hasCode(error, 10008)) throw error;
              result = 'Message was already deleted; no additional action taken.';
            }
          }
          context.logger.info({ actorId: interaction.user.id, ...target, action: operation }, 'Security action confirmed');
          try { await update(alert, target, operation === 'ban' ? 'Already banned' : state, operation === 'delete'); }
          catch (error) {
            context.logger.warn({ err: error, alertId: alert.id }, 'Moderation succeeded but security alert update failed');
            result += ' Alert status could not be updated.';
          }
          await interaction.editReply(result);
          return true;
        }
        const [channelId, messageId, userId] = parts;
        if (!['delete', 'ban'].includes(action ?? '') || parts.length !== 3
          || !channelId || !messageId || !userId || !parts.every((part) => /^\d{17,20}$/u.test(part))) throw new Error('Invalid security action');
        const target = { channelId, messageId, userId };
        const { guild } = await authorize(interaction, target, /** @type {string} */ (action));
        const state = await readBanState(guild, userId);
        if (action === 'ban' && state === 'Already banned') {
          await update(interaction.message, target, state);
          await interaction.editReply('Already banned.');
          return true;
        }
        if (action === 'ban' && state.startsWith('Unknown')) throw new Error(state);
        for (const [token, pending] of confirmations) if (pending.expires < Date.now()) confirmations.delete(token);
        if (confirmations.size >= 1000) throw new Error('Too many pending confirmations; try again later');
        const token = randomUUID();
        confirmations.set(token, { actorId: interaction.user.id, action: /** @type {string} */ (action), target,
          alert: interaction.message, expires: Date.now() + 60_000 });
        /** @type {ActionRowBuilder<ButtonBuilder>} */
        const row = new ActionRowBuilder();
        await interaction.editReply({ content: `Confirm ${action === 'ban' ? `ban of user ${userId}` : `deletion of message ${messageId}`}? Expires in 60 seconds.`,
          components: [row.addComponents(new ButtonBuilder().setLabel(action === 'ban' ? 'Confirm ban' : 'Confirm deletion')
            .setStyle(ButtonStyle.Danger).setCustomId(`scam:confirm:${token}`))] });
      } catch (error) {
        context.logger.warn({ err: error, actorId: interaction.user.id }, 'Security action failed');
        await interaction.editReply({ content: `Action not completed: ${error instanceof Error ? error.message : 'Discord request failed'}`, components: [] });
      }
      return true;
    },
  };
}