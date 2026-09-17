import { AttachmentBuilder, ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { readModelConfig } from '../../reviews/model-config.js';
import { createChatCompletionClient } from '../../reviews/model-client.js';
import { collectRecentConversation, MAX_INPUT_BYTES, prepareConversation, readConversationAttachment, summarizeConversation } from '../../reviews/summarize.js';
import { SummaryAdmission } from '../../reviews/summary-admission.js';

const admission = new SummaryAdmission();
/** @type {readonly import('discord.js').ApplicationCommandOptionAllowedChannelTypes[]} */
const summaryChannelTypes = Object.freeze([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
]);

/** @type {import('../command.js').Command} */
const command = {
  access: 'summarize',
  data: new SlashCommandBuilder().setName('summarize')
    .setDescription('Privately summarize text, JSONL, or recent channel messages.')
    .addStringOption((option) => option.setName('text').setDescription('Conversation text to summarize.').setMaxLength(6000))
    .addAttachmentOption((option) => option.setName('file').setDescription('Authorized JSONL export, up to 100 KB and 1000 messages.'))
    .addChannelOption((option) => option.setName('channel').setDescription('Channel whose recent messages should be summarized.').addChannelTypes(...summaryChannelTypes))
    .addIntegerOption((option) => option.setName('count').setDescription('Number of recent messages (default 100).').setMinValue(1).setMaxValue(1000)),
  async execute(interaction, context) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = interaction.options.getString('text');
    const file = interaction.options.getAttachment('file');
    const selectedChannel = interaction.options.getChannel('channel', false, summaryChannelTypes);
    const count = interaction.options.getInteger('count') ?? 100;
    if ([text, file, selectedChannel].filter(Boolean).length !== 1) {
      await interaction.editReply('Supply exactly one source: text, one JSONL file, or a channel.');
      return;
    }
    if (!selectedChannel && interaction.options.getInteger('count') !== null) {
      await interaction.editReply('The count option can only be used with a channel.');
      return;
    }
    const channel = selectedChannel
      ? await interaction.client.channels.fetch(selectedChannel.id)
      : null;
    const summaryChannel = isSummaryChannel(channel) ? channel : null;
    if (selectedChannel && (!context.messageContentIntent || !interaction.guildId
      || !summaryChannel || summaryChannel.guildId !== interaction.guildId)) {
      await interaction.editReply('Channel summarization is unavailable for that channel or Message Content Intent is disabled.');
      return;
    }
    const rejection = admission.acquire(interaction.user.id);
    if (rejection) {
      await interaction.editReply(rejection);
      return;
    }
    let succeeded = false;
    try {
      let config;
      try { config = readModelConfig(); } catch {
        await interaction.editReply('The LLM is not configured. Ask the owner to set LLM_MODEL and the endpoint settings.');
        return;
      }
      let conversation;
      try {
        if (file && (!file.name.toLowerCase().endsWith('.jsonl') || file.size > MAX_INPUT_BYTES)) {
          await interaction.editReply('Use a .jsonl file no larger than 100 KB.');
          return;
        }
        const source = summaryChannel
          ? await collectRecentConversation(summaryChannel, count, interaction.client.user?.id)
          : file ? await readConversationAttachment(file.url) : text ?? '';
        conversation = prepareConversation(source, Boolean(file || summaryChannel));
      } catch {
        await interaction.editReply('Unable to read the conversation. Check channel permissions and content, or use UTF-8 JSONL with at most 1000 records and 100 KB.');
        return;
      }
      let summary;
      try {
        summary = await summarizeConversation(createChatCompletionClient({
          ...config,
          onQueued: async (position, waiting) => {
            await interaction.editReply(position > 0
              ? `Summary queued. Your position: ${position}. Waiting requests: ${waiting} (including yours); 1 request is running.`
              : 'Summary accepted. No requests ahead of yours.');
          },
          onStarted: async () => { await interaction.editReply('Your summary is now being generated.'); },
        }), conversation);
      } catch {
        await interaction.editReply('The LLM request failed: the server may be offline, busy, or timed out. No summary was generated. Your cooldown has been cleared; retry when the server is available.');
        return;
      }
      if (summary.length <= 1900) {
        await interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
      } else {
        await interaction.editReply({ content: 'Summary attached for private review.',
          files: [new AttachmentBuilder(Buffer.from(summary), { name: 'summary.txt' })],
          allowedMentions: { parse: [] } });
      }
      succeeded = true;
    } finally { admission.release(interaction.user.id, succeeded); }
  },
};

/**
 * @param {import('discord.js').Channel | null} channel
 * @returns {channel is import('discord.js').TextChannel | import('discord.js').NewsChannel | import('discord.js').PublicThreadChannel}
 */
function isSummaryChannel(channel) {
  return channel?.type === ChannelType.GuildText
    || channel?.type === ChannelType.GuildAnnouncement
    || channel?.type === ChannelType.PublicThread;
}

export default command;