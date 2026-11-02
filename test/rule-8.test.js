import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ComponentType, MessageFlags } from 'discord.js';
import pino from 'pino';
import { handleRule8Button, moderateRule8 } from '../src/rule-8.js';
import { handleInteraction } from '../src/bot.js';
import command from '../src/commands/definitions/rule-8.js';

let sequence = 10000000000000000n;
function fixture() {
  /** @type {string[]} */
  const actions = [];
  /** @type {string[]} */
  const responses = [];
  const target = { id: '20000000000000000', guild: { id: 'guild' }, moderatable: true, communicationDisabledUntilTimestamp: 0,
    roles: { highest: {} },
    timeout: async (/** @type {number} */ duration, /** @type {string} */ reason) => {
      assert.equal(duration, 86_400_000);
      assert.equal(reason, 'Rule 8');
      actions.push('timeout');
    } };
  const actor = { id: `actor-${sequence}`, permissions: { has: () => true },
    permissionsIn: (/** @type {import('discord.js').GuildChannelResolvable} */ channel) => ({ has: () => Boolean(channel) }),
    roles: { highest: { comparePositionTo: () => 1 } } };
  /** @type {Array<{content: string, components: unknown[]}>} */
  const reports = [];
  /** @type {Array<{content?: string, components: unknown[]}>} */
  const edits = [];
  const message = { id: String(sequence++), channelId: '30000000000000000', author: { id: target.id, bot: false },
    forward: async () => {}, deletable: true, delete: async () => { actions.push('delete'); } };
  const customId = `rule8:accept:${message.channelId}:${message.id}:${target.id}`;
  const alert = { id: 'alert', content: 'Report: Rule 8', author: { id: 'bot' },
    components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, customId, disabled: false }] }],
    edit: async (/** @type {{content?: string, components: unknown[]}} */ value) => { edits.push(value); },
    fetch: async (/** @type {boolean} */ force) => { assert.equal(force, true); return alert; } };
  const security = { id: 'security', guildId: 'guild', isSendable: () => true,
    send: async (/** @type {{content: string, components: unknown[]}} */ value) => { reports.push(value); return alert; } };
  const source = { isTextBased: () => true, messages: { fetch: async () => message } };
  const raw = { commandName: command.data.name, guildId: 'guild', user: { id: actor.id, bot: false },
    guild: { id: 'guild', ownerId: 'owner', channels: { fetch: async (/** @type {string} */ id) => id === 'security' ? security : source }, members: {
      fetch: async (/** @type {{user: string, force: boolean}} */ options) => {
        assert.equal(options.force, true);
        return options.user === actor.id ? actor : target;
      }, fetchMe: async () => ({}),
    } }, targetMessage: message, isChatInputCommand: () => false, isMessageContextMenuCommand: () => true,
    deferReply: async (/** @type {{flags: number}} */ options) => { assert.equal(options.flags, MessageFlags.Ephemeral); },
    reply: async (/** @type {{content: string}} */ options) => { responses.push(options.content); },
    editReply: async (/** @type {string} */ content) => { responses.push(content); } };
  const interaction = /** @type {import('discord.js').MessageContextMenuCommandInteraction} */ (/** @type {unknown} */ (raw));
  const context = /** @type {import('../src/commands/command.js').CommandContext} */ (/** @type {unknown} */ ({
    guildId: 'guild', securityChannelId: 'security', ownerUserId: 'owner', commands: new Map(), logger: pino({ level: 'silent' }),
  }));
  const member = Object.assign(actor, { guild: raw.guild });
  const buttonRaw = { ...raw, customId, channelId: 'security', message: alert, client: { user: { id: 'bot' } },
    isButton: () => true, isMessageContextMenuCommand: () => false };
  const button = /** @type {import('discord.js').ButtonInteraction} */ (/** @type {unknown} */ (buttonRaw));
  return { actions, responses, actor: member, target, message, raw, interaction, context,
    button, buttonRaw, reports, edits, alert, security };
}

it('registers Report: Rule 8 for all guild members', () => {
  assert.equal(command.data.toJSON().type, 3);
  assert.equal(command.data.name, 'Report: Rule 8');
  assert.equal(command.data.toJSON().default_member_permissions, null);
});

