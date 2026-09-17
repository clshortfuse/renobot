import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { downloadPng, fixPng, MAX_PNG_BYTES } from '../../fix-png.js';

let busy = false;
/** @type {import('../command.js').Command} */
const command = {
  data: new SlashCommandBuilder().setName('fixpng')
    .setDescription('Replace BT.2020/PQ PNG cICP metadata with the reference Rec2100PQ ICC.')
    .addAttachmentOption((option) => option.setName('file').setDescription('PNG up to 50 MiB. Pixels are preserved.'))
    .addStringOption((option) => option.setName('message').setDescription('Message link in this channel with one PNG attachment.').setMaxLength(200)),
  async execute(interaction, context) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!context.guildId || interaction.guildId !== context.guildId) {
      await interaction.editReply('This command is only available in the configured server.');
      return;
    }
    let file = interaction.options.getAttachment('file');
    const link = interaction.options.getString('message');
    if (Boolean(file) === Boolean(link)) {
      await interaction.editReply('Supply one PNG file or one message link, not both.');
      return;
    }
    if (busy) {
      await interaction.editReply('A PNG conversion is already running. Retry when it finishes.');
      return;
    }
    busy = true;
    try {
      if (link) {
        const match = /^https:\/\/(?:(?:canary|ptb)\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/u.exec(link.trim());
        if (!match || match[1] !== context.guildId || match[2] !== interaction.channelId) {
          await interaction.editReply('Use a message link from this same channel or post in the configured server.');
          return;
        }
        const messageId = match[3];
        if (!messageId) {
          await interaction.editReply('Use a valid Discord message link.');
          return;
        }
        const channel = await interaction.client.channels.fetch(interaction.channelId);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          await interaction.editReply('Unable to access that message channel.');
          return;
        }
        const message = await channel.messages.fetch({ message: messageId, cache: false, force: true });
        const files = [...message.attachments.values()].filter((attachment) => attachment.name.toLowerCase().endsWith('.png'));
        if (files.length !== 1) {
          await interaction.editReply('The message must expose exactly one PNG attachment. Upload it directly if Discord hides attachments without Message Content access.');
          return;
        }
        file = files[0] ?? null;
      }
      if (!file || !file.name.toLowerCase().endsWith('.png') || file.size > MAX_PNG_BYTES) {
        await interaction.editReply('Supply a PNG no larger than 50 MiB. Nothing was downloaded.');
        return;
      }
      let output;
      try {
        output = fixPng(await downloadPng(file.url));
      } catch {
        await interaction.editReply('PNG conversion failed: use a valid RGB/RGBA PNG with cICP 9/16/0/1, up to 50 MiB. The attachment may also be unavailable or the download timed out.');
        return;
      }
      await interaction.editReply({
        content: 'Rec2100PQ ICC inserted. Pixel data copied unchanged; no tone mapping performed.',
        files: [new AttachmentBuilder(output, { name: 'fixed.icc.png' })],
        allowedMentions: { parse: [] },
      });
    } finally { busy = false; }
  },
};
export default command;