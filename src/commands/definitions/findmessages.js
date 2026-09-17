import { AttachmentBuilder, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

/**
 * @param {(before: string | undefined, limit: number) => Promise<Array<{id: string, author: {id: string}}>>} fetchPage
 * @param {string} userId
 * @param {number} limit
 */
export async function findUserMessages(fetchPage, userId, limit) {
  let scanned = 0;
  let before;
  let exhausted = false;
  const ids = [];
  while (scanned < limit) {
    const size = Math.min(100, limit - scanned);
    const page = await fetchPage(before, size);
    for (const message of page) {
      scanned++;
      if (message.author.id === userId) ids.push(message.id);
    }
    if (page.length < size) {
      exhausted = true;
      break;
    }
    const next = page.at(-1)?.id;
    if (!next || next === before) break;
    before = next;
  }
  return { ids, scanned, exhausted, before };
}

/** @type {import('../command.js').Command} */
const command = {
  data: new SlashCommandBuilder()
    .setName('findmessages')
    .setDescription('Find a user’s messages in one channel or post without deleting anything.')
    .addStringOption((option) => option.setName('userid').setDescription('User ID, including a banned user.').setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('Only this channel or post is scanned.').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.AnnouncementThread))
    .addIntegerOption((option) => option.setName('limit').setDescription('Recent messages to scan, not number of matches (default 1000).').setMinValue(1).setMaxValue(5000)),
  async execute(interaction, context) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!context.guildId || interaction.guildId !== context.guildId) {
      await interaction.editReply('This command is only available in the configured server.');
      return;
    }
    const userId = interaction.options.getString('userid', true).trim();
    if (!/^\d{17,20}$/u.test(userId)) {
      await interaction.editReply('Provide the numeric user ID using Copy User ID.');
      return;
    }
    const selected = interaction.options.getChannel('channel', true);
    const channel = await interaction.client.channels.fetch(selected.id);
    if (!channel || channel.isDMBased() || !channel.isTextBased()
      || channel.guildId !== context.guildId || channel.type === ChannelType.PrivateThread) {
      await interaction.editReply('Choose a server text channel or public thread/post.');
      return;
    }
    const permissions = channel.permissionsFor(await channel.guild.members.fetchMe());
    const missing = [
      { bit: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
      { bit: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
    ].filter(({ bit }) => !permissions?.has(bit)).map(({ name }) => name);
    if (missing.length) {
      await interaction.editReply(`Renobot is missing these permissions here: ${missing.join(', ')}.`);
      return;
    }
    const result = await findUserMessages(async (before, limit) => {
      const messages = await channel.messages.fetch({ ...(before ? { before } : {}), limit, cache: false });
      return [...messages.values()].sort((a, b) => a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
    }, userId, interaction.options.getInteger('limit') ?? 1000);
    const links = result.ids.map((id) => `https://discord.com/channels/${context.guildId}/${channel.id}/${id}`);
    await interaction.editReply({
      content: `Found ${links.length} messages by user ${userId} in <#${channel.id}>. Scanned ${result.scanned} messages, newest first. ${result.exhausted ? 'Reached the end of available history.' : 'Scan limit reached; older messages may remain.'} Threads and other channels were not scanned. Nothing was deleted.`,
      allowedMentions: { parse: [] },
      files: links.length ? [new AttachmentBuilder(Buffer.from(links.join('\n')), { name: 'message-links.txt' })] : [],
    });
  },
};

export default command;