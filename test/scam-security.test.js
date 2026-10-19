import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Events } from 'discord.js';
import pino from 'pino';
import { createBot } from '../src/bot.js';

test('security activity reports reject foreign-guild and nonguild destinations', async () => {
  for (const destinationGuild of ['guild', 'other', undefined]) {
    let sent = 0;
    const attempted = Promise.withResolvers();
    const client = createBot({ commands: new Map(), logger: pino({ level: 'silent' }),
      messageContentIntent: true, ownerUserId: 'owner', guildId: 'guild', securityChannelId: 'security',
      reviewCollection: { collect: async () => { throw new Error('Unused'); } },
      securityAutodelete: { channelId: 'trap', mode: 'dry-run',
        exemptUsers: [], exemptRoles: [], userLimit: 10, guildLimit: 30 } });
    const destination = { ...(destinationGuild ? { guildId: destinationGuild } : {}),
      isSendable: () => true, send: async () => { sent++; } };
    client.channels.fetch = /** @type {typeof client.channels.fetch} */ (/** @type {unknown} */ (async () => {
      attempted.resolve(undefined);
      return destination;
    }));
    const guild = { members: { fetch: async () => ({ roles: { cache: new Map() } }) } };
    const message = (/** @type {string} */ channelId) => /** @type {import('discord.js').Message<true>} */ (/** @type {unknown} */ ({
      id: channelId, channelId, guildId: 'guild', guild, author: { id: 'user', bot: false },
      webhookId: null, url: 'https://discord.com/channels/guild/source/message',
      content: 'ordinary text', attachments: new Map(),
    }));
    try {
      client.emit(Events.MessageCreate, message('source'));
      client.emit(Events.MessageCreate, message('trap'));
      await attempted.promise;
    } finally { await client.destroy(); }
    assert.equal(sent, destinationGuild === 'guild' ? 1 : 0);
  }
});