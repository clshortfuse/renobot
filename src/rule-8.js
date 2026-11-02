import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits } from 'discord.js';

/** @type {Set<string>} */
const active = new Set();
/** @type {Map<string, number>} */
const reported = new Map();
/** @type {Map<string, {tokens: number, updatedAt: number}>} */
const reportBursts = new Map();

/** @param {import('discord.js').GuildMember} actor @param {import('discord.js').GuildBasedChannel} channel */
function isModerator(actor, channel) {
  return actor.permissions.has(PermissionFlagsBits.ModerateMembers)
    && actor.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages);
}

/** Reserve capacity synchronously so concurrent reports cannot bypass the burst guard.
 * @param {string} key @returns {number} Seconds until another report may be submitted. */
function reserveReport(key) {
  const now = Date.now();
  // After ten seconds any bucket is full again; expired entries need not be retained.
  for (const [id, bucket] of reportBursts) if (now - bucket.updatedAt >= 10_000) reportBursts.delete(id);
  const previous = reportBursts.get(key);
  if (!previous && reportBursts.size >= 10_000) return 2;
  const tokens = previous ? Math.min(5, previous.tokens + Math.max(0, now - previous.updatedAt) / 2000) : 5;
  if (tokens < 1) return Math.ceil((1 - tokens) * 2);
  reportBursts.set(key, { tokens: tokens - 1, updatedAt: now });
  return 0;
}

/** @param {import('discord.js').Message} message */
function controls(message) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Accept: delete + 24h timeout')
    .setStyle(ButtonStyle.Danger).setCustomId(`rule8:accept:${message.channelId}:${message.id}:${message.author.id}`));
}

/** @param {import('discord.js').Message} message @param {import('discord.js').GuildMember} actor
 * @param {import('discord.js').GuildBasedChannel} channel */
async function authorize(message, actor, channel) {
  const guild = actor.guild;
  if (!isModerator(actor, channel)
    || !actor.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('You need View Channel, Moderate Members and Manage Messages in the source channel.');
  }
  const target = await guild.members.fetch({ user: message.author.id, force: true });
  await guild.members.fetchMe({ force: true });
  if (message.author.bot || target.id === actor.id || !target.moderatable || !message.deletable
    || (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)) {
    throw new Error('Cannot moderate this member or delete this message. Check role hierarchy and bot permissions.');
  }
  return target;
}

/** @param {import('discord.js').Message} message @param {import('discord.js').GuildMember} target
 * @param {string} actorId @param {import('./commands/command.js').CommandContext} context */
async function applyRule8(message, target, actorId, context) {
  const details = { reason: 'Rule 8', actorId, targetId: target.id,
    guildId: target.guild.id, channelId: message.channelId, messageId: message.id };
  try {
    if ((target.communicationDisabledUntilTimestamp ?? 0) < Date.now() + 86_400_000) await target.timeout(86_400_000, 'Rule 8');
  } catch (error) {
    context.logger.error({ ...details, err: error }, 'Rule 8 timeout failed');
    return { content: 'Rule 8 timeout failed. The message was not deleted.', retry: true };
  }
  try { await message.delete(); }
  catch (error) {
    context.logger.error({ ...details, err: error }, 'Rule 8 deletion failed after timeout');
    return { content: 'Rule 8: the member is timed out for at least 24 hours, but message deletion failed. Delete the message manually if it still exists.', retry: false };
  }
  context.logger.info(details, 'Rule 8 message deleted and member timed out');
  return { content: 'Message deleted. Author timed out for 24 hours (or an existing longer timeout retained). Reason: Rule 8.', retry: false };
}

/** @param {import('discord.js').Message} alert @param {import('discord.js').Message} source
 * @param {{content: string, retry: boolean}} result @param {string} actorId
 * @param {import('./commands/command.js').CommandContext} context */
async function finish(alert, source, result, actorId, context) {
  try {
    await alert.edit({ content: `${alert.content}\nModerator: <@${actorId}>\n${result.content}`,
      components: result.retry ? [controls(source).toJSON()] : [], allowedMentions: { parse: [] } });
  } catch (error) {
    context.logger.error({ err: error, alertId: alert.id }, 'Rule 8 security status update failed');
    result.content += ' The security record could not be updated; check bot logs.';
  }
}

/** @param {import('discord.js').BaseInteraction} interaction
 * @param {import('./commands/command.js').CommandContext} context */
