import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApplicationCommandOptionType,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import pino from 'pino';

import { loadCommands } from '../src/commands/load-commands.js';
import pingCommand from '../src/commands/definitions/ping.js';
import reviewCollectCommand from '../src/commands/definitions/review-collect.js';

describe('built-in commands', () => {
  it('discovers every initial command in deterministic order', async () => {
    const commands = await loadCommands();

    assert.deepEqual([...commands.keys()], ['findmessages', 'fixpng', 'pin', 'ping', 'review-collect', 'summarize']);
    assert.deepEqual(
      [...commands.values()].map((command) => command.data.toJSON().name),
      ['findmessages', 'fixpng', 'pin', 'ping', 'review-collect', 'summarize'],
    );
  });

  it('restricts review collection to a required source channel picker', () => {
    const commandData = reviewCollectCommand.data.toJSON();
    const [channelOption] = commandData.options ?? [];

    assert.equal(channelOption?.name, 'channel');
    assert.equal(channelOption?.type, ApplicationCommandOptionType.Channel);
    assert.equal(channelOption?.required, true);
    assert.deepEqual(channelOption?.channel_types, [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ]);
  });

  it('responds with pong', async () => {
    /** @type {string | import('discord.js').InteractionReplyOptions | undefined} */
    let response;
    const interaction = /** @type {import('discord.js').ChatInputCommandInteraction} */ (
      /** @type {unknown} */ ({
        reply: async (/** @type {unknown} */ value) => {
          response = /** @type {string | import('discord.js').InteractionReplyOptions} */ (
            value
          );
        },
      })
    );

    await pingCommand.execute(interaction);

    assert.equal(response, 'Pong!');
  });

  it('reports review source counts ephemerally without content', async () => {
    /** @type {import('discord.js').InteractionDeferReplyOptions | undefined} */
    let deferOptions;
    /** @type {string | undefined} */
    let response;
    const channel = {
      id: '34567890123456789',
      type: ChannelType.GuildText,
    };
    const client = /** @type {import('discord.js').Client} */ ({});
    const interaction = /** @type {import('discord.js').ChatInputCommandInteraction} */ (
      /** @type {unknown} */ ({
        client,
        guildId: '23456789012345678',
        deferReply: async (/** @type {import('discord.js').InteractionDeferReplyOptions} */ value) => {
          deferOptions = value;
        },
        editReply: async (/** @type {string} */ value) => {
          response = value;
        },
        options: {
          getChannel(
            /** @type {string} */ name,
            /** @type {boolean} */ required,
            /** @type {readonly ChannelType[]} */ channelTypes,
          ) {
            assert.equal(name, 'channel');
            assert.equal(required, true);
            assert.deepEqual(channelTypes, [
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildForum,
              ChannelType.GuildMedia,
            ]);
            return channel;
          },
        },
      })
    );
    /** @type {import('../src/commands/command.js').CommandContext} */
    const context = {
      commands: new Map(),
      logger: pino({ level: 'silent' }),
      messageContentIntent: true,
      ownerUserId: 'owner',
      reviewCollection: {
        async collect(options) {
          assert.equal(options.channelId, channel.id);
          assert.equal(options.client, client);
          assert.equal(options.guildId, '23456789012345678');
          return {
            conversationCount: 5,
            messageCount: 42,
            periodEnd: new Date('2026-07-21T00:00:00.000Z'),
            periodStart: new Date('2026-07-14T00:00:00.000Z'),
          };
        },
      },
    };

    await reviewCollectCommand.execute(interaction, context);

    assert.deepEqual(deferOptions, { flags: MessageFlags.Ephemeral });
  assert.match(response ?? '', /Source: <#34567890123456789>/u);
    assert.match(response ?? '', /Conversations: 5/u);
    assert.match(response ?? '', /Messages: 42/u);
    assert.match(response ?? '', /No message content was displayed or sent to a model/u);
  });

  it('reports the Discord approval blocker without collecting messages', async () => {
    /** @type {import('discord.js').InteractionReplyOptions | undefined} */
    let response;
    let collected = false;
    const interaction = /** @type {import('discord.js').ChatInputCommandInteraction} */ (
      /** @type {unknown} */ ({
        guildId: '23456789012345678',
        reply: async (/** @type {import('discord.js').InteractionReplyOptions} */ value) => {
          response = value;
        },
      })
    );
    /** @type {import('../src/commands/command.js').CommandContext} */
    const context = {
      commands: new Map(),
      logger: pino({ level: 'silent' }),
      messageContentIntent: false,
      ownerUserId: 'owner',
      reviewCollection: {
        async collect() {
          collected = true;
          throw new Error('Collection should not run without approval.');
        },
      },
    };

    await reviewCollectCommand.execute(interaction, context);

    assert.equal(collected, false);
    assert.deepEqual(response, {
      content: 'Review collection is unavailable until Discord approves Message Content Intent for Renobot.',
      flags: MessageFlags.Ephemeral,
    });
  });
});