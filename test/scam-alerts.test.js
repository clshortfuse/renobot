import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { AuditLogEvent, Collection, ComponentType, MessageFlags } from 'discord.js';
import { createScamAlerts, securityCard } from '../src/scam-alerts.js';

const guildId = '1408098019194310818';
const channelId = '1408098019726983282';
const securityId = '1408259940908531915';
const messageId = '1561718663663460473';
const userId = '148572660886929409';

function fixture() {
  const state = { banned: false, banPermission: true, actorPermission: true, botPermission: true, hierarchy: true,
    missingMember: false, deleted: false, banCount: 0, deleteCount: 0, forwards: 0, forwardFails: true, forwardError: 50013,
    editFails: false, uploadFails: false, banDuringForward: false, actorId: 'moderator', banReason: '', auditPermission: true };
  /** @type {Collection<string, {targetId: string, executorId: string | null, reason: string | null, action: number, createdTimestamp?: number}>} */
  const auditEntries = new Collection();
  /** @type {import('discord.js').MessageCreateOptions[]} */
  const sent = [];
  /** @type {import('discord.js').MessageEditOptions[]} */
  const edited = [];
  /** @type {(string | import('discord.js').InteractionEditReplyOptions)[]} */
  const replies = [];
  /** @type {import('discord.js').APIContainerComponent} */
  let card;
  /** @param {import('discord.js').MessageEditOptions | import('discord.js').MessageCreateOptions} payload */
  function capture(payload) {
    const component = payload.components?.[0];
    assert.ok(component);
    const json = 'toJSON' in component ? component.toJSON() : component;
    assert.equal(json.type, ComponentType.Container);
    card = structuredClone(/** @type {import('discord.js').APIContainerComponent} */ (json));
    /** @type {{id?: number}[]} */
    const components = [card, ...card.components, ...card.components.flatMap(item => item.type === ComponentType.ActionRow ? item.components : [])];
    const explicit = components.map(item => item.id).filter(id => id !== undefined && id !== 0);
    assert.equal(new Set(explicit).size, explicit.length, 'Discord requires unique component IDs');
    const used = new Set(explicit);
    let next = 1;
    for (const item of components) {
      if (item.id) continue;
      while (used.has(next)) next++;
      item.id = next;
      used.add(next++);
    }
  }
  const alert = { id: 'alert', guildId, author: { id: 'bot' }, get components() { return [{ toJSON: () => card }]; },
    async edit(/** @type {import('discord.js').MessageEditOptions} */ payload) {
      if (state.editFails) throw new Error('Alert unavailable');
      if (state.uploadFails && payload.files?.length) throw new Error('Attachment upload failed');
      edited.push(payload);
      capture(payload);
      return alert;
    } };
  const actor = { id: 'moderator', permissions: { has: () => state.actorPermission },
    permissionsIn: () => ({ has: () => state.actorPermission }), roles: { highest: { comparePositionTo: () => state.hierarchy ? 1 : -1 } } };
  const bot = { id: 'bot', permissions: { has: () => state.botPermission }, permissionsIn: () => ({ has: () => state.botPermission }) };
  const source = { id: channelId, isTextBased: () => true, messages: { fetch: async () => {
    if (state.deleted) throw { code: 10008 };
    return { id: messageId, channelId, author: { id: userId }, delete: async () => { state.deleteCount++; state.deleted = true; } };
  } } };
  const guild = { id: guildId, ownerId: 'owner', channels: { fetch: async () => source },
    fetchAuditLogs: async () => {
      if (!state.auditPermission) throw { code: 50013 };
      return { entries: auditEntries };
    },
    bans: { fetch: async () => {
      if (!state.banPermission) throw { code: 50013 };
      if (!state.banned) throw { code: 10026 };
      return { reason: state.banReason || null };
    } },
    members: { fetchMe: async () => bot, fetch: async (/** @type {{user: string}} */ options) => {
      if (options.user === state.actorId) return actor;
      if (state.missingMember) throw { code: 10007 };
      return { bannable: state.hierarchy, roles: { highest: {} } };
    }, ban: async (/** @type {string} */ id, /** @type {{deleteMessageSeconds: number}} */ options) => {
      assert.equal(id, userId);
      assert.equal(options.deleteMessageSeconds, 0);
      state.banCount++; state.banned = true;
    } } };
  const client = { user: { id: 'bot' }, channels: { fetch: async () => ({ id: securityId, guildId, isSendable: () => true,
    send: async (/** @type {import('discord.js').MessageCreateOptions} */ payload) => {
      assert.ok(state.forwards > 0 || state.deleted);
      sent.push(payload);
      capture(payload);
      if (state.banDuringForward) state.banned = true;
      return alert;
    } }) } };
  const service = createScamAlerts(/** @type {import('discord.js').Client} */ (/** @type {unknown} */ (client)),
    /** @type {import('../src/commands/command.js').CommandContext} */ (/** @type {unknown} */ ({ guildId, securityChannelId: securityId, logger: pino({ level: 'silent' }) })));
  const message = /** @type {import('discord.js').Message} */ (/** @type {unknown} */ ({ id: messageId, guildId, channelId, guild,
    author: { id: userId, username: 'example_user', globalName: 'Example User' }, url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
    forward: async () => {
      state.forwards++;
      if (state.banDuringForward) state.banned = true;
      if (state.forwardFails) throw { code: state.forwardError };
    } }));
  async function send() { await service.send({ message, reason: 'Known scam domain', image: Buffer.from('image') }); }
  /** @param {string} action @param {Record<string, unknown>} [overrides] */
  async function click(action, overrides = {}) {
    return service.handle(/** @type {import('discord.js').BaseInteraction} */ (/** @type {unknown} */ ({
      isButton: () => true, customId: action.startsWith('scam:') ? action : `scam:${action}:${channelId}:${messageId}:${userId}`,
      guildId, channelId: securityId, guild, user: { id: state.actorId }, message: alert,
      deferReply: async () => {}, editReply: async (/** @type {string | import('discord.js').InteractionEditReplyOptions} */ payload) => { replies.push(payload); },
      ...overrides,
    })));
  }
  function confirmation() {
    const reply = replies.at(-1);
    assert.ok(reply && typeof reply !== 'string');
    const component = reply.components?.[0];
    assert.ok(component && 'toJSON' in component);
    const row = component.toJSON();
    assert.ok('components' in row);
    const button = row.components[0];
    assert.ok(button && 'custom_id' in button);
    return button.custom_id;
  }
  /** @param {number} id */
  function text(id) {
    const item = card.components.find((item) => item.id === id);
    return item?.type === ComponentType.TextDisplay ? item.content : '';
  }
  /** @param {string} label */
  function disabled(label) {
    const row = card.components.find(item => item.type === ComponentType.ActionRow);
    return row?.components.find(item => item.type === ComponentType.Button && 'label' in item && item.label === label)?.disabled;
  }
  return { state, sent, edited, replies, alert, guild, message, service, send, click, confirmation, text, auditEntries, disabled };
}

