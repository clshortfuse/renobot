import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { Collection } from 'discord.js';
import { createSecurityAutodelete, readSecurityAutodeleteConfig } from '../src/security-autodelete.js';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const config = { channelId: 'trap', mode: 'enforce', exemptUsers: ['trusted'], exemptRoles: ['staff'], userLimit: 10, guildLimit: 30 };
  const state = { exempt: false, permission: true, missing: false, fail: false, roleLookupFails: false, alertMissing: false };
  /** @type {string[]} */ const deleted = [];
  /** @type {string[]} */ const alerts = [];
  /** @type {string[]} */ const statuses = [];
  /** @type {string[]} */ const updated = [];
  let marked = 0, removed = 0;
  const guild = { emojis: { cache: new Collection([['emoji', { name: 'banme' }]]) }, members: {
    fetch: async () => { if (state.roleLookupFails) throw new Error('lookup failed'); return { roles: { cache: new Map(state.exempt ? [['staff', {}]] : []) } }; }, fetchMe: async () => ({}),
  } };
  /** @param {string} id @param {string} [channelId] @param {string} [user] */
  function message(id, channelId = 'source', user = 'user') {
    return /** @type {import('discord.js').Message} */ (/** @type {unknown} */ ({
      id, guildId: 'guild', channelId, guild, author: { id: user, bot: false }, webhookId: null,
      client: { user: { id: 'bot' } }, inGuild: () => true, url: id,
      react: async () => { marked++; return { users: { remove: async () => { removed++; } } }; },
      channel: { permissionsFor: () => ({ has: () => state.permission }), messages: { fetch: async () => {
        if (state.missing) throw { code: 10008 };
        return message(id, channelId, user);
      } } },
      delete: async () => { if (state.fail) throw new Error('delete failed'); deleted.push(id); },
    }));
  }
  const service = createSecurityAutodelete({ config, guildId: 'guild', ownerUserId: 'owner', logger: pino({ level: 'silent' }),
    report: async text => { statuses.push(text); }, alert: async (m, text) => { alerts.push(`${m.id}: ${text}`); },
    annotate: async (_m, text) => {
      if (state.alertMissing && text.startsWith('Auto-deleting')) throw { code: 10008 };
      statuses.push(text);
    }, onDelete: async message => { updated.push(message.id); },
  });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  t.after(() => service.close());
  return { service, config, state, deleted, updated, alerts, statuses, message, drain, marked: () => marked, removed: () => removed,
    trigger: () => service.observe(message('trap-post', 'trap')),
    flag: (id = 'spam', at = Date.now()) => service.flag({ message: message(id), observedAt: at, reason: 'spam', image: Buffer.from('image') }),
  };
}

test('configuration defaults to dry-run and validates channel and caps', () => {
  assert.equal(readSecurityAutodeleteConfig({}), undefined);
  assert.deepEqual(readSecurityAutodeleteConfig({
    DISCORD_HONEYPOT_CHANNEL_ID: '1408259940908531915',
    SECURITY_AUTODELETE_MODE: 'enforce',
    SECURITY_AUTODELETE_EXEMPT_USER_IDS: '1408259940908531916',
    SECURITY_AUTODELETE_EXEMPT_ROLE_IDS: '1408259940908531917',
    SECURITY_AUTODELETE_USER_LIMIT: '5',
    SECURITY_AUTODELETE_GUILD_LIMIT: '20',
  }), { channelId: '1408259940908531915', mode: 'enforce',
    exemptUsers: ['1408259940908531916'], exemptRoles: ['1408259940908531917'],
    userLimit: 5, guildLimit: 20 });
  assert.equal(readSecurityAutodeleteConfig({ DISCORD_HONEYPOT_CHANNEL_ID: '1408259940908531915' })?.mode, 'dry-run');
  assert.throws(() => readSecurityAutodeleteConfig({ DISCORD_HONEYPOT_CHANNEL_ID: 'bad' }));
  assert.throws(() => readSecurityAutodeleteConfig({ DISCORD_HONEYPOT_CHANNEL_ID: '1408259940908531915', SECURITY_AUTODELETE_USER_LIMIT: '0' }));
});

test('both signal orders schedule recency messages for 15 seconds, not immediately', async t => {
  const f = fixture(t);
  await f.service.observe(f.message('first')); await f.trigger(); await f.drain();
  await f.service.observe(f.message('second')); await f.drain();
  assert.deepEqual(f.deleted, []);
  assert.equal(f.marked(), 2);
  t.mock.timers.tick(14999); await f.drain(); assert.deepEqual(f.deleted, []);
  t.mock.timers.tick(1); await f.drain(); assert.deepEqual(f.deleted, ['first', 'second']);
});

