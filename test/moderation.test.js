import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ButtonStyle, ComponentType, ContainerBuilder, MessageFlags, Collection } from 'discord.js';
import pino from 'pino';
import { handleRuleApproval, handleRuleSelection } from '../src/moderation.js';
import { moderationRules } from '../src/moderation-rules.js';
import { handleInteraction } from '../src/bot.js';
import command from '../src/commands/definitions/report-rule.js';

let sequence = 10000000000000000n;
/** @typedef {{components: import('discord.js').APIContainerComponent[], flags?: number, allowedMentions?: {parse: string[]}}} CardPayload */
/** @param {CardPayload | undefined} payload */
function cardText(payload) {
  return payload?.components.flatMap(card => card.components.filter(item => item.type === ComponentType.TextDisplay)
    .map(item => item.content)).join('\n') ?? '';
}
/** @param {CardPayload | undefined} payload */
function cardButtons(payload) {
  return payload?.components.flatMap(card => card.components.filter(item => item.type === ComponentType.ActionRow)
    .flatMap(row => row.components)) ?? [];
}

function fixture() {
  /** @type {string[]} */
  const actions = [];
  /** @type {string[]} */
  const responses = [];
  /** @type {import('discord.js').InteractionReplyOptions[]} */
  const replyPayloads = [];
  const target = { id: '20000000000000000', guild: { id: 'guild' }, moderatable: true, communicationDisabledUntilTimestamp: 0,
    roles: { highest: {} },
    timeout: async (/** @type {number} */ duration, /** @type {string} */ reason) => {
      assert.equal(duration, 86_400_000);
      assert.equal(reason, 'Rule 8 (Read Pins)');
      actions.push('timeout');
    } };
  const actor = { id: `actor-${sequence}`, permissions: { has: () => true },
    permissionsIn: (/** @type {import('discord.js').GuildChannelResolvable} */ channel) => ({ has: () => Boolean(channel) }),
    roles: { highest: { comparePositionTo: () => 1 } } };
  /** @type {CardPayload[]} */
  const reports = [];
  /** @type {CardPayload[]} */
  const edits = [];
  const message = { id: String(sequence++), channelId: '30000000000000000', author: { id: target.id, bot: false },
    content: 'Please help with this message', attachments: new Collection(),
    forward: /** @returns {Promise<void>} */ async () => { throw new Error('Reports must use a card, not forwarding'); },
    deletable: true, delete: async () => { actions.push('delete'); } };
  const customId = `rules:accept:8:${message.channelId}:${message.id}:${target.id}`;
  const alert = { id: 'alert', content: 'Report: Rule 8 (Read Pins)', author: { id: 'bot' },
    components: [new ContainerBuilder({ type: ComponentType.Container, components: [
      { type: ComponentType.TextDisplay, id: 3, content: 'Saved evidence' },
      { type: ComponentType.TextDisplay, id: 4, content: 'Reported by a member' },
      { type: ComponentType.TextDisplay, id: 5, content: 'Pending moderator approval.' },
      { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Danger,
        label: 'Accept: delete + 24h timeout', custom_id: customId, disabled: false }] },
    ] })],
    edit: async (/** @type {CardPayload} */ value) => {
      edits.push(value);
      alert.components = value.components.map(card => new ContainerBuilder(card));
      return alert;
    },
    fetch: async (/** @type {boolean} */ force) => { assert.equal(force, true); return alert; } };
  const security = { id: 'security', guildId: 'guild', isSendable: () => true,
    send: async (/** @type {CardPayload} */ value) => {
      assert.equal(value.flags, MessageFlags.IsComponentsV2);
      assert.equal('content' in value, false);
      assert.deepEqual(value.allowedMentions, { parse: [] });
      reports.push(value);
      alert.components = value.components.map(card => new ContainerBuilder(card));
      return alert;
    } };
  const source = { isTextBased: () => true, messages: { fetch: async () => message } };
  const raw = { commandName: command.data.name, guildId: 'guild', user: { id: actor.id, bot: false },
    guild: { id: 'guild', ownerId: 'owner', channels: { fetch: async (/** @type {string} */ id) => id === 'security' ? security : source }, members: {
      fetch: async (/** @type {{user: string, force: boolean}} */ options) => {
        assert.equal(options.force, true);
        return options.user === actor.id ? actor : target;
      }, fetchMe: async () => ({}),
    } }, targetMessage: message, isChatInputCommand: () => false, isMessageContextMenuCommand: () => true,
    deferReply: async (/** @type {{flags: number}} */ options) => { assert.equal(options.flags, MessageFlags.Ephemeral); },
    reply: async (/** @type {import('discord.js').InteractionReplyOptions} */ options) => { replyPayloads.push(options); responses.push(options.content ?? ''); },
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
    button, buttonRaw, reports, edits, alert, security, replyPayloads };
}