test('single V2 card orders identity, evidence, direct link and actions without redundant labels', async () => {
  const f = fixture();
  await f.send();
  assert.equal(f.sent[0]?.flags, MessageFlags.IsComponentsV2);
  assert.equal(f.sent[0]?.embeds, undefined);
  assert.equal(f.sent[0]?.content, undefined);
  assert.equal(f.sent[0]?.components?.length, 1);
  assert.deepEqual(f.alert.components[0]?.toJSON().components.map((item) => item.type), [10, 10, 12, 10, 1]);
  assert.equal(f.alert.components[0]?.toJSON().components[0]?.id, 3);
  assert.equal(f.text(3), '**Known scam domain**');
  assert.doesNotMatch(f.text(2), /Known scam domain/u);
  assert.match(JSON.stringify(f.sent[0]), /attachment:\/\/evidence.png/u);
  assert.equal(f.text(1), `<@${userId}> · Not banned`);
  assert.equal(f.state.forwards, 1);
  assert.equal(f.sent[0]?.files?.length, 1);
  assert.deepEqual(f.sent[0]?.allowedMentions, { parse: [] });
  const json = JSON.stringify(f.sent[0]);
  assert.doesNotMatch(json, /SHA-256|timeout|instant-withdrawal/u);
  assert.match(json, /Delete message/u);
  assert.match(json, /Ban user/u);
  assert.doesNotMatch(JSON.stringify(f.sent[0]?.components), /Open message/u);
  assert.match(f.text(2), /^https:\/\/discord\.com\/channels\//u);
  assert.doesNotMatch(json, /"name":"Source"|Ban status:|Message status:/u);
});

test('missing evidence is explicit and its reason precedes the message link', () => {
  const card = securityCard({ target: { channelId, messageId, userId }, guildId, state: 'Already banned', reason: 'Known scam domain' });
  const evidence = card.components[2];
  assert.equal(evidence?.type, ComponentType.TextDisplay);
  assert.ok(evidence && 'content' in evidence);
  assert.equal(evidence.content, 'Image unavailable');
  const source = card.components[3];
  assert.ok(source && 'content' in source);
  assert.equal(source.content, `https://discord.com/channels/${guildId}/${channelId}/${messageId}`);
});

test('deleted source does not lose alert image; already banned users have disabled Ban', async () => {
  const f = fixture();
  f.state.banned = true; f.state.forwardError = 10008;
  await f.send();
  assert.equal(f.sent.length, 1);
  assert.equal(f.text(1), `<@${userId}> · Banned`);
  assert.match(f.text(2), /\(deleted\)$/u);
  assert.match(JSON.stringify(f.sent[0]), /"disabled":true/u);
});

test('missing ban lookup permission is unknown, not unbanned, and blocks ban', async () => {
  const f = fixture();
  f.state.banPermission = false;
  await f.send();
  await f.click('ban');
  assert.match(JSON.stringify(f.sent[0]), /unknown/u);
  assert.match(JSON.stringify(f.replies.at(-1)), /Ban Members/u);
  assert.equal(f.state.banCount, 0);
});

test('actions require valid context and fresh moderator and bot permissions', async () => {
  for (const action of ['delete', 'ban']) {
    for (const denied of ['actorPermission', 'botPermission']) {
      const f = fixture();
      await f.send();
      if (denied === 'actorPermission') f.state.actorPermission = false;
      else f.state.botPermission = false;
      await f.click(action);
      assert.match(JSON.stringify(f.replies.at(-1)), /Action not completed/u);
      assert.equal(f.state.banCount + f.state.deleteCount, 0);
    }
  }
  const f = fixture(); await f.send();
  await f.click('ban', { guildId: 'foreign' });
  await f.click('delete', { channelId: 'foreign' });
  await f.click('ban', { message: { author: { id: 'foreign' } } });
  assert.ok(f.replies.every((reply) => JSON.stringify(reply).includes('Invalid security alert context')));
});

test('ban confirmation is actor-bound and single-use and does not bulk-delete', async () => {
  const f = fixture(); await f.send();
  await f.click('ban');
  assert.equal(f.state.banCount, 0);
  const confirmation = f.confirmation();
  await f.click(confirmation, { user: { id: 'different' } });
  assert.equal(f.state.banCount, 0);
  await f.click(confirmation);
  assert.equal(f.state.banCount, 1);
  await f.click(confirmation);
  assert.equal(f.state.banCount, 1);
});

test('confirmation rechecks permissions and hierarchy', async () => {
  for (const mode of ['permissions', 'hierarchy']) {
    const f = fixture(); await f.send(); await f.click('ban');
    const confirmation = f.confirmation();
    if (mode === 'permissions') f.state.actorPermission = false;
    else f.state.hierarchy = false;
    await f.click(confirmation);
    assert.equal(f.state.banCount, 0);
    assert.match(JSON.stringify(f.replies.at(-1)), /Action not completed/u);
  }
});

test('honeypot ban between prompt and confirmation does not ban again', async () => {
  const f = fixture(); await f.send(); await f.click('ban');
  const confirmation = f.confirmation();
  f.state.banned = true; f.state.missingMember = true;
  await f.click(confirmation);
  assert.equal(f.state.banCount, 0);
  assert.match(JSON.stringify(f.replies.at(-1)), /already banned/u);
});

test('delete confirmation handles both existing and already deleted messages without ban permission', async () => {
  for (const alreadyDeleted of [false, true]) {
    const f = fixture(); f.state.banPermission = false;
    await f.send(); await f.click('delete');
    const confirmation = f.confirmation();
    f.state.deleted = alreadyDeleted;
    await f.click(confirmation);
    assert.equal(f.state.deleteCount, alreadyDeleted ? 0 : 1);
    assert.match(JSON.stringify(f.replies.at(-1)), /deleted/u);
    assert.equal(f.disabled('Delete message'), true);
  }
});

test('live ban events update recent alerts while retaining deletion status', async () => {
  const f = fixture(); await f.send(); await f.click('delete'); await f.click(f.confirmation());
  await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })));
  assert.equal(f.disabled('Ban user'), true);
  assert.doesNotMatch(f.text(1), /Deleted/u);
  assert.doesNotMatch(f.text(2), /Banned/u);
  assert.equal(f.disabled('Delete message'), true);
  assert.equal(f.text(3), '**Known scam domain**');
  assert.match(JSON.stringify(f.alert.components[0]?.toJSON()), /attachment:\/\/evidence.png/u);
});

