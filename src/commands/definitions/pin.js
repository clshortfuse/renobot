import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

/** @type {import('../command.js').Command} */
const command = {
  access: 'thread-owner',
  data: new SlashCommandBuilder()
    .setName('pin')
    .setDescription('Pin a message where you have pin permission or in a public post you created.')
    .addStringOption((option) => option
      .setName('message')
      .setDescription('Copy Message Link for a message in this channel, thread, or post.')
      .setRequired(true)),
  async execute(interaction, context) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!context.guildId || interaction.guildId !== context.guildId) {
      await interaction.editReply('This command is only available in the configured server.');
      return;
    }

    const thread = await interaction.client.channels.fetch(interaction.channelId, { force: true });
    if (!thread || !thread.isTextBased() || thread.isDMBased()) {
      await interaction.editReply('Run this command inside a server message channel, thread, or post.');
      return;
    }
    const isPublicCreator = thread.isThread()
      && [ChannelType.PublicThread, ChannelType.AnnouncementThread].includes(thread.type)
      && thread.ownerId === interaction.user.id;
    if (thread.guildId !== context.guildId
      || !(interaction.memberPermissions?.has(PermissionFlagsBits.PinMessages) || isPublicCreator)) {
      await interaction.editReply('You need Pin Messages in this channel, or must be the creator of this public thread or post.');
      return;
    }
    if (thread.isThread() && (thread.archived || thread.locked)) {
      await interaction.editReply('This thread is archived or locked. No changes were made.');
      return;
    }

    const link = interaction.options.getString('message', true).trim();
    const match = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/u.exec(link);
    if (!match || match[1] !== context.guildId || match[2] !== thread.id) {
      await interaction.editReply('Provide a Discord message link from this same channel, thread, or post.');
      return;
    }
    const messageId = match[3];
    if (!messageId) {
      await interaction.editReply('Provide a valid Discord message link.');
      return;
    }

    const me = await thread.guild.members.fetchMe();
    const permissions = thread.permissionsFor(me);
    const missing = [
      { bit: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
      { bit: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
      { bit: PermissionFlagsBits.PinMessages, name: 'Pin Messages' },
    ].filter(({ bit }) => !permissions?.has(bit)).map(({ name }) => name);
    if (missing.length > 0) {
      await interaction.editReply(`Renobot is missing these permissions here: ${missing.join(', ')}.`);
      return;
    }

    await thread.messages.pin(messageId, `Requested by authorized user ${interaction.user.id}`);
    await interaction.editReply('Message pinned.');
  },
};

export default command;