it('registers Report Rule Violation for all guild members', () => {
  assert.equal(command.data.toJSON().type, 3);
  assert.equal(command.data.name, 'Report Rule Violation');
  assert.equal(command.data.toJSON().default_member_permissions, null);
});

it('routes a rule selection for a non-owner moderator and times out before deleting', async () => {
  const f = fixture();
  await report(f);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
  assert.match(f.responses[0] ?? '', /Message deleted.*Rule 8/u);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(cardButtons(f.reports[0]), []);
  assert.match(cardText(f.edits[0]), /Message deleted/u);
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
    await report(f);
    assert.deepEqual(f.actions, []);
    assert.equal(f.responses.length, 1);
  });
}

it('allows the guild owner to bypass actor hierarchy, but not bot hierarchy', async () => {
  const f = fixture();
  f.raw.guild.ownerId = f.actor.id;
  f.actor.roles.highest.comparePositionTo = () => -1;
  await report(f);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('does not shorten a longer existing timeout', async () => {
  const f = fixture();
  f.target.communicationDisabledUntilTimestamp = Date.now() + 172_800_000;
  await report(f);
  assert.deepEqual(f.actions, ['delete']);
});

it('does not delete when timeout fails', async () => {
  const f = fixture();
  f.target.timeout = async () => { throw new Error('Forbidden'); };
  await report(f);
  assert.deepEqual(f.actions, []);
  assert.match(f.responses[0] ?? '', /timeout failed.*not deleted/u);
});

it('reports the applied timeout when deletion fails', async () => {
  const f = fixture();
  f.message.delete = async () => { throw new Error('Forbidden'); };
  await report(f);
  assert.deepEqual(f.actions, ['timeout']);
  assert.match(f.responses[0] ?? '', /timed out.*deletion failed/u);
});

it('sends a member report with an approval button without punishment, deduplicating repeats', async () => {
  const f = fixture();
  f.actor.permissions.has = () => false;
  await report(f);
  assert.deepEqual(f.actions, []);
  assert.equal(f.reports.length, 1);
  assert.match(JSON.stringify(f.reports), /Accept: delete \+ 24h timeout/u);
  assert.match(f.responses[0] ?? '', /sent to security/u);
  await report(f);
  assert.equal(f.reports.length, 1);
});

it('routes a security approval and consumes its button before performing moderation', async () => {
  const f = fixture();
  f.target.timeout = async () => {
    assert.deepEqual(cardButtons(f.edits[0]), []);
    f.actions.push('timeout');
  };
  await handleInteraction(f.button, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
  assert.match(cardText(f.edits[1]), /Moderator:.*actor/u);
  assert.deepEqual(cardButtons(f.edits[1]), []);
  assert.match(cardText(f.edits[1]), /Saved evidence/u);
  assert.match(cardText(f.edits[1]), /Reported by a member/u);
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
    assert.equal(await handleRuleApproval(f.button, f.context), true);
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.edits, []);
    assert.match(f.responses[0] ?? '', /approval failed/u);
  });
}

it('restores approval on timeout failure but not on partial deletion failure', async () => {
  const f = fixture();
  f.target.timeout = async () => { throw new Error('Forbidden'); };
  await handleRuleApproval(f.button, f.context);
  assert.equal(cardButtons(f.edits[1]).length, 1);
  const partial = fixture();
  partial.message.delete = async () => { throw new Error('Forbidden'); };
  await handleRuleApproval(partial.button, partial.context);
  assert.deepEqual(partial.actions, ['timeout']);
  assert.deepEqual(cardButtons(partial.edits[1]), []);
});

it('does not punish if the security record cannot be posted', async () => {
  const f = fixture();
  f.security.send = async () => { throw new Error('Unavailable'); };
  await report(f);
  assert.deepEqual(f.actions, []);
});

it('renders evidence and reporter attribution inside a card without forwarding', async () => {
  const f = fixture();
  f.actor.permissions.has = () => false;
  f.message.content = '**untrusted** @everyone';
  let forwarded = false;
  f.message.forward = async () => { forwarded = true; };
  const selection = await openSelection(f, '4');
  await handleRuleSelection(selection.interaction, f.context);
  assert.equal(f.reports.length, 1);
  assert.match(cardText(f.reports[0]), /Report: Rule 4 \(Piracy\)/u);
  assert.ok(cardText(f.reports[0]).includes('\\*\\*untrusted\\*\\* @\u200beveryone'));
  assert.ok(cardText(f.reports[0]).includes(`<@${f.actor.id}> — Rule 4`));
  assert.deepEqual(f.actions, []);
  assert.equal(forwarded, false);
});

it('does not punish when consuming the approval fails', async () => {
  const f = fixture();
  f.alert.edit = async () => { throw new Error('Unavailable'); };
  await handleRuleApproval(f.button, f.context);
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
  const first = handleRuleApproval(f.button, f.context);
  await entered.promise;
  try { await handleRuleApproval(f.button, f.context); }
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
  await handleRuleApproval(f.button, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('uses a fetched source channel for immediate moderator actions too', async () => {
  const f = fixture();
  f.actor.permissionsIn = channel => {
    assert.equal(typeof channel, 'object');
    return { has: () => true };
  };
  await report(f);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('rejects bot reporters before forwarding or posting evidence', async () => {
  const f = fixture();
  f.raw.user.bot = true;
  f.actor.permissions.has = () => false;
  let forwarded = false;
  f.message.forward = async () => { forwarded = true; };
  await report(f);
  assert.equal(forwarded, false);
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.actions, []);
});

it('limits automated bursts but refills for repeated human reports', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const actorId = `burst-${sequence}`;
  function memberFixture() {
    const f = fixture();
    f.actor.id = actorId;
    f.raw.user.id = actorId;
    f.actor.permissions.has = () => false;
    return f;
  }
  const burst = Array.from({ length: 8 }, memberFixture);
  // One active menu per member: submit each before opening the next, at the same mocked time.
  for (const f of burst) await report(f);
  assert.equal(burst.reduce((sum, f) => sum + f.reports.length, 0), 5);
  assert.equal(burst.filter(f => f.responses.some(text => /wait/iu.test(text))).length, 3);
  // No accumulating daily quota: a person can keep reporting at a normal pace.
  for (let i = 0; i < 40; i++) {
    now += 2000;
    const f = memberFixture();
    await report(f);
    assert.equal(f.reports.length, 1);
  }
});

it('does not charge duplicate reports against the member burst allowance', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  f.actor.permissions.has = () => false;
  await report(f);
  for (let i = 0; i < 10; i++) await report(f);
  assert.equal(f.reports.length, 1);
  for (let i = 0; i < 4; i++) {
    f.message.id = String(sequence++);
    await report(f);
  }
  assert.equal(f.reports.length, 5);
});

it('does not throttle repeated moderator actions', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    f.message.id = String(sequence++);
    await report(f);
  }
  assert.equal(f.reports.length, 10);
  assert.equal(f.actions.filter(action => action === 'timeout').length, 10);
});

/** Submit through the actual command and dropdown, retaining only the action response.
 * @param {ReturnType<typeof fixture>} f */
async function report(f) {
  await handleInteraction(f.interaction, f.context);
  if (!f.replyPayloads.at(-1)?.components) return;
  f.responses.length = 0;
  await handleInteraction(selectionFromReply(f, '8').interaction, f.context);
}

/** @param {ReturnType<typeof fixture>} f @param {string} ruleId */
async function openSelection(f, ruleId) {
  f.raw.commandName = command.data.name;
  await handleInteraction(f.interaction, f.context);
  return selectionFromReply(f, ruleId);
}

/** @param {ReturnType<typeof fixture>} f @param {string} ruleId */
function selectionFromReply(f, ruleId) {
  const rows = /** @type {import('discord.js').APIActionRowComponent<import('discord.js').APIStringSelectComponent>[]} */ (
    JSON.parse(JSON.stringify(f.replyPayloads.at(-1)?.components)));
  const raw = { ...f.buttonRaw, customId: rows[0]?.components[0]?.custom_id ?? '', values: [ruleId],
    deferred: true, isButton: () => false, isStringSelectMenu: () => true };
  const interaction = /** @type {import('discord.js').StringSelectMenuInteraction} */ (/** @type {unknown} */ (raw));
  return { raw, interaction, menu: rows[0]?.components[0] };
}

it('opens a private dropdown listing all nine rules without moderating or reporting', async () => {
  const f = fixture();
  const selection = await openSelection(f, '8');
  assert.equal(f.replyPayloads[0]?.flags, MessageFlags.Ephemeral);
  assert.equal(selection.menu?.min_values, 1);
  assert.equal(selection.menu?.max_values, 1);
  assert.deepEqual(selection.menu?.options.map(option => option.label), moderationRules.map(rule => rule.label));
  assert.equal(selection.menu?.options.length, 9);
  assert.equal(selection.menu?.options[7]?.label, 'Rule 8 (Read Pins)');
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.reports, []);
});

