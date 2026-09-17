import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import pino from 'pino';

import { createBot, handleInteraction } from '../src/bot.js';

const silentLogger = pino({ level: 'silent' });

describe('interaction handling', () => {
  it('ignores interactions that are not chat input commands', async () => {
    let replied = false;
    const interaction = asInteraction({
      isChatInputCommand: () => false,
      reply: async () => {
        replied = true;
      },
    });

    await handleInteraction(interaction, createContext());

    assert.equal(replied, false);
  });

  it('responds ephemerally when a registered command is unavailable', async () => {
    /** @type {import('discord.js').InteractionReplyOptions | undefined} */
    let response;
    const interaction = asInteraction({
      id: 'interaction-id',
      commandName: 'missing',
      user: { id: 'owner' },
      isChatInputCommand: () => true,
      reply: async (/** @type {unknown} */ value) => {
        response = /** @type {import('discord.js').InteractionReplyOptions} */ (
          value
        );
      },
    });

    await handleInteraction(interaction, createContext());

    assert.deepEqual(response, {
      content: 'That command is not currently available.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('turns command failures into a safe response', async () => {
    /** @type {import('discord.js').InteractionReplyOptions | undefined} */
    let response;
    /** @type {import('../src/commands/command.js').Command} */
    const brokenCommand = {
      data: new SlashCommandBuilder()
        .setName('broken')
        .setDescription('Always fails during this test.'),
      async execute() {
        throw new Error('Sensitive internal details');
      },
    };
    const interaction = asInteraction({
      id: 'interaction-id',
      commandName: 'broken',
      user: { id: 'owner' },
      deferred: false,
      replied: false,
      isChatInputCommand: () => true,
      reply: async (/** @type {unknown} */ value) => {
        response = /** @type {import('discord.js').InteractionReplyOptions} */ (
          value
        );
      },
    });

    await handleInteraction(
      interaction,
      createContext(new Map([['broken', brokenCommand]])),
    );

    assert.deepEqual(response, {
      content: 'Something went wrong while running that command.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('logs successful command execution', async () => {
    const { logger, logs } = createCapturingLogger();
    /** @type {import('../src/commands/command.js').Command} */
    const command = {
      data: new SlashCommandBuilder()
        .setName('working')
        .setDescription('Succeeds during this test.'),
      async execute() {},
    };
    const interaction = asInteraction({
      id: 'interaction-id',
      commandName: 'working',
      user: { id: 'owner' },
      isChatInputCommand: () => true,
    });

    const context = createContext(new Map([['working', command]]), logger);
    await handleInteraction(interaction, context);

    assert.equal(logs.length, 1);
    const [log] = logs;
    assert.ok(log);
    assert.equal(log.command, 'working');
    assert.equal(log.interactionId, 'interaction-id');
    assert.equal(log.userId, 'owner');
    assert.equal(log.msg, 'Command executed');
    assert.ok(Number(log.durationMs) >= 0);
  });

  it('logs Discord connection lifecycle events', async () => {
    const { logger, logs } = createCapturingLogger();
    const client = createBot({
      ...createContext(new Map(), logger),
      messageContentIntent: true,
    });
    const disconnect = /** @type {CloseEvent} */ ({
      code: 1_006,
      reason: 'connection lost',
      wasClean: false,
    });

    client.emit(Events.ShardDisconnect, disconnect, 0);
    client.emit(Events.ShardError, new Error('gateway failure'), 0);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 3);
    client.emit(Events.Error, new Error('client failure'));
    await client.destroy();

    assert.deepEqual(
      logs.map((log) => log.msg),
      [
        'Discord shard disconnected',
        'Discord shard error',
        'Discord shard reconnecting',
        'Discord shard resumed',
        'Discord client error',
      ],
    );
    assert.equal(logs[0]?.code, 1_006);
    assert.equal(logs[0]?.shardId, 0);
    assert.equal(logs[3]?.replayedEvents, 3);
    assert.equal(client.options.intents.has(GatewayIntentBits.Guilds), true);
    assert.equal(
      client.options.intents.has(GatewayIntentBits.MessageContent),
      true,
    );
  });

  it('does not request unapproved Message Content access', async () => {
    const client = createBot(createContext());

    assert.equal(client.options.intents.has(GatewayIntentBits.Guilds), true);
    assert.equal(
      client.options.intents.has(GatewayIntentBits.MessageContent),
      false,
    );

    await client.destroy();
  });

  it('rejects commands from anyone except the configured owner', async () => {
    /** @type {import('discord.js').InteractionReplyOptions | undefined} */
    let response;
    const interaction = asInteraction({
      id: 'interaction-id',
      commandName: 'ping',
      user: { id: 'other-user' },
      isChatInputCommand: () => true,
      reply: async (/** @type {unknown} */ value) => {
        response = /** @type {import('discord.js').InteractionReplyOptions} */ (
          value
        );
      },
    });

    await handleInteraction(interaction, createContext());

    assert.deepEqual(response, {
      content: 'Renobot is currently private.',
      flags: MessageFlags.Ephemeral,
    });
  });
});

/**
 * @param {Record<string, unknown>} shape
 * @returns {import('discord.js').BaseInteraction}
 */
function asInteraction(shape) {
  return /** @type {import('discord.js').BaseInteraction} */ (
    /** @type {unknown} */ ({
      isButton: () => false,
      ...shape,
    })
  );
}

/**
 * @param {ReadonlyMap<string, import('../src/commands/command.js').Command>} [commands]
 * @param {import('pino').Logger} [logger]
 * @returns {import('../src/commands/command.js').CommandContext}
 */
function createContext(commands = new Map(), logger = silentLogger) {
  return {
    commands,
    logger,
    messageContentIntent: false,
    ownerUserId: 'owner',
    reviewCollection: {
      async collect() {
        throw new Error('Review collection is not used by this test.');
      },
    },
  };
}

/**
 * @returns {{
 *   logger: import('pino').Logger,
 *   logs: Record<string, unknown>[],
 * }}
 */
function createCapturingLogger() {
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const logger = pino(
    { base: null, timestamp: false },
    {
      write(line) {
        logs.push(JSON.parse(line));
      },
    },
  );

  return { logger, logs };
}