it('routes the Rule 8 action for a non-owner moderator and times out before deleting', async () => {
  const f = fixture();
  await handleInteraction(f.interaction, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
  assert.match(f.responses[0] ?? '', /Message deleted.*Rule 8/u);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0]?.components, []);
  assert.match(f.edits[0]?.content ?? '', /Message deleted/u);
});

for (const rejection of ['guild', 'hierarchy', 'self', 'bot', 'moderatable', 'deletable']) {
  it(`rejects ${rejection} without side effects`, async () => {
    const f = fixture();
    if (rejection === 'guild') f.raw.guildId = 'other';
    if (rejection === 'hierarchy') f.actor.roles.highest.comparePositionTo = () => 0;
    if (rejection === 'self') f.target.id = f.actor.id;
    if (rejection === 'bot') f.message.author.bot = true;
    if (rejection === 'moderatable') f.target.moderatable = false;
    if (rejection === 'deletable') f.message.deletable = false;
    await handleInteraction(f.interaction, f.context);
    assert.deepEqual(f.actions, []);
    assert.equal(f.responses.length, 1);
  });
}

it('allows the guild owner to bypass actor hierarchy, but not bot hierarchy', async () => {
  const f = fixture();
  f.raw.guild.ownerId = f.actor.id;
  f.actor.roles.highest.comparePositionTo = () => -1;
  await moderateRule8(f.interaction, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('does not shorten a longer existing timeout', async () => {
  const f = fixture();
  f.target.communicationDisabledUntilTimestamp = Date.now() + 172_800_000;
  await moderateRule8(f.interaction, f.context);
  assert.deepEqual(f.actions, ['delete']);
});

it('does not delete when timeout fails', async () => {
  const f = fixture();
  f.target.timeout = async () => { throw new Error('Forbidden'); };
  await moderateRule8(f.interaction, f.context);
  assert.deepEqual(f.actions, []);
  assert.match(f.responses[0] ?? '', /timeout failed.*not deleted/u);
});

it('reports the applied timeout when deletion fails', async () => {
  const f = fixture();
  f.message.delete = async () => { throw new Error('Forbidden'); };
  await moderateRule8(f.interaction, f.context);
  assert.deepEqual(f.actions, ['timeout']);
  assert.match(f.responses[0] ?? '', /timed out.*deletion failed/u);
});

it('sends a member report with an approval button without punishment, deduplicating repeats', async () => {
  const f = fixture();
  f.actor.permissions.has = () => false;
  await handleInteraction(f.interaction, f.context);
  assert.deepEqual(f.actions, []);
  assert.equal(f.reports.length, 1);
  assert.match(JSON.stringify(f.reports), /Accept: delete \+ 24h timeout/u);
  assert.match(f.responses[0] ?? '', /sent to security/u);
  await moderateRule8(f.interaction, f.context);
  assert.equal(f.reports.length, 1);
});

it('routes a security approval and consumes its button before performing moderation', async () => {
  const f = fixture();
  f.target.timeout = async () => {
    assert.deepEqual(f.edits[0]?.components, []);
    f.actions.push('timeout');
  };
  await handleInteraction(f.button, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
  assert.match(f.edits[1]?.content ?? '', /Moderator:.*actor/u);
  assert.deepEqual(f.edits[1]?.components, []);
});

for (const invalid of ['non-moderator', 'visibility', 'security', 'author', 'guild', 'source-author', 'consumed', 'hierarchy']) {
  it(`rejects ${invalid} security approvals without punishment`, async () => {
    const f = fixture();
    if (invalid === 'non-moderator') f.actor.permissions.has = () => false;
    if (invalid === 'visibility') f.actor.permissionsIn = () => ({ has: () => false });
    if (invalid === 'security') f.buttonRaw.channelId = 'elsewhere';
    if (invalid === 'author') f.alert.author.id = 'other-bot';
    if (invalid === 'guild') f.buttonRaw.guildId = 'other-guild';
    if (invalid === 'source-author') f.message.author.id = '40000000000000000';
    if (invalid === 'consumed') f.alert.components = [];
    if (invalid === 'hierarchy') f.actor.roles.highest.comparePositionTo = () => 0;
    assert.equal(await handleRule8Button(f.button, f.context), true);
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.edits, []);
    assert.match(f.responses[0] ?? '', /approval failed/u);
  });
}

it('restores approval on timeout failure but not on partial deletion failure', async () => {
  const f = fixture();
  f.target.timeout = async () => { throw new Error('Forbidden'); };
  await handleRule8Button(f.button, f.context);
  assert.equal(f.edits[1]?.components.length, 1);
  const partial = fixture();
  partial.message.delete = async () => { throw new Error('Forbidden'); };
  await handleRule8Button(partial.button, partial.context);
  assert.deepEqual(partial.actions, ['timeout']);
  assert.deepEqual(partial.edits[1]?.components, []);
});

it('does not punish if the security record cannot be posted', async () => {
  const f = fixture();
  f.security.send = async () => { throw new Error('Unavailable'); };
  await handleInteraction(f.interaction, f.context);
  assert.deepEqual(f.actions, []);
});

it('retains a report when optional evidence forwarding fails', async () => {
  const f = fixture();
  f.actor.permissions.has = () => false;
  f.message.forward = async () => { throw new Error('Unavailable'); };
  await moderateRule8(f.interaction, f.context);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.actions, []);
});

it('does not punish when consuming the approval fails', async () => {
  const f = fixture();
  f.alert.edit = async () => { throw new Error('Unavailable'); };
  await handleRule8Button(f.button, f.context);
  assert.deepEqual(f.actions, []);
});

it('serializes simultaneous approvals for the same source message', async () => {
  const f = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.target.timeout = async () => {
    f.actions.push('timeout');
    entered.resolve(undefined);
    await release.promise;
  };
  const first = handleRule8Button(f.button, f.context);
  await entered.promise;
  try { await handleRule8Button(f.button, f.context); }
  finally { release.resolve(undefined); }
  await first;
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('approves reports using fetched channels without relying on the channel cache', async () => {
  const f = fixture();
  f.actor.permissionsIn = channel => {
    assert.equal(typeof channel, 'object', 'channel IDs may not be cached after restart');
    return { has: () => true };
  };
  await handleRule8Button(f.button, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('uses a fetched source channel for immediate moderator actions too', async () => {
  const f = fixture();
  f.actor.permissionsIn = channel => {
    assert.equal(typeof channel, 'object');
    return { has: () => true };
  };
  await moderateRule8(f.interaction, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('rejects bot reporters before forwarding or posting evidence', async () => {
  const f = fixture();
  f.raw.user.bot = true;
  f.actor.permissions.has = () => false;
  let forwarded = false;
  f.message.forward = async () => { forwarded = true; };
  await moderateRule8(f.interaction, f.context);
  assert.equal(forwarded, false);
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.actions, []);
});

it('limits concurrent automated bursts but refills for repeated human reports', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const actorId = `burst-${sequence}`;
  function report() {
    const f = fixture();
    f.actor.id = actorId;
    f.raw.user.id = actorId;
    f.actor.permissions.has = () => false;
    return f;
  }
  const burst = Array.from({ length: 8 }, report);
  await Promise.all(burst.map(f => moderateRule8(f.interaction, f.context)));
  assert.equal(burst.reduce((sum, f) => sum + f.reports.length, 0), 5);
  assert.equal(burst.filter(f => f.responses.some(text => /wait/iu.test(text))).length, 3);
  // No accumulating daily quota: a person can keep reporting at a normal pace.
  for (let i = 0; i < 40; i++) {
    now += 2000;
    const f = report();
    await moderateRule8(f.interaction, f.context);
    assert.equal(f.reports.length, 1);
  }
});

it('does not charge duplicate reports against the member burst allowance', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  f.actor.permissions.has = () => false;
  await moderateRule8(f.interaction, f.context);
  for (let i = 0; i < 10; i++) await moderateRule8(f.interaction, f.context);
  assert.equal(f.reports.length, 1);
  for (let i = 0; i < 4; i++) {
    f.message.id = String(sequence++);
    await moderateRule8(f.interaction, f.context);
  }
  assert.equal(f.reports.length, 5);
});

it('does not throttle repeated moderator actions', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    f.message.id = String(sequence++);
    await moderateRule8(f.interaction, f.context);
  }
  assert.equal(f.reports.length, 10);
  assert.equal(f.actions.filter(action => action === 'timeout').length, 10);
});