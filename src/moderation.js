import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { moderationRules } from './moderation-rules.js';

/** @typedef {(typeof moderationRules)[number]} ModerationRule */
/** @typedef {{actorId: string, guildId: string, channelId: string, messageId: string, authorId: string, expires: number}} PendingSelection */
/** @type {Map<string, PendingSelection>} */
const selections = new Map();

/** @type {Set<string>} */
const active = new Set();
/** @typedef {{alert: import('discord.js').Message, reporters: Map<string, Set<string>>, rule: ModerationRule, completed: boolean}} Report */
/** @type {Map<string, Report>} */
const reported = new Map();
/** @type {Map<string, Promise<void>>} */
const deliveries = new Map();
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

/** @param {import('discord.js').Message} message @param {ModerationRule} rule */
function controls(message, rule) {
  /** @type {ActionRowBuilder<ButtonBuilder>} */
  const row = new ActionRowBuilder();
  return row.addComponents(new ButtonBuilder().setLabel('Accept: delete + 24h timeout')
    .setStyle(ButtonStyle.Danger).setCustomId(`rules:accept:${rule.id}:${message.channelId}:${message.id}:${message.author.id}`));
}

/** @param {Map<string, Set<string>>} reporters */
function reporterText(reporters) {
  const lines = [];
  let length = 0;
  for (const [id, rules] of reporters) {
    const line = `<@${id}> — Rule ${[...rules].join(', ')}`;
    if (length + line.length > 1100) break;
    lines.push(line);
    length += line.length + 1;
  }
  const remaining = reporters.size - lines.length;
  return `**Reported by (${reporters.size})**\n${lines.join('\n')}${remaining ? `\n…and ${remaining} more reporters.` : ''}`;
}

/** @param {import('discord.js').Message} source @param {string} guildId
 * @param {ModerationRule} rule @param {Map<string, Set<string>>} reporters @param {boolean} moderator
 * @returns {import('discord.js').APIContainerComponent} */
function reportCard(source, guildId, rule, reporters, moderator) {
  const preview = escapeMarkdown((source.content ?? '').slice(0, 700)).replaceAll('@', '@\u200b').slice(0, 1000);
  const image = source.attachments?.find(attachment => attachment.contentType?.startsWith('image/'));
  return { type: ComponentType.Container, accent_color: 0xe59b38, components: [
    { type: ComponentType.TextDisplay, id: 1, content: `**Report: ${rule.label}**\n${rule.text}` },
    { type: ComponentType.TextDisplay, id: 2, content: `Author: <@${source.author.id}>\nhttps://discord.com/channels/${guildId}/${source.channelId}/${source.id}` },
    { type: ComponentType.TextDisplay, id: 3, content: `**Message preview**\n${preview || '(No text available)'}` },
    ...(image ? [/** @type {import('discord.js').APIMediaGalleryComponent} */ ({ type: ComponentType.MediaGallery,
      items: [{ media: { url: image.url }, spoiler: image.spoiler }] })] : []),
    { type: ComponentType.TextDisplay, id: 4, content: reporterText(reporters) },
    { type: ComponentType.TextDisplay, id: 5, content: moderator ? 'Moderator action in progress.' : 'Pending moderator approval.' },
    ...(moderator ? [] : [controls(source, rule).toJSON()]),
  ] };
}

/** @param {import('discord.js').Message} alert */
function readCard(alert) {
  const card = alert.components[0]?.toJSON();
  if (card?.type !== ComponentType.Container) throw new Error('Security report card unavailable.');
  return card;
}

/** @param {import('discord.js').Message} alert @param {string} status
 * @param {import('discord.js').APIActionRowComponent<import('discord.js').APIButtonComponent> | undefined} row */
