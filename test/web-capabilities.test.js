import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscordAPIError } from 'discord.js';

import { requiredCapability, resolveCapabilities } from '../src/web-capabilities.js';

const config = /** @type {import('../src/web-config.js').WebConfig} */ ({
  guildId: '23456789012345678', ownerUserId: 'owner',
  modderRoleId: 'modder', moderatorRoleId: 'moderator',
});

/** @param {string[]} roles @param {Error | undefined} [failure] */
function botWithMember(roles, failure) {
  /** @type {unknown[]} */
  const calls = [];
  const bot = {
    guilds: { fetch: async (/** @type {string} */ guildId) => {
      calls.push(guildId);
      return { members: { fetch: async (/** @type {unknown} */ options) => {
        calls.push(options);
        if (failure) throw failure;
        return { roles: { cache: { has: (/** @type {string} */ id) => roles.includes(id) } } };
      } } };
    } },
  };
  return { bot: /** @type {import('discord.js').Client} */ (/** @type {unknown} */ (bot)), calls };
}

describe('portal capabilities', () => {
  it('grants owner capabilities without relying on a guild lookup', async () => {
    const { bot, calls } = botWithMember([]);
    assert.deepEqual([...await resolveCapabilities(bot, config, 'owner')],
      ['authenticated', 'admin', 'modder', 'appeal:review']);
    assert.deepEqual(calls, []);
  });

  it('checks current member roles without caching or relying on session claims', async () => {
    const { bot, calls } = botWithMember(['modder', 'moderator']);
    assert.deepEqual([...await resolveCapabilities(bot, config, 'visitor')],
      ['authenticated', 'modder', 'appeal:review']);
    assert.deepEqual(calls, [config.guildId, { user: 'visitor', force: true, cache: false }]);
    assert.deepEqual([...await resolveCapabilities(botWithMember([]).bot, config, 'visitor')], ['authenticated']);
  });

  it('distinguishes a confirmed non-member from Discord lookup failures', async () => {
    const absent = new DiscordAPIError({ code: 10007, message: 'Unknown Member' }, 10007, 404,
      'GET', 'https://discord.com/api/v10/guilds/g/members/u', { body: null, files: undefined });
    assert.deepEqual([...await resolveCapabilities(botWithMember([], absent).bot, config, 'visitor')], ['authenticated']);
    await assert.rejects(resolveCapabilities(botWithMember([], new Error('Discord unavailable')).bot, config, 'visitor'),
      /Discord unavailable/u);
  });

  it('maps planned privileged route scopes to required capabilities', () => {
    assert.equal(requiredCapability('/app'), undefined);
    assert.equal(requiredCapability('/app/modder/kofi'), 'modder');
    assert.equal(requiredCapability('/app/admin'), 'admin');
    assert.equal(requiredCapability('/app/admin/appeals'), 'appeal:review');
    assert.equal(requiredCapability('/app/modderish'), undefined);
  });
});