for (const rule of moderationRules) {
  it(`moderators selecting ${rule.label} apply its audit reason for 24 hours`, async () => {
    const f = fixture();
    f.target.timeout = async (duration, reason) => {
      assert.equal(duration, 86_400_000);
      assert.equal(reason, rule.label);
      f.actions.push('timeout');
    };
    const selection = await openSelection(f, rule.id);
    await handleInteraction(selection.interaction, f.context);
    assert.deepEqual(f.actions, ['timeout', 'delete']);
    assert.ok(cardText(f.reports[0]).includes(rule.label));
    assert.ok(cardText(f.reports[0]).includes(rule.text));
    assert.deepEqual(cardButtons(f.reports[0]), []);
    await handleRuleSelection(selection.interaction, f.context);
    assert.deepEqual(f.actions, ['timeout', 'delete'], 'consumed menus cannot replay');
  });

  it(`members report ${rule.label} and moderators approve the same rule`, async () => {
    const f = fixture();
    f.actor.permissions.has = () => false;
    const selection = await openSelection(f, rule.id);
    await handleRuleSelection(selection.interaction, f.context);
    assert.deepEqual(f.actions, []);
    assert.ok(cardText(f.reports[0]).includes(rule.label));
    const button = cardButtons(f.reports[0])[0];
    f.buttonRaw.customId = button && 'custom_id' in button ? button.custom_id : '';
    f.actor.permissions.has = () => true;
    f.target.timeout = async (duration, reason) => {
      assert.equal(duration, 86_400_000);
      assert.equal(reason, rule.label);
      f.actions.push('timeout');
    };
    await handleInteraction(f.button, f.context);
    assert.deepEqual(f.actions, ['timeout', 'delete']);
  });
}

