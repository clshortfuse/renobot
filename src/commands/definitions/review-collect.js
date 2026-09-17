import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

/** @type {readonly import('discord.js').ApplicationCommandOptionAllowedChannelTypes[]} */
const reviewSourceChannelTypes = Object.freeze([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

/** @satisfies {import('../command.js').Command} */
const reviewCollectCommand = {
  data: new SlashCommandBuilder()
    .setName('review-collect')
    .setDescription('Preview week-in-review source counts.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The channel to collect, including its public threads.')
        .addChannelTypes(...reviewSourceChannelTypes)
        .setRequired(true)),

  async execute(interaction, context) {
    if (!interaction.guildId) {
      throw new Error('Review collection requires a guild interaction.');
    }

    if (!context.messageContentIntent) {
      await interaction.reply({
        content: 'Review collection is unavailable until Discord approves Message Content Intent for Renobot.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel(
      'channel',
      true,
      reviewSourceChannelTypes,
    );
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const preview = await context.reviewCollection.collect({
      channelId: channel.id,
      client: interaction.client,
      guildId: interaction.guildId,
    });
    const periodStart = Math.floor(preview.periodStart.getTime() / 1_000);
    const periodEnd = Math.floor(preview.periodEnd.getTime() / 1_000);

    await interaction.editReply([
      '**Review collection preview**',
      `- Source: <#${channel.id}>`,
      `- Period: <t:${periodStart}:f> to <t:${periodEnd}:f>`,
      `- Conversations: ${preview.conversationCount}`,
      `- Messages: ${preview.messageCount}`,
      '',
      'No message content was displayed or sent to a model.',
    ].join('\n'));
  },
};

export default reviewCollectCommand;