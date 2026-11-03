import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { showRuleSelector } from '../../moderation.js';

export default {
  data: new ContextMenuCommandBuilder().setName('Report Rule Violation').setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(null),
  execute: showRuleSelector,
};