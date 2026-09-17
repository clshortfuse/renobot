import { SlashCommandBuilder } from 'discord.js';

/** @satisfies {import('../command.js').Command} */
const pingCommand = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether Renobot is responsive.'),

  async execute(interaction) {
    await interaction.reply('Pong!');
  },
};

export default pingCommand;