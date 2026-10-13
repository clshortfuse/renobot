import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { fixHdrMessage } from '../../hdr-avif.js';

export default {
  data: new ContextMenuCommandBuilder().setName('Fix HDR Preview').setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(0),
  execute: fixHdrMessage,
};