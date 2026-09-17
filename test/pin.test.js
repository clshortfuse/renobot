import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import pino from 'pino';

import { handleInteraction } from '../src/bot.js';
import pin from '../src/commands/definitions/pin.js';

const guildId = '111111111111111111';
const threadId = '222222222222222222';
const messageId = '333333333333333333';

function fixture() {
  const replies = /** @type {unknown[]} */ ([]);
  const pins = /** @type {unknown[]} */ ([]);
  const thread = {
    id: threadId,
    guildId,
    ownerId: 'creator',
    type: ChannelType.PublicThread,
    archived: false,
    locked: false,
    isThread: () => true,
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { members: { fetchMe: async () => ({ id: 'bot' }) } },
    permissionsFor: () => ({ has: (/** @type {bigint} */ bit) => {
      assert.ok([PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.PinMessages].includes(bit));
      return true;
    } }),
    messages: { pin: async (/** @type {string} */ id, /** @type {string} */ reason) => {
      pins.push({ id, reason });
    } },
  };
  const raw = {
    id: 'interaction',
    commandName: 'pin',
    guildId,
    channelId: threadId,
    user: { id: 'creator' },
    memberPermissions: { has: (/** @type {bigint} */ bit) => {
      assert.equal(bit, PermissionFlagsBits.PinMessages);
      return false;
    } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    client: { channels: { fetch: async () => thread } },
    options: { getString: () => `https://discord.com/channels/${guildId}/${threadId}/${messageId}` },
    deferReply: async (/** @type {unknown} */ options) => {
      assert.deepEqual(options, { flags: MessageFlags.Ephemeral });
      raw.deferred = true;
    },
    reply: async (/** @type {unknown} */ value) => { replies.push(value); },
    editReply: async (/** @type {unknown} */ value) => { replies.push(value); },
  };
  const context = /** @type {import('../src/commands/command.js').CommandContext} */ ({
    commands: new Map([['pin', pin]]),
    logger: pino({ level: 'silent' }),
    messageContentIntent: false,
    ownerUserId: 'server-owner',
    guildId,
    reviewCollection: { collect: async () => { throw new Error('Must not collect'); } },
  });
  return { raw, thread, context, pins, replies,
    run: () => handleInteraction(
      /** @type {import('discord.js').BaseInteraction} */ (/** @type {unknown} */ (raw)), context),
  };
}

describe('creator-authorized pin command', () => {
  for (const type of [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread]) {
    it(`allows a non-creator with effective pin permission in channel type ${type}`, async () => {
      const f = fixture();
      f.thread.type = type;
      f.thread.isThread = () => type !== ChannelType.GuildText;
      f.raw.user.id = 'moderator';
      f.raw.memberPermissions.has = () => true;
      await f.run();
      assert.equal(f.pins.length, 1);
      assert.deepEqual(f.replies, ['Message pinned.']);
    });
  }

  it('allows a non-owner creator with Message Content disabled', async () => {
    const f = fixture();
    await f.run();
    assert.deepEqual(f.pins, [{ id: messageId, reason: 'Requested by authorized user creator' }]);
    assert.deepEqual(f.replies, ['Message pinned.']);
  });

  for (const user of ['stranger', 'server-owner']) {
    it(`rejects non-creator ${user}`, async () => {
      const f = fixture();
      f.raw.user.id = user;
      await f.run();
      assert.equal(f.pins.length, 0);
      assert.match(String(f.replies[0]), /need Pin Messages/u);
    });
  }

  for (const type of [ChannelType.PrivateThread, ChannelType.GuildText]) {
    it(`rejects channel type ${type}`, async () => {
      const f = fixture();
      f.thread.type = type;
      f.thread.isThread = () => type === ChannelType.PrivateThread;
      await f.run();
      assert.equal(f.pins.length, 0);
      assert.match(String(f.replies[0]), /public thread/u);
    });
  }

  it('rejects an invocation in another guild', async () => {
    const f = fixture();
    f.raw.guildId = 'other';
    await f.run();
    assert.equal(f.pins.length, 0);
    assert.match(String(f.replies[0]), /configured server/u);
  });

  for (const link of ['not a link',
    `https://discord.com/channels/${guildId}/${messageId}/${messageId}`,
    `https://discord.com/channels/${messageId}/${threadId}/${messageId}`,
    `https://example.com/channels/${guildId}/${threadId}/${messageId}`]) {
    it(`rejects invalid or out-of-scope link ${link}`, async () => {
      const f = fixture();
      f.raw.options.getString = () => link;
      await f.run();
      assert.equal(f.pins.length, 0);
      assert.match(String(f.replies[0]), /same channel/u);
    });
  }

  for (const state of ['archived', 'locked']) {
    it(`does not modify ${state} threads`, async () => {
      const f = fixture();
      if (state === 'archived') f.thread.archived = true;
      else f.thread.locked = true;
      await f.run();
      assert.equal(f.pins.length, 0);
      assert.match(String(f.replies[0]), /archived or locked/u);
    });
  }

  it('explains missing bot permissions', async () => {
    const f = fixture();
    f.thread.permissionsFor = () => ({ has: () => false });
    await f.run();
    assert.equal(f.pins.length, 0);
    assert.deepEqual(f.replies, ['Renobot is missing these permissions here: View Channel, Read Message History, Pin Messages.']);
  });

  for (const [bit, name] of [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
    [PermissionFlagsBits.PinMessages, 'Pin Messages'],
  ]) {
    it(`reports only the missing ${name} permission`, async () => {
      const f = fixture();
      f.thread.permissionsFor = () => ({ has: (permission) => permission !== bit });
      await f.run();
      assert.equal(f.pins.length, 0);
      assert.deepEqual(f.replies, [`Renobot is missing these permissions here: ${name}.`]);
    });
  }

  it('uses centralized safe handling for Discord failures', async () => {
    const f = fixture();
    f.thread.messages.pin = async () => { throw new Error('Private API details'); };
    await f.run();
    assert.deepEqual(f.replies, ['Something went wrong while running that command.']);
  });
});