test('ban events update status without moderating or a refresh control', async () => {
  const f = fixture(); await f.send(); f.state.banned = true;
  await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })));
  assert.equal(f.state.banCount + f.state.deleteCount, 0);
  assert.equal(f.disabled('Ban user'), true);
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /refresh/iu);
});

test('deletion events update an uncached source automatically', async () => {
  const f = fixture(); await f.send(); f.state.deleted = true;
  await f.service.onDelete({ guildId, channelId, id: messageId });
  assert.equal(f.disabled('Delete message'), true);
  assert.equal(f.state.deleteCount, 0);
});

test('concurrent ban and deletion events preserve both states and evidence', async () => {
  const f = fixture(); await f.send();
  await Promise.all([
    f.service.onDelete({ guildId, channelId, id: messageId }),
    f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } }))),
  ]);
  assert.equal(f.disabled('Ban user'), true);
  assert.equal(f.disabled('Delete message'), true);
  assert.match(JSON.stringify(f.alert.components[0]?.toJSON()), /attachment:\/\/evidence.png/u);
  await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })), false);
  assert.equal(f.text(1), `<@${userId}> · Not banned`);
  assert.equal(f.disabled('Delete message'), true);
  assert.equal(f.disabled('Ban user'), false);
});

test('deletion before alert delivery is retained and foreign guild events are ignored', async () => {
  const f = fixture();
  await f.service.onDelete({ guildId: 'foreign', channelId, id: messageId });
  await f.send();
  assert.doesNotMatch(f.text(2), /\(deleted\)/u);
  const g = fixture();
  g.state.deleted = true;
  await g.service.onDelete({ guildId, channelId, id: messageId });
  await g.send();
  assert.match(g.text(2), / \(deleted\)$/u);
  assert.equal(g.state.forwards, 0);
});

