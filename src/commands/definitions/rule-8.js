import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { moderateRule8 } from '../../rule-8.js';

export default {
  data: new ContextMenuCommandBuilder().setName('Report: Rule 8').setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(null),
  execute: moderateRule8,
};