for (const invalid of ['actor', 'guild', 'bot', 'rule', 'multiple', 'author', 'expired']) {
  it(`rejects ${invalid} rule selections without side effects`, async t => {
    const f = fixture();
    const selection = await openSelection(f, '8');
    if (invalid === 'actor') selection.raw.user = { id: 'someone-else', bot: false };
    if (invalid === 'guild') selection.raw.guildId = 'other';
    if (invalid === 'bot') selection.raw.user = { id: f.actor.id, bot: true };
    if (invalid === 'rule') selection.raw.values = ['10'];
    if (invalid === 'multiple') selection.raw.values = ['1', '2'];
    if (invalid === 'author') selection.raw.message.author.id = 'other';
    if (invalid === 'expired') { const now = Date.now(); t.mock.method(Date, 'now', () => now + 300_001); }
    await handleRuleSelection(selection.interaction, f.context);
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.reports, []);
    assert.match(f.responses.at(-1) ?? '', /invalid, expired/u);
  });
}

it('does not route the removed Rule 8 command or approval prefix', async () => {
  const f = fixture();
  f.raw.commandName = 'Report: Rule 8';
  await handleInteraction(f.interaction, f.context);
  f.buttonRaw.customId = `rule8:accept:${f.message.channelId}:${f.message.id}:${f.target.id}`;
  assert.equal(await handleRuleApproval(f.button, f.context), false);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.reports, []);
  assert.equal(f.replyPayloads.length, 1);
  assert.equal(f.replyPayloads[0]?.components, undefined);
  assert.match(f.responses[0] ?? '', /restricted/u);
});