async function updateStatus(alert, status, row) {
  const card = readCard(alert);
  return alert.edit({ components: [{ ...card, components: [
    ...card.components.filter(item => item.type !== ComponentType.ActionRow
      && !(item.type === ComponentType.TextDisplay && item.id === 5)),
    { type: ComponentType.TextDisplay, id: 5, content: status }, ...(row ? [row] : []),
  ] }], allowedMentions: { parse: [] } });
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
 * @param {string} actorId @param {import('./commands/command.js').CommandContext} context @param {ModerationRule} rule */
async function applyRuleModeration(message, target, actorId, context, rule) {
  const details = { reason: rule.label, actorId, targetId: target.id,
    guildId: target.guild.id, channelId: message.channelId, messageId: message.id };
  try {
    if ((target.communicationDisabledUntilTimestamp ?? 0) < Date.now() + 86_400_000) await target.timeout(86_400_000, rule.label);
  } catch (error) {
    context.logger.error({ ...details, err: error }, 'Rule timeout failed');
    return { content: `${rule.label} timeout failed. The message was not deleted.`, retry: true };
  }
  try { await message.delete(); }
  catch (error) {
    context.logger.error({ ...details, err: error }, 'Rule deletion failed after timeout');
    return { content: `${rule.label}: the member is timed out for at least 24 hours, but message deletion failed. Delete the message manually if it still exists.`, retry: false };
  }
  context.logger.info(details, 'Rule message deleted and member timed out');
  return { content: `Message deleted. Author timed out for 24 hours (or an existing longer timeout retained). Reason: ${rule.label}.`, retry: false };
}

/** @param {import('discord.js').Message} alert @param {import('discord.js').Message} source
 * @param {{content: string, retry: boolean}} result @param {string} actorId
 * @param {import('./commands/command.js').CommandContext} context @param {ModerationRule} rule */
async function finish(alert, source, result, actorId, context, rule) {
  try {
    await updateStatus(alert, `Moderator: <@${actorId}>\n${result.content}`, result.retry ? controls(source, rule).toJSON() : undefined);
  } catch (error) {
    context.logger.error({ err: error, alertId: alert.id }, 'Rule security status update failed');
    result.content += ' The security record could not be updated; check bot logs.';
  }
}

/** @param {import('discord.js').BaseInteraction} interaction
 * @param {import('./commands/command.js').CommandContext} context */
export async function showRuleSelector(interaction, context) {
  if (!interaction.isMessageContextMenuCommand()) return;
  if (!context.guildId || interaction.guildId !== context.guildId || !interaction.guild || interaction.user.bot) {
    await interaction.reply({ content: 'Rule reports are available to members of the configured server.', flags: MessageFlags.Ephemeral });
    return;
  }
  for (const [token, pending] of selections) {
    if (pending.expires <= Date.now() || pending.actorId === interaction.user.id) selections.delete(token);
  }
  if (selections.size >= 1000) {
    await interaction.reply({ content: 'Too many open report menus. Please try again shortly.', flags: MessageFlags.Ephemeral });
    return;
  }
  const token = randomUUID();
  selections.set(token, { actorId: interaction.user.id, guildId: context.guildId,
    channelId: interaction.targetMessage.channelId, messageId: interaction.targetMessage.id,
    authorId: interaction.targetMessage.author.id, expires: Date.now() + 300_000 });
  try {
    const select = new StringSelectMenuBuilder().setCustomId(`rules:select:${token}`)
      .setPlaceholder('Choose the violated rule').setMinValues(1).setMaxValues(1)
      .addOptions(moderationRules.map(rule => ({ label: rule.label, value: rule.id })));
    await interaction.reply({ content: 'Choose a rule. Moderators immediately delete the message and apply a 24-hour timeout; other members send a report to security. This menu expires in five minutes.',
      components: [new ActionRowBuilder().addComponents(select).toJSON()], flags: MessageFlags.Ephemeral });
  } catch (error) { selections.delete(token); throw error; }
}

/** @param {import('discord.js').BaseInteraction} base
 * @param {import('./commands/command.js').CommandContext} context */
export async function handleRuleSelection(base, context) {
  if (!base.isStringSelectMenu?.() || !base.customId.startsWith('rules:select:')) return false;
  await base.deferReply({ flags: MessageFlags.Ephemeral });
  const token = base.customId.slice('rules:select:'.length);
  const pending = selections.get(token);
  const rule = base.values.length === 1 ? moderationRules.find(item => item.id === base.values[0]) : undefined;
  if (!pending || pending.expires <= Date.now() || pending.actorId !== base.user.id || base.user.bot
    || !context.guildId || base.guildId !== context.guildId || pending.guildId !== base.guildId || !base.guild
    || !rule || base.message.author.id !== base.client.user.id) {
    await base.editReply('This rule menu is invalid, expired, or belongs to another member. Open Report Rule Violation again.');
    return true;
  }
  // Consume before awaiting anything: the same menu cannot submit twice.
  selections.delete(token);
  try {
    await submitRuleReport(base, context, pending, rule);
  } catch (error) {
    context.logger.error({ err: error, interactionId: base.id, rule: rule.id }, 'Rule report failed');
    await base.editReply('Rule action failed. Check permissions, role hierarchy, and whether the source message is still available. Details are in the bot logs.');
  }
  return true;
}

/** @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {import('./commands/command.js').CommandContext} context
 * @param {PendingSelection} pending @param {ModerationRule} rule */
async function submitRuleReport(interaction, context, pending, rule) {
  const key = `${interaction.guildId}:${pending.messageId}`;
  const task = (deliveries.get(key) ?? Promise.resolve()).catch(() => {}).then(() =>
    deliverRuleReport(interaction, context, pending, rule));
  deliveries.set(key, task);
  try { await task; } finally { if (deliveries.get(key) === task) deliveries.delete(key); }
}

/** @param {import('discord.js').StringSelectMenuInteraction} interaction
 * @param {import('./commands/command.js').CommandContext} context
 * @param {PendingSelection} pending @param {ModerationRule} rule */
async function deliverRuleReport(interaction, context, pending, rule) {
  if (!context.guildId || interaction.guildId !== context.guildId || !interaction.guild) {
    await interaction.reply({ content: 'This command is restricted to the configured server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.bot) {
    await interaction.reply({ content: 'Bot accounts cannot submit rule reports.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const key = `${interaction.guildId}:${pending.messageId}`;
  if (active.has(key)) { await interaction.editReply('This message is already being processed.'); return; }
  active.add(key);
  try {
    if (!context.securityChannelId) throw new Error('The security channel is not configured.');
    const guild = interaction.guild;
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    const channel = await guild.channels.fetch(pending.channelId);
    if (!channel?.isTextBased()) throw new Error('Source channel unavailable.');
    if (!actor.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel)) throw new Error('You cannot view the source channel.');
    const moderator = isModerator(actor, channel);
    const existing = reported.get(key);
    if (moderator && existing?.completed) {
      await interaction.editReply('This message has already been handled. If deletion failed, delete it manually without repeating the timeout.');
      return;
    }
    // Resolve only after acquiring the queue/lock: an earlier moderator may have deleted the source.
    const message = await channel.messages.fetch({ message: pending.messageId, force: true, cache: false });
    if (message.author.id !== pending.authorId) throw new Error('Source author changed.');
    let current;
    if (existing) {
      try { current = await existing.alert.fetch(true); }
      catch (error) {
        // Keep attribution metadata until replacement succeeds. Only a confirmed deletion permits recreation.
        if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 10008)) throw error;
      }
    }
    if (!moderator && current && existing?.reporters.get(actor.id)?.has(rule.id)) {
      await interaction.editReply('Your report is already included on the security card.'); return;
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
    const reporters = new Map(existing?.reporters);
    reporters.set(actor.id, new Set([...(reporters.get(actor.id) ?? []), rule.id]));
    let alert;
    if (current) {
      // Read the latest card to preserve any approval/status changes before editing attribution.
      const card = readCard(current);
      alert = await current.edit({ components: [{ ...card, components: card.components.map(item =>
        item.type === ComponentType.TextDisplay && item.id === 4 ? { ...item, content: reporterText(reporters) } : item) }],
      allowedMentions: { parse: [] } });
      if (moderator) alert = await updateStatus(alert, `Moderator: <@${actor.id}>\n${rule.label}: action in progress.`, undefined);
    } else {
      const card = reportCard(message, guild.id, existing?.rule ?? rule, reporters, moderator || existing?.completed === true);
      if (existing?.completed) {
        card.components = card.components.map(item => item.type === ComponentType.TextDisplay && item.id === 5
          ? { ...item, content: 'Moderation was already handled. If the source remains, delete it manually without repeating the timeout.' } : item);
      }
      alert = await security.send({ components: [card],
        flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    }
    const report = { alert, reporters, rule: existing?.rule ?? rule, completed: existing?.completed ?? false };
    reported.delete(key);
    reported.set(key, report);
    if (reported.size > 1000) reported.delete(/** @type {string} */ (reported.keys().next().value));
    if (target) {
      const result = await applyRuleModeration(message, target, actor.id, context, rule);
      report.completed = !result.retry;
      await finish(alert, message, result, actor.id, context, rule);
      await interaction.editReply(result.content);
    } else {
      await interaction.editReply(`${rule.label} report ${existing ? 'added to the existing security card' : 'sent to security for moderator approval'}. No moderation action was taken.`);
    }
  } finally { active.delete(key); }
}

/** @param {import('discord.js').BaseInteraction} base
 * @param {import('./commands/command.js').CommandContext} context */
export async function handleRuleApproval(base, context) {
  if (!base.isButton?.() || !base.customId.startsWith('rules:accept:')) return false;
  await base.deferReply({ flags: MessageFlags.Ephemeral });
  let key;
  try {
    if (!context.guildId || base.guildId !== context.guildId || !base.guild
      || base.channelId !== context.securityChannelId || base.message.author.id !== base.client.user.id) {
      throw new Error('Invalid security report context.');
    }
    const rule = moderationRules.find(item => item.id === base.customId.split(':')[2]);
    const match = /^rules:accept:[1-9]:(\d{17,20}):(\d{17,20}):(\d{17,20})$/u.exec(base.customId);
    if (!match || !rule) throw new Error('Invalid report target.');
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
    if (!readCard(alert).components.some(row => row.type === ComponentType.ActionRow && row.components.some(button =>
      button.type === ComponentType.Button && 'custom_id' in button && button.custom_id === base.customId && !button.disabled))) {
      throw new Error('This report has already been handled.');
    }
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    if (message.author.id !== userId) throw new Error('Source author does not match the report.');
    const target = await authorize(message, actor, channel);
    // Consume the approval on Discord before acting, so stale clicks/restarts cannot replay it.
    await updateStatus(alert, `Moderator: <@${actor.id}>\nAction in progress.`, undefined);
    const result = await applyRuleModeration(message, target, actor.id, context, rule);
    const report = reported.get(targetKey);
    if (report) report.completed = !result.retry;
    await finish(alert, message, result, actor.id, context, rule);
    await base.editReply(result.content);
  } catch (error) {
    context.logger.warn({ err: error, interactionId: base.id }, 'Rule approval failed');
    await base.editReply('Rule approval failed. Check moderator permissions, role hierarchy, and whether the report and source message are still available.');
  } finally { if (key) active.delete(key); }
  return true;
}