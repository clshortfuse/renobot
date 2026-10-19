import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js';
import { fixHdrMessage } from './hdr-avif.js';
import { createScamDetector } from './scam-detection.js';
import { createScamAlerts } from './scam-alerts.js';
import { createSecurityAutodelete } from './security-autodelete.js';

/**
 * @param {import('./commands/command.js').CommandContext} context
 * @returns {Client}
 */
export function createBot(context) {
  const client = new Client({
    partials: context.securityChannelId ? [Partials.Message] : [],
    intents: [
      GatewayIntentBits.Guilds,
      ...(context.securityChannelId ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration] : []),
      ...(context.messageContentIntent
        ? [GatewayIntentBits.MessageContent]
        : []),
    ],
  });

  const scamAlerts = createScamAlerts(client, context);
  if (context.securityChannelId && context.guildId) {
    const channelId = context.securityChannelId;
    const autodelete = context.securityAutodelete ? createSecurityAutodelete({ config: context.securityAutodelete,
      guildId: context.guildId, ownerUserId: context.ownerUserId, logger: context.logger,
      alert: (message, reason) => scamAlerts.send({ message, reason, image: undefined }),
      annotate: scamAlerts.annotate,
      onDelete: scamAlerts.onDelete, report: async content => {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== context.guildId) {
          throw new Error('Security destination unavailable or outside the configured guild');
        }
        return channel.send({ content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
      } }) : undefined;
    if (autodelete) scamAlerts.setAutomatic(autodelete);
    const detector = createScamDetector({ guildId: context.guildId, channelId, logger: context.logger,
      send: async evidence => { await scamAlerts.send(evidence); await autodelete?.flag(evidence); } });
    client.on(Events.GuildBanAdd, (ban) => { void scamAlerts.onBan(ban).catch((error) => {
      context.logger.error({ err: error }, 'Security ban event failed');
    }); });
    client.on(Events.GuildBanRemove, (ban) => { void scamAlerts.onBan(ban, false).catch((error) => {
      context.logger.error({ err: error }, 'Security unban event failed');
    }); });
    client.on(Events.MessageDelete, (message) => { void scamAlerts.onDelete(message).catch((error) => {
      context.logger.error({ err: error }, 'Security deletion event failed');
    }); });
    client.on(Events.MessageBulkDelete, (messages) => { void Promise.all([...messages.values()].map((message) => scamAlerts.onDelete(message))).catch((error) => {
      context.logger.error({ err: error }, 'Security bulk deletion event failed');
    }); });
    client.on(Events.MessageCreate, (message) => {
      void autodelete?.observe(message).catch(error => context.logger.error({ err: error }, 'Honeypot observation failed'));
      void detector.enqueue(message);
    });
    const destroy = client.destroy.bind(client);
    client.destroy = async () => { await autodelete?.close(); await detector.close(); await destroy(); };
  }

  client.once(Events.ClientReady, (readyClient) => {
    context.logger.info(
      {
        guilds: readyClient.guilds.cache.size,
        user: readyClient.user.tag,
      },
      'Renobot is ready',
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, context, scamAlerts).catch((error) => {
      context.logger.error(
        { err: error, interactionId: interaction.id },
        'Interaction handling failed',
      );
    });
  });

  client.on(Events.Error, (error) => {
    context.logger.error({ err: error }, 'Discord client error');
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    context.logger.warn(
      {
        code: event.code,
        reason: event.reason,
        shardId,
        wasClean: event.wasClean,
      },
      'Discord shard disconnected',
    );
  });

  client.on(Events.ShardError, (error, shardId) => {
    context.logger.error({ err: error, shardId }, 'Discord shard error');
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    context.logger.warn({ shardId }, 'Discord shard reconnecting');
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    context.logger.info(
      { replayedEvents, shardId },
      'Discord shard resumed',
    );
  });

  return client;
}

/**
 * @param {import('discord.js').BaseInteraction} interaction
 * @param {import('./commands/command.js').CommandContext} context
 * @param {ReturnType<typeof createScamAlerts>} [scamAlerts]
 * @returns {Promise<void>}
 */
export async function handleInteraction(interaction, context, scamAlerts) {
  if (await scamAlerts?.handle(interaction)) return;
  if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand?.()) {
    return;
  }

  const command = context.commands.get(interaction.commandName);

  if (!interaction.isChatInputCommand() && interaction.isMessageContextMenuCommand()) {
    if (interaction.commandName !== 'Fix HDR Preview'
      || interaction.guildId !== context.guildId || !context.guildId) {
      await interaction.reply({ content: 'This command is restricted to the configured server.', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await fixHdrMessage(interaction);
    } catch (error) {
      context.logger.error({ err: error, interactionId: interaction.id }, 'HDR conversion failed');
      if (interaction.deferred) await interaction.editReply('HDR conversion failed. Check the bot logs for details.');
      else await interaction.reply({ content: 'HDR conversion failed.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (command?.access === 'summarize') {
    const roles = interaction.member?.roles;
    const hasRole = context.summarizeRoleId && (Array.isArray(roles)
      ? roles.includes(context.summarizeRoleId)
      : roles?.cache.has(context.summarizeRoleId));
    if (interaction.guildId !== context.guildId || !context.guildId
      || !(interaction.user.id === context.ownerUserId || hasRole)) {
      await interaction.reply({ content: 'Summarization is restricted to the owner and configured modder role in this server.',
        flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (command?.access !== 'thread-owner' && command?.access !== 'summarize'
    && interaction.user.id !== context.ownerUserId) {
    context.logger.warn(
      {
        command: interaction.commandName,
        interactionId: interaction.id,
        userId: interaction.user.id,
      },
      'Rejected command from unauthorized user',
    );
    await interaction.reply({
      content: 'Renobot is currently private.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!command) {
    context.logger.warn(
      {
        command: interaction.commandName,
        interactionId: interaction.id,
      },
      'Received an unknown command',
    );
    await interaction.reply({
      content: 'That command is not currently available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const startedAt = process.hrtime.bigint();

  try {
    await command.execute(interaction, context);
    context.logger.info(
      {
        command: interaction.commandName,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        interactionId: interaction.id,
        userId: interaction.user.id,
      },
      'Command executed',
    );
  } catch (error) {
    context.logger.error(
      {
        command: interaction.commandName,
        err: error,
        interactionId: interaction.id,
      },
      'Command execution failed',
    );

    const errorContent = 'Something went wrong while running that command.';
    /** @type {import('discord.js').InteractionReplyOptions} */
    const response = {
      content: errorContent,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred) {
      await interaction.editReply(errorContent);
    } else if (interaction.replied) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
}