it('rejects rule approvals with an unsupported rule ID', async () => {
  const f = fixture();
  f.buttonRaw.customId = `rules:accept:10:${f.message.channelId}:${f.message.id}:${f.target.id}`;
  await handleRuleApproval(f.button, f.context);
  assert.deepEqual(f.actions, []);
});

it('replaces the previous menu when the same member opens another', async () => {
  const f = fixture();
  const old = await openSelection(f, '8');
  const current = await openSelection(f, '4');
  await handleRuleSelection(old.interaction, f.context);
  assert.deepEqual(f.actions, []);
  f.target.timeout = async (duration, reason) => {
    assert.equal(duration, 86_400_000);
    assert.equal(reason, 'Rule 4 (Piracy)');
    f.actions.push('timeout');
  };
  await handleRuleSelection(current.interaction, f.context);
  assert.deepEqual(f.actions, ['timeout', 'delete']);
});

it('does not let a different member consume the original reporter menu', async () => {
  const f = fixture();
  f.actor.permissions.has = () => false;
  const selection = await openSelection(f, '9');
  selection.raw.user = { id: 'someone-else', bot: false };
  await handleRuleSelection(selection.interaction, f.context);
  assert.deepEqual(f.reports, []);
  selection.raw.user = f.raw.user;
  await handleRuleSelection(selection.interaction, f.context);
  assert.equal(f.reports.length, 1);
});

it('consumes a menu atomically before concurrent selections can report twice', async () => {
  const f = fixture();
  f.actor.permissions.has = () => false;
  const selection = await openSelection(f, '2');
  await Promise.all([handleRuleSelection(selection.interaction, f.context), handleRuleSelection(selection.interaction, f.context)]);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.actions, []);
});

it('rejects a mismatched source author when resolving a rule menu', async () => {
  const f = fixture();
  const selection = await openSelection(f, '3');
  f.message.author.id = 'changed-author';
  await handleRuleSelection(selection.interaction, f.context);
  assert.deepEqual(f.reports, []);
  assert.deepEqual(f.actions, []);
});

/** @param {ReturnType<typeof fixture>} first */
function anotherReporter(first) {
  const next = fixture();
  next.message.id = first.message.id;
  next.actor.permissions.has = () => false;
  return next;
}

it('updates one card with unique reporters and their rules without changing the approval reason', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  await report(first);
  const second = anotherReporter(first);
  const selection = await openSelection(second, '4');
  await handleRuleSelection(selection.interaction, second.context);
  assert.equal(first.reports.length, 1);
  assert.equal(second.reports.length, 0);
  assert.match(cardText(first.edits.at(-1)), /Reported by \(2\)/u);
  assert.ok(cardText(first.edits.at(-1)).includes(`<@${first.actor.id}> — Rule 8`));
  assert.ok(cardText(first.edits.at(-1)).includes(`<@${second.actor.id}> — Rule 4`));
  const button = cardButtons(first.edits.at(-1))[0];
  assert.ok(button && 'custom_id' in button && button.custom_id.startsWith('rules:accept:8:'));
  const extra = await openSelection(second, '9');
  await handleRuleSelection(extra.interaction, second.context);
  assert.ok(cardText(first.edits.at(-1)).includes(`<@${second.actor.id}> — Rule 4, 9`));
  assert.match(cardText(first.edits.at(-1)), /Reported by \(2\)/u);
  const edits = first.edits.length;
  const duplicate = await openSelection(second, '9');
  await handleRuleSelection(duplicate.interaction, second.context);
  assert.equal(first.edits.length, edits);
  assert.match(second.responses.at(-1) ?? '', /already included/u);
});