test('successful forward precedes slim card without uploading duplicate evidence', async () => {
  const f = fixture(); f.state.forwardFails = false;
  await f.send();
  assert.equal(f.state.forwards, 1);
  assert.equal(f.sent[0]?.files?.length, 0);
  assert.deepEqual(f.alert.components[0]?.toJSON().components.map((item) => item.type), [10, 10, 10, 1]);
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /Image unavailable|attachment:\/\//u);
  await f.service.onDelete({ guildId, channelId, id: messageId });
  await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })));
  assert.equal(f.disabled('Delete message'), true);
  assert.equal(f.disabled('Ban user'), true);
  assert.doesNotMatch(JSON.stringify(f.alert.components[0]?.toJSON()), /Image unavailable|attachment:\/\//u);
});

test('forward permission failure uploads cached evidence without claiming deletion', async () => {
  const f = fixture(); await f.send();
  assert.equal(f.sent[0]?.files?.length, 1);
  assert.doesNotMatch(f.text(2), /\(deleted\)/u);
});

test('a ban during evidence delivery is reflected in the alert', async () => {
  const f = fixture(); f.state.banDuringForward = true; await f.send();
  assert.equal(f.disabled('Ban user'), true);
});

test('successful moderation is not reported as failed if alert edit fails', async () => {
  const f = fixture(); await f.send(); await f.click('ban');
  const confirmation = f.confirmation(); f.state.editFails = true;
  await f.click(confirmation);
  assert.equal(f.state.banCount, 1);
  assert.match(JSON.stringify(f.replies.at(-1)), /User banned/u);
  assert.match(JSON.stringify(f.replies.at(-1)), /could not be updated/u);
});