export async function moderateRule8(interaction, context) {
  if (!interaction.isMessageContextMenuCommand()) return;
  if (!context.guildId || interaction.guildId !== context.guildId || !interaction.guild) {
    await interaction.reply({ content: 'This command is restricted to the configured server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.bot) {
    await interaction.reply({ content: 'Bot accounts cannot submit Rule 8 reports.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = interaction.targetMessage;
  const key = `${interaction.guildId}:${message.id}`;
  if (active.has(key)) { await interaction.editReply('This message is already being processed.'); return; }
  active.add(key);
  try {
    if (!context.securityChannelId) throw new Error('The security channel is not configured.');
    const guild = interaction.guild;
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    const channel = await guild.channels.fetch(message.channelId);
    if (!channel?.isTextBased()) throw new Error('Source channel unavailable.');
    if (!actor.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) throw new Error('You cannot view the source channel.');
    const moderator = isModerator(actor, channel);
    if (!moderator && (reported.get(key) ?? 0) > Date.now()) {
      await interaction.editReply('This message was recently reported to security.'); return;
    }
    const target = moderator ? await authorize(message, actor, channel) : undefined;
    const security = await guild.channels.fetch(context.securityChannelId);
    if (!security?.isSendable() || security.guildId !== guild.id) throw new Error('Security destination is unavailable.');
    if (!moderator) {
      const waitSeconds = reserveReport(`${guild.id}:${actor.id}`);
      if (waitSeconds) {
        await interaction.editReply(`Reports are arriving too quickly. Please wait ${waitSeconds} seconds and try again.`);
        return;
      }
    }
    // Preserve evidence before a moderator deletes the source; forwarding failure must not hide the report.
    try { await message.forward(security.id); }
    catch (error) { context.logger.warn({ err: error, messageId: message.id }, 'Rule 8 evidence forwarding unavailable'); }
    const alert = await security.send({ content: `**Report: Rule 8**\nReported by <@${actor.id}> · Author <@${message.author.id}>\nhttps://discord.com/channels/${guild.id}/${message.channelId}/${message.id}\n${moderator ? 'Moderator action in progress.' : 'Pending moderator approval.'}`,
      components: moderator ? [] : [controls(message).toJSON()], allowedMentions: { parse: [] } });
    if (target) {
      const result = await applyRule8(message, target, actor.id, context);
      await finish(alert, message, result, actor.id, context);
      await interaction.editReply(result.content);
    } else {
      reported.set(key, Date.now() + 300_000);
      if (reported.size > 1000) reported.delete(/** @type {string} */ (reported.keys().next().value));
      await interaction.editReply('Rule 8 report sent to security for moderator approval. No moderation action was taken.');
    }
  } finally { active.delete(key); }
}

/** @param {import('discord.js').BaseInteraction} base
 * @param {import('./commands/command.js').CommandContext} context */
export async function handleRule8Button(base, context) {
  if (!base.isButton?.() || !base.customId.startsWith('rule8:')) return false;
  await base.deferReply({ flags: MessageFlags.Ephemeral });
  let key;
  try {
    if (!context.guildId || base.guildId !== context.guildId || !base.guild
      || base.channelId !== context.securityChannelId || base.message.author.id !== base.client.user.id) {
      throw new Error('Invalid security report context.');
    }
    const match = /^rule8:accept:(\d{17,20}):(\d{17,20}):(\d{17,20})$/u.exec(base.customId);
    if (!match) throw new Error('Invalid report target.');
    const channelId = /** @type {string} */ (match[1]);
    const messageId = /** @type {string} */ (match[2]);
    const userId = /** @type {string} */ (match[3]);
    const targetKey = `${base.guildId}:${messageId}`;
    if (active.has(targetKey)) throw new Error('This message is already being processed.');
    active.add(targetKey); key = targetKey;
    const actor = await base.guild.members.fetch({ user: base.user.id, force: true });
    const security = await base.guild.channels.fetch(base.channelId);
    const channel = await base.guild.channels.fetch(channelId);
    if (!security || !channel?.isTextBased()) throw new Error('Security or source channel unavailable.');
    if (!actor.permissionsIn(security).has(PermissionFlagsBits.ViewChannel)
      || !actor.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel) || !isModerator(actor, channel)) {
      throw new Error('Only moderators with access to security and the source channel can accept reports.');
    }
    const alert = await base.message.fetch(true);
    if (!alert.components.some(row => row.type === ComponentType.ActionRow && row.components.some(button =>
      button.type === ComponentType.Button && button.customId === base.customId && !button.disabled))) {
      throw new Error('This report has already been handled.');
    }
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    if (message.author.id !== userId) throw new Error('Source author does not match the report.');
    const target = await authorize(message, actor, channel);
    // Consume the approval on Discord before acting, so stale clicks/restarts cannot replay it.
    await alert.edit({ components: [], allowedMentions: { parse: [] } });
    const result = await applyRule8(message, target, actor.id, context);
    await finish(alert, message, result, actor.id, context);
    await base.editReply(result.content);
  } catch (error) {
    context.logger.warn({ err: error, interactionId: base.id }, 'Rule 8 approval failed');
    await base.editReply('Rule 8 approval failed. Check moderator permissions, role hierarchy, and whether the report and source message are still available.');
  } finally { if (key) active.delete(key); }
  return true;
}