it('serializes concurrent reporters without dropping either attribution or posting twice', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  const second = anotherReporter(first);
  const a = await openSelection(first, '8');
  const b = await openSelection(second, '4');
  await Promise.all([handleRuleSelection(a.interaction, first.context), handleRuleSelection(b.interaction, second.context)]);
  assert.equal(first.reports.length + second.reports.length, 1);
  const owner = first.reports.length ? first : second;
  assert.match(cardText(owner.edits.at(-1)), /Reported by \(2\)/u);
  assert.ok(cardText(owner.edits.at(-1)).includes(`<@${first.actor.id}>`));
  assert.ok(cardText(owner.edits.at(-1)).includes(`<@${second.actor.id}>`));
});

it('does not mark a reporter included when editing the shared card fails', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  await report(first);
  const second = anotherReporter(first);
  const edit = first.alert.edit;
  first.alert.edit = async () => { throw new Error('Unavailable'); };
  await report(second);
  assert.match(second.responses.at(-1) ?? '', /action failed/u);
  first.alert.edit = edit;
  await report(second);
  assert.match(cardText(first.edits.at(-1)), /Reported by \(2\)/u);
  assert.equal(second.reports.length, 0);
});

it('retains the preview and all reporters when a moderator acts on an existing card', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  await report(first);
  const moderator = anotherReporter(first);
  moderator.actor.permissions.has = () => true;
  await report(moderator);
  assert.equal(moderator.reports.length, 0);
  assert.deepEqual(moderator.actions, ['timeout', 'delete']);
  assert.match(cardText(first.edits.at(-1)), /Reported by \(2\)/u);
  assert.match(cardText(first.edits.at(-1)), /Please help with this message/u);
  assert.match(cardText(first.edits.at(-1)), /Message deleted/u);
  assert.deepEqual(cardButtons(first.edits.at(-1)), []);
});

it('does not restore a consumed approval when another reporter updates the card', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  await report(first);
  first.actor.permissions.has = () => true;
  first.message.delete = async () => { throw new Error('Forbidden'); };
  await handleRuleApproval(first.button, first.context);
  const second = anotherReporter(first);
  await report(second);
  assert.deepEqual(cardButtons(first.edits.at(-1)), []);
  assert.match(cardText(first.edits.at(-1)), /deletion failed/u);
  assert.match(cardText(first.edits.at(-1)), /Reported by \(2\)/u);
});

it('includes an image gallery and bounds hostile message previews and large reporter lists', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  first.message.content = '*'.repeat(10000);
  first.message.attachments.set('image', { contentType: 'image/png', url: 'https://cdn.discordapp.com/image.png', spoiler: true });
  await report(first);
  const gallery = first.reports[0]?.components[0]?.components.find(item => item.type === ComponentType.MediaGallery);
  assert.equal(gallery?.items[0]?.media.url, 'https://cdn.discordapp.com/image.png');
  assert.equal(gallery?.items[0]?.spoiler, true);
  for (let i = 0; i < 45; i++) await report(anotherReporter(first));
  assert.match(cardText(first.edits.at(-1)), /Reported by \(46\)/u);
  assert.match(cardText(first.edits.at(-1)), /more reporters/u);
  assert.ok(cardText(first.edits.at(-1)).length <= 4000);
  assert.equal(first.reports.length, 1);
});