test('confirmed ban supersedes an older unban event', async () => {
  const f = fixture(); await f.send();
  await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })), false);
  await f.click('ban'); await f.click(f.confirmation());
  assert.equal(f.state.banCount, 1);
  assert.equal(f.disabled('Ban user'), true);
  assert.match(JSON.stringify(f.alert.components[0]?.toJSON()), /"label":"Ban user"[^}]*"disabled":true/u);
});

test('fresh ban lookup supersedes an older event on alert delivery', async () => {
  const f = fixture();
  await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })), false);
  f.state.banned = true;
  await f.send();
  assert.equal(f.text(1), `<@${userId}> · Banned`);
});

test('ban event received during a lookup supersedes its stale response', async (t) => {
  const f = fixture(); await f.send();
  let eventSent = false;
  t.mock.method(f.guild.bans, 'fetch', async () => {
    if (eventSent) return { reason: null };
    eventSent = true;
    await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })));
    throw { code: 10026 };
  });
  await f.click('ban');
  assert.equal(f.replies.at(-1), 'Already banned.');
  assert.equal(f.disabled('Ban user'), true);
  assert.equal(f.state.banCount, 0);
});

test('unban event during a ban request is not overwritten by its completion', async (t) => {
  const f = fixture(); await f.send(); await f.click('ban');
  const confirmation = f.confirmation();
  t.mock.method(f.guild.members, 'ban', async () => {
    f.state.banCount++;
    await f.service.onBan(/** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } })), false);
  });
  await f.click(confirmation);
  assert.equal(f.state.banCount, 1);
  assert.equal(f.text(1), `<@${userId}> · Not banned`);
});

test('overlapping lookup cannot suppress a successful ban update', async (t) => {
  const f = fixture(); await f.send(); await f.click('ban');
  const confirmation = f.confirmation();
  t.mock.method(f.guild.members, 'ban', async () => {
    await f.click('delete');
    f.state.banCount++;
    f.state.banned = true;
  });
  await f.click(confirmation);
  assert.equal(f.state.banCount, 1);
  assert.equal(f.disabled('Ban user'), true);
});

test('ban attribution and reason appear on delivery and survive deletion edits', async () => {
  const f = fixture(); f.state.banned = true; f.state.banReason = 'Triggered honeypot -> ban';
  f.auditEntries.set('ban', { targetId: userId, executorId: '1450060292716494940', reason: f.state.banReason, action: AuditLogEvent.MemberBanAdd });
  await f.send();
  assert.match(f.text(1), /Banned by <@1450060292716494940>\n-# Triggered honeypot/u);
  await f.service.onDelete({ guildId, channelId, id: messageId });
  assert.match(f.text(1), /Banned by <@1450060292716494940>/u);
  assert.equal(f.disabled('Delete message'), true);
});

test('missing audit permission retains ban reason without inventing an executor', async () => {
  const f = fixture(); f.state.banned = true; f.state.auditPermission = false;
  f.state.banReason = '**spam**\n@everyone';
  await f.send();
  assert.match(f.text(1), /Banned\n-#/u);
  assert.doesNotMatch(f.text(1), /Banned by|\*\*spam\*\*|@everyone/u);
  assert.deepEqual(f.sent[0]?.allowedMentions, { parse: [] });
});

test('events change only controls and preserve the complete report', async () => {
  const f = fixture(); await f.send(); f.state.banned = true; f.state.banReason = 'spam';
  const report = f.alert.components[0]?.toJSON().components.filter(item => item.type !== ComponentType.ActionRow);
  f.auditEntries.set('ban', { targetId: userId, executorId: '1450060292716494940', reason: 'spam', action: AuditLogEvent.MemberBanAdd, createdTimestamp: Date.now() + 1 });
  const ban = /** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } }));
  await f.service.onBan(ban);
  assert.equal(f.disabled('Ban user'), true);
  await f.service.onBan(ban, false);
  await f.service.onDelete({ guildId, channelId, id: messageId });
  assert.equal(f.disabled('Ban user'), false);
  assert.equal(f.disabled('Delete message'), true);
  assert.deepEqual(f.alert.components[0]?.toJSON().components.filter(item => item.type !== ComponentType.ActionRow), report);
  assert.equal(f.text(1), `<@${userId}> · Not banned`);
});

test('unrelated audit entries and a newer unban do not attribute an older ban', async () => {
  const f = fixture(); f.state.banned = true;
  f.auditEntries.set('other', { targetId: 'other', executorId: '123', reason: null, action: AuditLogEvent.MemberBanAdd });
  f.auditEntries.set('unban', { targetId: userId, executorId: '123', reason: null, action: AuditLogEvent.MemberBanRemove });
  f.auditEntries.set('old', { targetId: userId, executorId: '123', reason: null, action: AuditLogEvent.MemberBanAdd });
  await f.send();
  assert.equal(f.text(1), `<@${userId}> · Banned`);
});

test('unban during audit lookup discards stale attribution', async (t) => {
  const f = fixture(); await f.send(); f.state.banned = true;
  f.auditEntries.set('ban', { targetId: userId, executorId: '1450060292716494940', reason: null, action: AuditLogEvent.MemberBanAdd });
  const ban = /** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } }));
  t.mock.method(f.guild, 'fetchAuditLogs', async () => {
    await f.service.onBan(ban, false);
    return { entries: f.auditEntries };
  });
  await f.send();
  assert.equal(f.text(1), `<@${userId}> · Not banned`);
});

test('repeated delivery reuses the alert and preserves original ban attribution', async (t) => {
  const f = fixture(); f.state.banned = true; f.state.banReason = 'spam';
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const entry = { targetId: userId, executorId: '1450060292716494940', reason: 'spam', action: AuditLogEvent.MemberBanAdd, createdTimestamp: now - 1000 };
  f.auditEntries.set('ban', entry);
  await f.send();
  assert.match(f.text(1), /Banned by/u);
  const ban = /** @type {import('discord.js').GuildBan} */ (/** @type {unknown} */ ({ guild: f.guild, user: { id: userId } }));
  await f.service.onBan(ban, false);
  await f.service.onBan(ban);
  await f.send();
  assert.match(f.text(1), /Banned by <@1450060292716494940>/u);
  entry.createdTimestamp = now + 1;
  entry.executorId = '1450060292716494941';
  await f.send();
  assert.match(f.text(1), /Banned by <@1450060292716494940>/u);
  assert.equal(f.sent.length, 1);
});

test('confirmation expires without executing moderation', async (t) => {
  const f = fixture(); await f.send(); await f.click('ban');
  const confirmation = f.confirmation();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 61_000);
  await f.click(confirmation);
  assert.equal(f.state.banCount, 0);
  assert.match(JSON.stringify(f.replies.at(-1)), /expired/u);
});

test('one source alert accumulates both reasons without losing pending controls', async () => {
  const f = fixture();
  await Promise.all([f.send(), f.service.send({ message: f.message, reason: 'Honeypot triggered', image: undefined })]);
  assert.equal(f.sent.length, 1);
  assert.match(f.text(7), /Known scam domain/u);
  assert.match(f.text(7), /Honeypot triggered/u);
  await f.service.annotate(f.message, 'Auto-delete pending — 15 seconds');
  await f.send();
  assert.match(f.text(5), /pending/u);
  assert.ok(f.alert.components[0]?.toJSON().components.some(c => c.id === 6));
});

test('Discord-assigned IDs preserve evidence and manual controls through automatic updates', async () => {
  const f = fixture(); await f.send();
  assert.ok(f.alert.components[0]);
  const original = f.alert.components[0].toJSON().components;
  const gallery = original.find(item => item.type === ComponentType.MediaGallery);
  const manual = original.find(item => item.type === ComponentType.ActionRow);
  assert.ok(gallery); assert.ok(manual);
  await f.service.annotate(f.message, 'Auto-delete pending — 15 seconds');
  await f.send();
  await f.service.annotate(f.message, 'Auto-delete cancelled.');
  assert.ok(f.alert.components[0]);
  const updated = f.alert.components[0].toJSON().components;
  assert.deepEqual(updated.find(item => item.type === ComponentType.MediaGallery), gallery);
  assert.deepEqual(updated.find(item => item.type === ComponentType.ActionRow), manual);
  assert.match(f.text(7), /Known scam domain/u);
});

test('cancel and suspend require fresh permissions and route to the bound controller', async () => {
  const f = fixture(); let cancelled = 0, suspended = 0;
  f.service.setAutomatic({ cancel: async id => { assert.equal(id, messageId); cancelled++; }, suspend: async () => { suspended++; } });
  await f.send();
  f.state.actorPermission = false;
  await f.click('cancel'); await f.click('suspend');
  assert.equal(cancelled, 0); assert.equal(suspended, 0);
  f.state.actorPermission = true;
  await f.click('cancel'); await f.click('suspend');
  assert.equal(cancelled, 1); assert.equal(suspended, 1);
});

test('late spam evidence upgrades the existing honeypot alert without duplicating it', async () => {
  const f = fixture();
  await f.service.send({ message: f.message, reason: 'Honeypot activity', image: undefined });
  assert.equal(f.text(4), 'Image unavailable');
  await f.service.annotate(f.message, 'Auto-delete pending — 15 seconds');
  await f.send(); await f.send();
  assert.equal(f.sent.length, 1);
  assert.equal(f.edited.filter(edit => edit.files?.length).length, 1);
  assert.equal(f.text(4), '');
  assert.match(f.text(5), /pending/u);
  assert.ok(f.alert.components[0]?.toJSON().components.some(c => c.id === 6));
});

test('failed optional image upgrade still merges the spam reason on the existing alert', async () => {
  const f = fixture();
  await f.service.send({ message: f.message, reason: 'Honeypot activity', image: undefined });
  f.state.uploadFails = true;
  await f.send();
  assert.equal(f.sent.length, 1);
  assert.equal(f.text(4), 'Image unavailable');
  assert.match(f.text(7), /Known scam domain/u);
});