test('spam plus honeypot schedules once despite repeated signals', async t => {
  const f = fixture(t); await f.flag(); await f.trigger(); await f.drain();
  await f.flag(); await f.trigger(); await f.drain();
  assert.equal(f.marked(), 1);
  t.mock.timers.tick(15000); await f.drain(); assert.deepEqual(f.deleted, ['spam']);
});

test('cancel prevents deletion and removes only the bot marker', async t => {
  const f = fixture(t); await f.trigger(); await f.flag();
  await f.service.cancel('spam');
  t.mock.timers.tick(15000); await f.drain();
  assert.deepEqual(f.deleted, []); assert.equal(f.removed(), 1);
});

test('suspend cancels all countdowns and blocks new scheduling', async t => {
  const f = fixture(t); await f.trigger(); await f.flag('one'); await f.flag('two');
  await f.service.suspend(); await f.flag('three');
  t.mock.timers.tick(15000); await f.drain();
  assert.deepEqual(f.deleted, []); assert.equal(f.removed(), 2);
});

test('dry-run creates status but no reaction or deletion', async t => {
  const f = fixture(t); f.config.mode = 'dry-run'; await f.trigger(); await f.flag();
  t.mock.timers.tick(15000); await f.drain();
  assert.deepEqual(f.deleted, []); assert.equal(f.marked(), 0);
  assert.ok(f.statuses.some(s => s.startsWith('Dry-run')));
});

test('delayed classification cannot refresh an expired observation', async t => {
  const f = fixture(t); const old = Date.now(); t.mock.timers.tick(60000);
  await f.trigger(); await f.flag('old', old);
  t.mock.timers.tick(15000); await f.drain(); assert.deepEqual(f.deleted, []);
});

test('countdown remains valid when the original correlation ages past 60 seconds', async t => {
  const f = fixture(t); await f.flag(); t.mock.timers.tick(59000); await f.trigger();
  t.mock.timers.tick(15000); await f.drain(); assert.deepEqual(f.deleted, ['spam']);
});

for (const failure of ['exempt', 'permission', 'roleLookupFails', 'fail']) {
  test(`execution rechecks ${failure} and does not delete`, async t => {
    const f = fixture(t); await f.trigger(); await f.flag();
    if (failure === 'permission') f.state.permission = false;
    else if (failure === 'exempt') f.state.exempt = true;
    else if (failure === 'roleLookupFails') f.state.roleLookupFails = true;
    else f.state.fail = true;
    t.mock.timers.tick(15000); await f.drain(); assert.deepEqual(f.deleted, []);
  });
}

test('owner trusted bot webhook and foreign guild observations cannot trigger', async t => {
  const f = fixture(t); await f.flag();
  for (const overrides of [{ author: { id: 'owner' } }, { author: { id: 'trusted' } }, { author: { id: 'user', bot: true } }, { webhookId: 'webhook' }, { guildId: 'other' }]) {
    await f.service.observe(Object.assign(f.message('trap-post', 'trap'), overrides));
  }
  t.mock.timers.tick(15000); await f.drain(); assert.deepEqual(f.deleted, []);
});

test('shutdown cancels pending actions', async t => {
  const f = fixture(t); await f.trigger(); await f.flag(); await f.service.close();
  t.mock.timers.tick(15000); await f.drain(); assert.deepEqual(f.deleted, []);
});

test('already-deleted source completes cleanup without cancellation or failure warnings', async t => {
  const f = fixture(t); await f.trigger(); await f.flag();
  f.state.missing = true;
  t.mock.timers.tick(15000); await f.drain();
  assert.deepEqual(f.deleted, []);
  assert.deepEqual(f.updated, ['spam']);
  assert.equal(f.statuses.at(-1), 'Already deleted.');
  assert.equal(f.statuses.some(status => /failed|cancelled|manual review/u.test(status)), false);
  await f.service.close();
  assert.equal(f.statuses.at(-1), 'Already deleted.');
});

test('missing alert at execution does not falsely mark the source deleted', async t => {
  const f = fixture(t); await f.trigger(); await f.flag();
  f.state.alertMissing = true;
  t.mock.timers.tick(15000); await f.drain();
  assert.deepEqual(f.deleted, []); assert.deepEqual(f.updated, []);
  assert.equal(f.statuses.includes('Already deleted.'), false);
});