it('does not replay moderation when two moderators submit the same source concurrently', async () => {
  const first = fixture();
  const second = anotherReporter(first);
  second.actor.permissions.has = () => true;
  let deleted = false;
  let timeouts = 0;
  for (const f of [first, second]) {
    const fetch = f.raw.guild.channels.fetch;
    f.raw.guild.channels.fetch = async id => {
      const channel = await fetch(id);
      if ('messages' in channel) channel.messages.fetch = async () => {
        if (deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return f.message;
      };
      return channel;
    };
    f.target.timeout = async () => { timeouts++; };
    f.message.delete = async () => {
      if (deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      deleted = true;
    };
  }
  const a = await openSelection(first, '8');
  const b = await openSelection(second, '8');
  await Promise.all([handleRuleSelection(a.interaction, first.context), handleRuleSelection(b.interaction, second.context)]);
  assert.equal(timeouts, 1);
  assert.equal(deleted, true);
  assert.match(cardText(first.edits.at(-1)), /Message deleted/u);
  assert.doesNotMatch(cardText(first.edits.at(-1)), /deletion failed/u);
});

it('does not repeat a completed timeout after partial deletion failure through a new menu', async () => {
  const f = fixture();
  f.message.delete = async () => { throw new Error('Forbidden'); };
  await report(f);
  const edits = f.edits.length;
  await report(f);
  assert.deepEqual(f.actions, ['timeout']);
  assert.equal(f.edits.length, edits);
  assert.match(f.responses.at(-1) ?? '', /already.*handled/iu);
});

for (const kind of ['same reporter', 'new reporter', 'moderator']) {
  it(`recreates a deleted security card for a ${kind}`, async () => {
    const first = fixture();
    first.actor.permissions.has = () => false;
    await report(first);
    first.alert.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
    const next = kind === 'same reporter' ? first : anotherReporter(first);
    if (kind === 'moderator') next.actor.permissions.has = () => true;
    await report(next);
    assert.equal(next.reports.length, kind === 'same reporter' ? 2 : 1);
    assert.ok(cardText(next.reports.at(-1)).includes(`<@${first.actor.id}>`));
    assert.ok(cardText(next.reports.at(-1)).includes(`<@${next.actor.id}>`));
    assert.deepEqual(next.actions, kind === 'moderator' ? ['timeout', 'delete'] : []);
  });
}

for (const code of [50013, 50001, 503]) {
  it(`does not recreate cards when fetching fails with ${code}`, async () => {
    const first = fixture();
    first.actor.permissions.has = () => false;
    await report(first);
    const fetch = first.alert.fetch;
    first.alert.fetch = async () => { throw Object.assign(new Error('Unavailable'), { code }); };
    const second = anotherReporter(first);
    await report(second);
    assert.equal(second.reports.length, 0);
    assert.match(second.responses.at(-1) ?? '', /action failed/u);
    first.alert.fetch = fetch;
    await report(second);
    assert.equal(second.reports.length, 0);
    assert.match(cardText(first.edits.at(-1)), /Reported by \(2\)/u);
  });
}

it('preserves original attribution and approval reason when replacing a deleted card after a failed send', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  await report(first);
  first.alert.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
  const second = anotherReporter(first);
  const send = second.security.send;
  second.security.send = async () => { throw new Error('Unavailable'); };
  await report(second);
  assert.equal(second.reports.length, 0);
  second.security.send = send;
  const selection = await openSelection(second, '4');
  await handleRuleSelection(selection.interaction, second.context);
  assert.equal(second.reports.length, 1);
  assert.ok(cardText(second.reports[0]).includes(`<@${first.actor.id}> — Rule 8`));
  assert.ok(cardText(second.reports[0]).includes(`<@${second.actor.id}> — Rule 4`));
  const button = cardButtons(second.reports[0])[0];
  assert.ok(button && 'custom_id' in button && button.custom_id.startsWith('rules:accept:8:'));
});

it('does not revive completed moderation when its card is deleted after an approval', async () => {
  const first = fixture();
  first.actor.permissions.has = () => false;
  await report(first);
  first.actor.permissions.has = () => true;
  first.message.delete = async () => { throw new Error('Forbidden'); };
  await handleRuleApproval(first.button, first.context);
  first.alert.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
  const second = anotherReporter(first);
  await report(second);
  assert.equal(second.reports.length, 1);
  assert.deepEqual(cardButtons(second.reports[0]), []);
  assert.match(cardText(second.reports[0]), /already handled/u);
  second.actor.permissions.has = () => true;
  await report(second);
  assert.deepEqual(second.actions, []);
  assert.match(second.responses.at(-1) ?? '', /already.*handled/iu);
});