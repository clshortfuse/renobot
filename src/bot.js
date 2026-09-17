import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

/**
 * @param {import('./commands/command.js').CommandContext} context
 * @returns {Client}
 */
export function createBot(context) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(context.messageContentIntent
        ? [GatewayIntentBits.MessageContent]
        : []),
    ],
  });

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
    void handleInteraction(interaction, context).catch((error) => {
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
 * @returns {Promise<void>}
 */
export async function handleInteraction(interaction, context) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = context.commands.get(interaction.commandName);

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