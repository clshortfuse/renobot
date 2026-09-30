import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DiscordAPIError } from 'discord.js';

import { createWebServer } from '../src/web-server.js';
import { MissingVerificationTokenError } from '../src/database.js';
import { encryptSetting, integrationSecretOwner } from '../src/modder-settings.js';
import { createSession, csrfToken } from '../src/web-session.js';
import { membership } from './fixtures/kofi-membership.js';

const secret = '01234567890123456789012345678901';
const config = Object.freeze({
  clientId: 'client',
  clientSecret: 'client-secret',
  guildId: '23456789012345678',
  host: '127.0.0.1',
  modderRoleId: undefined,
  moderatorRoleId: undefined,
  ownerUserId: 'owner',
  port: 3000,
  publicBaseUrl: new URL('https://renobot.example/'),
  sessionSecret: secret,
});
/** @type {import('node:http').Server[]} */
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve(undefined));
  })));
});

/**
 * @param {Readonly<{ ready?: boolean, request?: typeof fetch, bot?: import('discord.js').Client,
 *   config?: import('../src/web-config.js').WebConfig, database?: import('../src/database.js').PortalDatabase,
 *   settingsConfig?: import('../src/modder-settings.js').ModderSettingsConfig,
 *   trustedKofiProxyIp?: string, supporterRoleId?: string, earlyAccessRoleId?: string }>} [options]
 */
async function startServer(options = {}) {
  const logger = { error() {}, warn() {}, info() {} };
  const server = createWebServer({
    bot: options.bot ?? /** @type {import('discord.js').Client} */ ({ isReady: () => options.ready ?? true }),
    config: options.config ?? config,
    logger: /** @type {import('pino').Logger} */ (/** @type {unknown} */ (logger)),
    ...(options.request ? { request: options.request } : {}),
    ...(options.database ? { database: options.database } : {}),
    ...(options.settingsConfig ? { settingsConfig: options.settingsConfig } : {}),
    ...(options.trustedKofiProxyIp ? { trustedKofiProxyIp: options.trustedKofiProxyIp } : {}),
    ...(options.supporterRoleId ? { supporterRoleId: options.supporterRoleId } : {}),
    ...(options.earlyAccessRoleId ? { earlyAccessRoleId: options.earlyAccessRoleId } : {}),
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  return `http://127.0.0.1:${address.port}`;
}

/** @param {string} baseUrl @param {string} [returnTo] */
async function beginLogin(baseUrl, returnTo) {
  const response = await fetch(`${baseUrl}/auth/discord${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`, { redirect: 'manual' });
  const location = new URL(response.headers.get('location') ?? '');
  const cookie = response.headers.get('set-cookie') ?? '';
  const state = location.searchParams.get('state') ?? '';
  const cookiePair = cookie.split(';', 1)[0];
  if (!cookiePair) throw new Error('Expected an OAuth state cookie.');
  return { cookie: cookiePair, location, state };
}

describe('dashboard routes', () => {
  it('requires owner and CSRF for separate account linking and crediting actions', async () => {
    /** @type {string[][]} */
    const calls = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      linkEmailPayments: async (/** @type {string} */ id) => { calls.push(['link', id]); return { linked: 1, more: false }; },
      creditAccountPayments: async (/** @type {string} */ id, /** @type {string} */ currency) => {
        calls.push(['credit', id, currency]); return { credited: 1 };
      },
    }));
    const base = await startServer({ database, earlyAccessRoleId: '1554515217751216185',
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const owner = createSession({ id: 'owner', username: 'owner' }, secret);
    const other = createSession({ id: 'member', username: 'member' }, secret);
    for (const action of ['link', 'credit']) {
      const url = `${base}/app/api/admin/early-access/12345678901234567/${action}`;
      const post = (/** @type {string} */ token, /** @type {string} */ csrf) => fetch(url, { method: 'POST',
        headers: { Cookie: `renobot_session=${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf }) });
      assert.equal((await post(other, csrfToken(other, secret))).status, 403);
      assert.equal((await post(owner, 'bad')).status, 403);
      assert.equal((await post(owner, csrfToken(owner, secret))).status, 200);
    }
    assert.deepEqual(calls, [['link', '12345678901234567'], ['credit', '12345678901234567', 'USD']]);
  });
  it('restricts CSV email repair to the authorized session with CSRF and bounded input', async () => {
    /** @type {string[]} */
    const calls = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async () => ({ id: 'own' }),
      importKofiCsv: async (/** @type {string} */ id) => { calls.push(id); return { emailsUpdated: 1, unmatched: 0, unchanged: 0 }; },
    }));
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      guilds: { fetch: async () => ({ members: { fetch: async () => ({ roles: { cache: new Map() } }) } }) },
    }));
    const base = await startServer({ database, bot,
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const path = `${base}/app/api/modder/kofi/import?userId=other`;
    const token = createSession({ id: 'owner', username: 'owner' }, secret);
    const headers = { Cookie: `renobot_session=${token}`, 'Content-Type': 'text/csv', 'X-CSRF-Token': csrfToken(token, secret) };
    const body = 'DateTime (UTC),Received,Given,Currency,TransactionType,TransactionId,BuyerEmail\n09/01/2026 15:51,5.00,0,USD,Tip,tx,email@example.test';
    assert.equal((await fetch(path, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body })).status, 403);
    const member = createSession({ id: 'member', username: 'member' }, secret);
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Cookie: `renobot_session=${member}` }, body })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers, body: 'invalid' })).status, 400);
    assert.equal((await fetch(path, { method: 'POST', headers, body: 'a'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
    assert.deepEqual(calls, []);
    assert.equal((await fetch(path, { method: 'POST', headers, body })).status, 200);
    assert.deepEqual(calls, ['owner']);
  });
  it('requests email only on demand and trusts only Discord-verified addresses', async () => {
    /** @type {string[][]} */
    const linked = [];
    let verified = false;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      saveLogin: async () => {},
      verifyDiscordEmail: async (/** @type {string} */ id, /** @type {string} */ email) => { linked.push([id, email]); return true; },
    }));
    const request = async (/** @type {RequestInfo | URL} */ url) => new Response(JSON.stringify(
      String(url).endsWith('/token') ? { access_token: 'token' }
        : { id: 'member', username: 'member', email: 'member@example.test', verified },
    ));
    const base = await startServer({ database, request });
    assert.equal((await beginLogin(base)).location.searchParams.get('scope'), 'identify');
    for (const proof of [false, true]) {
      verified = proof;
      const start = await fetch(`${base}/auth/discord?email=1`, { redirect: 'manual' });
      const location = new URL(start.headers.get('location') ?? '');
      assert.equal(location.searchParams.get('scope'), 'identify email');
      const callback = await fetch(`${base}/auth/discord/callback?code=code&state=${encodeURIComponent(location.searchParams.get('state') ?? '')}`,
        { headers: { Cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }, redirect: 'manual' });
      assert.equal(callback.status, 303);
    }
    assert.deepEqual(linked, [['member', 'member@example.test']]);
  });

  it('scopes personal account reads and payment linking to the session and requires CSRF', async () => {
    /** @type {(string | undefined)[][]} */
    const calls = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      supporterAccount: async (/** @type {string} */ id, /** @type {string | undefined} */ before) => {
        calls.push(['account', id, before]);
        return { emails: [{ email: 'one@example.test', verifiedBy: 'discord', verifiedAt: new Date(0) },
          { email: 'two@example.test', verifiedBy: 'discord', verifiedAt: new Date(0) }], balance: null,
        entries: [{ id: 'own', integration: { account: { lastKnownUsername: 'modder' } }, amount: { toFixed: () => '5.00' },
          currency: 'USD', supporterEmail: 'private@example.test', receivedAt: new Date(0), occurredAt: new Date(0),
          eventType: 'Donation', transactionId: 'tx', outcome: 'recorded', sourceIp: 'private' }], nextCursor: null };
      },
      linkEmailPayments: async (/** @type {string} */ id) => { calls.push(['link', id]); return { linked: 2, more: false }; },
    }));
    const base = await startServer({ database, settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const token = createSession({ id: 'member', username: 'member' }, secret);
    const headers = { Cookie: `renobot_session=${token}` };
    assert.equal((await fetch(`${base}/app/api/account`)).status, 401);
    const response = await fetch(`${base}/app/api/account?userId=someone-else&before=cursor`, { headers });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.emails.length, 2);
    assert.equal(data.entries[0].transactionId, 'tx');
    assert.doesNotMatch(JSON.stringify(data), /private@example|sourceIp/u);
    const path = `${base}/app/api/account/link-payments`;
    const formHeaders = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
    assert.equal((await fetch(path, { method: 'POST', headers: formHeaders, body: 'csrf=wrong' })).status, 403);
    assert.deepEqual(calls, [['account', 'member', 'cursor']]);
    const matched = await fetch(path, { method: 'POST', headers: formHeaders,
      body: new URLSearchParams({ csrf: csrfToken(token, secret), userId: 'someone-else', email: 'unverified@example.test' }) });
    assert.deepEqual(await matched.json(), { linked: 2, more: false });
    assert.deepEqual(calls.at(-1), ['link', 'member']);
  });
  it('shows only the owner early-access totals, periods and credited modders', async () => {
    const calls = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      listEarlyAccessReview: async (/** @type {string} */ roleId, /** @type {string | undefined} */ before) => {
        calls.push(['list', roleId, before]);
        return { members: [{ discordUserId: '12345678901234567', totalAmount: { toFixed: () => '13.00' },
          creditedMonths: 2, expiresAt: new Date('2099-10-29T00:00:00Z'), roleManaged: true, sync: null }], nextCursor: null };
      },
      getEarlyAccessReview: async (/** @type {string} */ id) => {
        calls.push(['detail', id]);
        return id === '12345678901234567' ? { periods: [{ startedAt: new Date('2026-09-01T00:00:00Z'),
          expiresAt: new Date('2026-11-01T00:00:00Z'), months: 2 }], contributions: [{ eventId: 'receipt',
          amount: { toFixed: () => '13.00' }, currency: 'USD', eventType: 'Donation',
          receivedAt: new Date('2026-09-01T00:00:00Z'), modderDiscordUserId: '23456789012345678',
          modderUsername: '<script>' }], nextCursor: null } : null;
      },
    }));
    let rolePresent = false;
    let lookupFails = false;
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true, users: { fetch: async () => ({ globalName: 'Preview supporter' }) },
      guilds: { fetch: async () => ({ members: { fetch: async (/** @type {{ user: string, force: boolean, cache: boolean }} */ query) => {
        assert.deepEqual(query, { user: '12345678901234567', force: true, cache: false });
        if (lookupFails) throw new Error('Discord unavailable');
        return { roles: { cache: { has: () => rolePresent } } };
      } } }) },
    }));
    const base = await startServer({ bot, database, earlyAccessRoleId: '1554515217751216185',
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const path = '/app/api/admin/early-access';
    const owner = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    const other = { Cookie: `renobot_session=${createSession({ id: 'member', username: 'member' }, secret)}` };
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: other })).status, 403);
    assert.equal((await fetch(`${base}${path}/12345678901234567`, { headers: other })).status, 403);
    assert.equal((await fetch(`${base}${path}?before=bad`, { headers: owner })).status, 400);
    const list = await (await fetch(`${base}${path}`, { headers: owner })).json();
    assert.equal(list.members[0].discordName, 'Preview supporter');
    assert.equal(list.members[0].totalAmount, '13.00');
    assert.equal(list.members[0].creditedMonths, 2);
    assert.equal(list.members[0].roleManaged, true);
    assert.equal(list.members[0].roleStatus, 'missing');
    rolePresent = true;
    assert.equal((await (await fetch(`${base}${path}`, { headers: owner })).json()).members[0].roleStatus, 'present');
    lookupFails = true;
    assert.equal((await (await fetch(`${base}${path}`, { headers: owner })).json()).members[0].roleStatus, 'unavailable');
    const detail = await (await fetch(`${base}${path}/12345678901234567`, { headers: owner })).json();
    assert.equal(detail.periods[0].months, 2);
    assert.equal(detail.contributions[0].modderUsername, '<script>');
    assert.equal((await fetch(`${base}${path}/34567890123456789`, { headers: owner })).status, 404);
    assert.equal((await fetch(`${base}${path}/bad`, { headers: owner })).status, 400);
    assert.equal(calls.length, 5);
    assert.match(await (await fetch(`${base}/app/admin/early-access`)).text(), /Early-access review/u);
  });
  it('only allows the owner to approve one active historical Early Access recipient with CSRF', async () => {
    /** @type {string[]} */
    const approved = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      approveEarlyAccess: async (/** @type {string} */ id) => {
        approved.push(id);
        return id === '12345678901234567';
      },
    }));
    const base = await startServer({ database, earlyAccessRoleId: '1554515217751216185' });
    const url = `${base}/app/api/admin/early-access/12345678901234567/approve`;
    const token = createSession({ id: 'owner', username: 'owner' }, secret);
    const other = createSession({ id: 'member', username: 'member' }, secret);
    const post = (/** @type {string | undefined} */ cookie, /** @type {string} */ csrf, /** @type {string} */ path = url) =>
      fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: `renobot_session=${cookie}` } : {}) }, body: new URLSearchParams({ csrf }) });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await post(undefined, '')).status, 401);
    assert.equal((await post(other, csrfToken(other, secret))).status, 403);
    assert.equal((await post(token, 'invalid')).status, 403);
    assert.equal((await post(token, csrfToken(token, secret), `${base}/app/api/admin/early-access/bad/approve`)).status, 400);
    assert.deepEqual(approved, []);
    assert.deepEqual(await (await post(token, csrfToken(token, secret))).json(), { scheduled: true });
    assert.equal((await post(token, csrfToken(token, secret),
      `${base}/app/api/admin/early-access/23456789012345678/approve`)).status, 409);
    assert.deepEqual(approved, ['12345678901234567', '23456789012345678']);
  });
  it('lets the owner import historical receipts only on demand with CSRF and a bounded cursor', async () => {
    /** @type {(value: void) => void} */
    let release = () => {};
    /** @type {(value: void) => void} */
    let started = () => {};
    const entered = new Promise((resolve) => { started = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    /** @type {(string | undefined)[]} */
    const calls = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      backfillEarlyAccess: async (/** @type {string} */ currency, /** @type {string | undefined} */ after) => {
        assert.equal(currency, 'USD');
        calls.push(after);
        if (!after) { started(); await hold; }
        return after === 'badCursor' ? null : { scanned: after ? 1 : 50, nextCursor: after ? null : 'receiptCursor' };
      },
    }));
    const base = await startServer({ database, earlyAccessRoleId: '1554515217751216185',
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const url = `${base}/app/api/admin/early-access/import`;
    const owner = createSession({ id: 'owner', username: 'owner' }, secret);
    const member = createSession({ id: 'member', username: 'member' }, secret);
    const post = (/** @type {string | undefined} */ token, /** @type {string} */ csrf,
      /** @type {string | undefined} */ after = undefined) => fetch(url, { method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', ...(token ? { Cookie: `renobot_session=${token}` } : {}),
      }, body: new URLSearchParams({ csrf, ...(after === undefined ? {} : { after }) }) });
    assert.equal((await post(undefined, '')).status, 401);
    assert.equal((await post(member, csrfToken(member, secret))).status, 403);
    assert.equal((await post(owner, 'bad')).status, 403);
    assert.equal((await post(owner, csrfToken(owner, secret), 'bad!')).status, 400);
    assert.deepEqual(calls, []);
    const first = post(owner, csrfToken(owner, secret));
    await entered;
    assert.equal((await post(owner, csrfToken(owner, secret))).status, 409);
    release();
    assert.deepEqual(await (await first).json(), { scanned: 50, nextCursor: 'receiptCursor' });
    assert.deepEqual(await (await post(owner, csrfToken(owner, secret), 'receiptCursor')).json(),
      { scanned: 1, nextCursor: null });
    assert.equal((await post(owner, csrfToken(owner, secret), 'badCursor')).status, 400);
    assert.deepEqual(calls, [undefined, 'receiptCursor', 'badCursor']);
  });
  it('reports Discord readiness without exposing a cacheable response', async () => {
    const baseUrl = await startServer({ ready: false });
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('reports database failures as unavailable when persistence is configured', async () => {
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      isReady: async () => false,
    }));
    const baseUrl = await startServer({ database });
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false });
  });

  it('keeps webhook health independent of Discord while requiring durable storage', async () => {
    let available = true;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      isReady: async () => available,
    }));
    const baseUrl = await startServer({ ready: false, database,
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
    assert.deepEqual(await (await fetch(`${baseUrl}/health/webhook`)).json(), { ready: true });
    available = false;
    assert.equal((await fetch(`${baseUrl}/health/webhook`)).status, 503);
  });

  it('renders a public landing page without starting Discord authentication', async () => {
    const baseUrl = await startServer();
    const home = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    const html = await home.text();

    assert.equal(home.status, 200);
    assert.match(html, /Welcome to Renobot\./u);
    assert.match(html, /href="\/auth\/discord"/u);
    assert.match(html, /Access portal/u);
    assert.match(html, /Join RenoDX Discord/u);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/site\.css">/u);
    assert.match(html, /<script src="\/assets\/material\.js\?color=00a9c5&amp;lightness=dark&amp;resetCSS=false" defer><\/script>/u);
    assert.match(html, /<script src="\/assets\/site\.js" defer><\/script>/u);
    assert.doesNotMatch(html, /<style>|\{\{/u);
    assert.doesNotMatch(html, /requests and ban appeals|View information and services|Access tools available to your RenoDX roles/u);
    assert.match(html, /href="https:\/\/renodx\.com\/privacy\.html"/u);
    assert.equal(home.headers.get('location'), null);
  });

  it('serves only declared browser assets with a restrictive content security policy', async () => {
    const baseUrl = await startServer();
    const css = await fetch(`${baseUrl}/assets/site.css`);
    const script = await fetch(`${baseUrl}/assets/site.js`);
    const material = await fetch(`${baseUrl}/assets/material.js`);
    const missing = await fetch(`${baseUrl}/assets/unknown.css`);

    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/u);
    assert.match(css.headers.get('content-security-policy') ?? '', /style-src 'self'/u);
    assert.match(await css.text(), /\.hero\{/u);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/u);
    assert.match(script.headers.get('content-security-policy') ?? '', /script-src 'self'; connect-src 'self'/u);
    assert.match(await script.text(), /\.textContent = session\.username/u);
    assert.equal(material.status, 200);
    assert.match(material.headers.get('content-type') ?? '', /^text\/javascript/u);
    assert.match(material.headers.get('content-security-policy') ?? '', /script-src 'self'; connect-src 'self'/u);
    assert.match(material.headers.get('content-security-policy') ?? '', /style-src 'self'; style-src-attr 'unsafe-inline'/u);
    assert.doesNotMatch(material.headers.get('content-security-policy') ?? '', /script-src[^;]*unsafe-inline|style-src 'self' 'unsafe-inline'/u);
    assert.ok((await material.text()).length > 1000);
    assert.equal(missing.status, 404);
  });

  it('serves the same public app shell with or without a session', async () => {
    const baseUrl = await startServer();
    const app = await fetch(`${baseUrl}/app`, { redirect: 'manual' });
    const session = createSession({ id: 'visitor', username: 'visitor' }, secret);
    const signedIn = await fetch(`${baseUrl}/app`, { headers: { Cookie: `renobot_session=${session}` } });
    const login = await beginLogin(baseUrl);

    assert.equal(app.status, 200);
    assert.equal(await app.text(), await signedIn.text());
    assert.equal((await fetch(`${baseUrl}/auth/session`)).status, 401);
    assert.equal(login.location.origin, 'https://discord.com');
    assert.equal(login.location.pathname, '/oauth2/authorize');
    assert.equal(login.location.searchParams.get('scope'), 'identify');
    assert.equal(login.location.searchParams.get('redirect_uri'), 'https://renobot.example/auth/discord/callback');
    assert.match(login.cookie, /^renobot_oauth_state=/u);
  });

  it('serves an identical public settings shell while keeping the protected API private', async () => {
    const baseUrl = await startServer();
    const anonymous = await fetch(`${baseUrl}/app/modder/kofi`);
    const member = await fetch(`${baseUrl}/app/modder/kofi`, {
      headers: { Cookie: `renobot_session=${createSession({ id: 'member', username: 'member' }, secret)}` },
    });
    assert.equal(anonymous.status, 200);
    const html = await anonymous.text();
    assert.equal(html, await member.text());
    assert.match(html, /Ko-fi webhook/u);
    assert.doesNotMatch(html, /\{\{|https:\/\/renobot\.example\/webhooks/u);
    assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi`)).status, 401);
  });

  it('stores the Ko-fi membership example through the only webhook and rejects invalid deliveries', async () => {
    const key = Buffer.alloc(32, 7);
    const endpointId = 'a'.repeat(43);
    const integration = { id: 'integration', accountId: 'account', endpointId,
      verificationTokenCiphertext: '' };
    integration.verificationTokenCiphertext = encryptSetting('secret', key,
      integrationSecretOwner(integration), 'verification-token');
    let receipts = 0;
    /** @type {boolean | undefined} */
    let earlyAccessEnabled;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findIntegrationByEndpoint: async (/** @type {string} */ id) => id === endpointId ? integration : null,
      recordKofiReceipt: async (/** @type {string} */ _id, /** @type {string} */ _token,
        /** @type {unknown} */ _payment, /** @type {string | undefined} */ _floor,
        /** @type {unknown} */ _source, /** @type {boolean | undefined} */ enabled) => {
        earlyAccessEnabled = enabled;
        receipts++;
        return 'accepted';
      },
    }));
    const baseUrl = await startServer({ database, earlyAccessRoleId: '1554515217751216185',
      settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' } });
    const url = `${baseUrl}/prod/kofi/${endpointId}`;
    const body = (/** @type {string} */ token) => new URLSearchParams({ data: JSON.stringify({
      ...membership, verification_token: token,
    }) });
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { method: 'POST', body: body('secret'),
      headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await fetch(`${baseUrl}/prod/kofi/${'b'.repeat(43)}`, { method: 'POST', body: body('secret') })).status, 403);
    assert.equal((await fetch(`${baseUrl}/dev/kofi/${endpointId}`, { method: 'POST', body: body('secret') })).status, 404);
    assert.equal((await fetch(`${baseUrl}/test/kofi/${endpointId}`, { method: 'POST', body: body('secret') })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', body: body('wrong') })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(262145),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 413);
    assert.equal(receipts, 0);
    const verified = await fetch(url, { method: 'POST', body: body('secret') });
    assert.equal(verified.status, 200);
    assert.equal(await verified.text(), 'Receipt recorded');
    assert.equal(verified.headers.get('cache-control'), 'no-store');
    assert.equal(receipts, 1);
    assert.equal(earlyAccessEnabled, true);
  });

  it('ignores spoofed forwarding headers unless the exact socket peer is configured as trusted', async () => {
    const key = Buffer.alloc(32, 7);
    const endpointId = 'p'.repeat(43);
    const integration = { id: 'integration', accountId: 'account', endpointId, verificationTokenCiphertext: '' };
    integration.verificationTokenCiphertext = encryptSetting('secret', key,
      integrationSecretOwner(integration), 'verification-token');
    /** @type {import('../src/kofi-ingestion.js').KofiDeliverySource[]} */
    const sources = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findIntegrationByEndpoint: async () => integration,
      recordKofiReceipt: async (/** @type {string} */ _id, /** @type {string} */ _token,
        /** @type {unknown} */ _payment, /** @type {string | undefined} */ _floor,
        /** @type {import('../src/kofi-ingestion.js').KofiDeliverySource} */ source) => {
        sources.push(source); return 'accepted';
      },
    }));
    const body = new URLSearchParams({ data: JSON.stringify({ ...membership, verification_token: 'secret' }) });
    const headers = { 'X-Renobot-Client-IP': '198.51.100.42', 'X-Renobot-Client-Port': '43210',
      'X-Forwarded-For': '203.0.113.4' };
    for (const trustedKofiProxyIp of [undefined, '127.0.0.2', '127.0.0.1']) {
      const base = await startServer({ database, settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' },
        ...(trustedKofiProxyIp ? { trustedKofiProxyIp } : {}) });
      assert.equal((await fetch(`${base}/prod/kofi/${endpointId}`, { method: 'POST', body, headers })).status, 200);
    }
    assert.equal(sources.length, 3);
    for (const source of sources.slice(0, 2)) {
      assert.equal(source.viaProxy, false);
      assert.equal(source.ip, '127.0.0.1');
      assert.ok(source.port && source.port > 0);
    }
    assert.deepEqual({ ip: sources[2]?.ip, port: sources[2]?.port, viaProxy: sources[2]?.viaProxy,
      peerIp: sources[2]?.peerIp }, { ip: '198.51.100.42', port: 43210, viaProxy: true, peerIp: '127.0.0.1' });
  });

  it('shows only the signed-in modder membership leases and recorded role-sync state', async () => {
    /** @type {string[]} */
    const owners = [];
    /** @type {string[]} */
    const lookups = [];
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      users: { fetch: async (/** @type {string} */ id) => {
        lookups.push(id);
        return { globalName: 'Preview Supporter', username: 'supporter' };
      } },
    }));
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      listKofiMemberships: async (/** @type {string} */ owner, /** @type {string} */ roleId,
        /** @type {string | undefined} */ before) => {
        owners.push(owner);
        assert.equal(roleId, 'role');
        return { members: before ? [] : [{ discordUserId: '12345678901234567',
          expiresAt: new Date('2099-10-29T00:00:00Z'), lastPaymentAt: new Date('2026-09-29T00:00:00Z'),
          roleManaged: true, sync: { nextAttemptAt: new Date('2099-10-29T00:00:00Z'), lastErrorCode: null } }],
        nextCursor: before ? null : 'lease-id' };
      },
    }));
    const base = await startServer({ bot, database, supporterRoleId: 'role',
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const path = '/app/api/modder/kofi/memberships';
    const owner = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    const member = { Cookie: `renobot_session=${createSession({ id: 'member', username: 'member' }, secret)}` };
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: member })).status, 403);
    assert.equal((await fetch(`${base}${path}?before=%3Cscript%3E`, { headers: owner })).status, 400);
    const result = await (await fetch(`${base}${path}`, { headers: owner })).json();
    assert.deepEqual(result.members[0], { discordUserId: '12345678901234567', discordName: 'Preview Supporter', active: true,
      expiresAt: '2099-10-29T00:00:00.000Z', lastPaymentAt: '2026-09-29T00:00:00.000Z',
      roleStatus: 'granted-by-renobot', nextAttemptAt: '2099-10-29T00:00:00.000Z' });
    assert.equal(result.nextCursor, 'lease-id');
    assert.deepEqual((await (await fetch(`${base}${path}?before=lease-id`, { headers: owner })).json()).members, []);
    assert.deepEqual(owners, ['owner', 'owner']);
    assert.deepEqual(lookups, ['12345678901234567']);
  });

  it('keeps memberships visible when a Discord name lookup fails', async () => {
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      users: { fetch: async () => { throw new Error('Discord unavailable'); } },
    }));
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      listKofiMemberships: async () => ({ members: [{ discordUserId: '12345678901234567',
        expiresAt: new Date('2099-10-29T00:00:00Z'), lastPaymentAt: new Date('2026-09-29T00:00:00Z'),
        roleManaged: false, sync: null }], nextCursor: null }),
    }));
    const base = await startServer({ bot, database,
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const owner = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    const result = await (await fetch(`${base}/app/api/modder/kofi/memberships`, { headers: owner })).json();
    assert.equal(result.members[0].discordName, null);
    assert.equal(result.members[0].discordUserId, '12345678901234567');
  });

  it('checks actual Discord roles only for supporters belonging to the signed-in modder', async () => {
    let lookups = 0;
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true, guilds: { fetch: async () => ({ members: { fetch: async () => {
        lookups++;
        return { roles: { cache: { has: () => true } } };
      } } }) },
    }));
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      hasKofiMembership: async (/** @type {string} */ owner, /** @type {string} */ supporter) =>
        owner === 'owner' && supporter === '12345678901234567',
    }));
    const base = await startServer({ bot, database, supporterRoleId: 'role',
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const path = '/app/api/modder/kofi/memberships/12345678901234567';
    const owner = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    const member = { Cookie: `renobot_session=${createSession({ id: 'member', username: 'member' }, secret)}` };
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: member })).status, 403);
    assert.equal((await fetch(`${base}/app/api/modder/kofi/memberships/23456789012345678`, { headers: owner })).status, 404);
    assert.equal(lookups, 0);
    assert.deepEqual(await (await fetch(`${base}${path}`, { headers: owner })).json(), { rolePresent: true });
    assert.equal(lookups, 1);
  });

  it('returns one stable webhook URL for a configured integration', async () => {
    const key = Buffer.alloc(32, 7);
    const endpointId = 'a'.repeat(43);
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async () => ({ endpointId, minimumAmount: { toFixed: () => '5.00' },
        verificationTokenCiphertext: 'configured', lastWebhookAt: new Date('2026-09-28T12:00:00Z') }),
      findIntegrationByEndpoint: async () => null,
    }));
    const baseUrl = await startServer({ database, settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' } });
    const cookie = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    assert.equal((await fetch(`${baseUrl}/prod/kofi/${endpointId}`, {
      method: 'POST', body: new URLSearchParams({ data: '{}' }),
    })).status, 403);
    const stream = await fetch(`${baseUrl}/app/api/modder/kofi/events`, { headers: cookie });
    assert.equal(stream.status, 200);
    await stream.body?.cancel();
    const status = await fetch(`${baseUrl}/app/api/modder/kofi`, { headers: cookie });
    assert.equal(status.status, 200);
    const disabled = await status.json();
    assert.equal(disabled.prodUrl, `https://renobot.example/prod/kofi/${endpointId}`);
    assert.equal(disabled.lastWebhookAt, '2026-09-28T12:00:00.000Z');
    assert.equal(disabled.devUrl, undefined);
  });

  it('records only verified prod receipts and scopes entry reads and SSE to the modder', async () => {
    const key = Buffer.alloc(32, 7);
    const endpointId = 'z'.repeat(43);
    const integration = { id: 'owned-integration', accountId: 'account', endpointId,
      verificationTokenCiphertext: '' };
    integration.verificationTokenCiphertext = encryptSetting('secret', key,
      integrationSecretOwner(integration), 'verification-token');
    /** @type {import('../src/kofi-ingestion.js').KofiPayment[]} */
    const receipts = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async (/** @type {string} */ id) => id === 'owner' ? integration : null,
      findIntegrationByEndpoint: async (/** @type {string} */ id) => id === endpointId ? integration : null,
      recordKofiReceipt: async (/** @type {string} */ id, /** @type {string} */ ciphertext,
        /** @type {import('../src/kofi-ingestion.js').KofiPayment} */ payment) => {
        assert.equal(id, integration.id);
        assert.equal(ciphertext, integration.verificationTokenCiphertext);
        if (receipts.some((entry) => entry.messageId === payment.messageId)) return 'duplicate';
        receipts.push(payment);
        return 'accepted';
      },
      listKofiEntries: async (/** @type {string} */ owner) => ({ entries: owner === 'owner' ? receipts.map((payment) => ({
        id: payment.messageId, messageId: payment.messageId, transactionId: payment.transactionId,
        eventType: payment.eventType, amount: { toFixed: () => payment.amount },
        currency: payment.currency, subscriptionPayment: payment.subscriptionPayment,
        firstSubscriptionPayment: payment.firstSubscriptionPayment, tierName: payment.tierName,
        supporterDiscordUserId: payment.supporterDiscordUserId, occurredAt: payment.occurredAt,
        receivedAt: new Date('2026-09-29T00:00:00Z'), outcome: 'recorded-no-entitlement',
      })) : [], nextCursor: null }),
      recordKofiPayment: () => { throw new Error('No entitlement ingestion'); },
    }));
    const baseUrl = await startServer({ database,
      settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' } });
    const cookie = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi/entries`)).status, 401);
    const stream = await fetch(`${baseUrl}/app/api/modder/kofi/events`, { headers: cookie });
    const reader = stream.body?.getReader();
    assert.ok(reader);
    try {
      assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/u);
      const send = (/** @type {string} */ token) => fetch(`${baseUrl}/prod/kofi/${endpointId}`, {
        method: 'POST', body: new URLSearchParams({ data: JSON.stringify({
          verification_token: token, message_id: 'unique', kofi_transaction_id: 'transaction',
          timestamp: '2026-09-29T01:31:20Z', type: 'Subscription', amount: '6.00', currency: 'USD',
          is_subscription_payment: true, discord_userid: '12345678901234567',
          email: 'private@example.com', message: 'never display',
        }) }),
      });
      assert.equal((await send('wrong')).status, 403);
      assert.equal(receipts.length, 0);
      assert.equal((await send('secret')).status, 200);
      const notice = new TextDecoder().decode((await reader.read()).value);
      assert.match(notice, /event: receipt/u);
      assert.doesNotMatch(notice, /private@example|never display|secret|12345678901234567/u);
      assert.equal((await send('secret')).status, 200);
      assert.equal(receipts.length, 1);
      const listed = await fetch(`${baseUrl}/app/api/modder/kofi/entries`, { headers: cookie });
      const { entries } = await listed.json();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].supporterDiscordUserId, '12345678901234567');
      assert.equal(entries[0].transactionId, 'transaction');
      assert.equal(entries[0].outcome, 'recorded-no-entitlement');
      assert.doesNotMatch(JSON.stringify(entries), /private@example|never display|secret/u);
      assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi/entries?before=${'x'.repeat(65)}`,
        { headers: cookie })).status, 400);
    } finally {
      await reader.cancel();
    }
  });

  it('does not acknowledge a verified prod delivery when the ledger write fails', async () => {
    const key = Buffer.alloc(32, 7);
    const endpointId = 'p'.repeat(43);
    const integration = { id: 'owner-integration', accountId: 'account', endpointId,
      verificationTokenCiphertext: '' };
    integration.verificationTokenCiphertext = encryptSetting('secret', key,
      integrationSecretOwner(integration), 'verification-token');
    let attempts = 0;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findIntegrationByEndpoint: async () => integration,
      recordKofiReceipt: async () => { attempts++; throw new Error('disk unavailable'); },
    }));
    const baseUrl = await startServer({ ready: false, database,
      settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' } });
    const send = () => fetch(`${baseUrl}/prod/kofi/${endpointId}`, { method: 'POST', body: new URLSearchParams({
      data: JSON.stringify({ verification_token: 'secret', message_id: 'payment',
        kofi_transaction_id: 'tx', timestamp: '2026-09-29T01:31:20Z', type: 'Donation',
        amount: '5.00', currency: 'USD' }),
    }) });
    assert.equal((await send()).status, 502);
    assert.equal((await send()).status, 502);
    assert.equal(attempts, 2);
  });

  it('restricts cross-modder receipts and sanitized webhook events to the configured owner', async () => {
    const key = Buffer.alloc(32, 7);
    const endpointId = 'v'.repeat(43);
    const integration = { id: 'integration', accountId: 'account', endpointId, verificationTokenCiphertext: '' };
    integration.verificationTokenCiphertext = encryptSetting('secret', key,
      integrationSecretOwner(integration), 'verification-token');
    let fail = false;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findIntegrationByEndpoint: async () => integration,
      recordKofiReceipt: async () => {
        if (fail) throw new Error('sensitive database error');
        return 'accepted';
      },
      listAdminKofiEntries: async (/** @type {string | undefined} */ before) => ({
        entries: before ? [] : [{ id: 'receipt', integration: { account: {
          discordUserId: '12345678901234567', lastKnownUsername: 'modder',
        } }, transactionId: 'tx', eventType: 'Subscription', amount: { toFixed: () => '5.00' },
        currency: 'USD', receivedAt: new Date('2026-09-29T01:00:00Z'), outcome: 'recorded-no-entitlement',
        sourceIp: '198.51.100.42', sourcePort: 43210, sourceViaProxy: true,
        peerIp: '172.18.0.1', peerPort: 50000 }],
        nextCursor: before ? null : 'receipt',
      }),
    }));
    const baseUrl = await startServer({ database,
      settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' } });
    const owner = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    const member = { Cookie: `renobot_session=${createSession({ id: 'member', username: 'member' }, secret)}` };
    for (const path of ['/app/api/admin/kofi/entries', '/app/api/admin/kofi/operations']) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: member })).status, 403);
    }
    assert.equal((await fetch(`${baseUrl}/app/api/admin/kofi/entries?before=%3Cscript%3E`, { headers: owner })).status, 400);
    const send = (/** @type {string} */ token) => fetch(`${baseUrl}/prod/kofi/${endpointId}`, {
      method: 'POST', body: new URLSearchParams({ data: JSON.stringify({
        verification_token: token, message_id: 'membership', kofi_transaction_id: 'tx',
        timestamp: '2026-09-29T01:00:00Z', type: 'Subscription', amount: '5.00', currency: 'USD',
        email: 'private@example.com', message: 'private note',
      }) }),
    });
    assert.equal((await send('wrong')).status, 403);
    assert.equal((await send('secret')).status, 200);
    fail = true;
    assert.equal((await send('secret')).status, 502);
    const operations = await fetch(`${baseUrl}/app/api/admin/kofi/operations`, { headers: owner });
    assert.deepEqual((await operations.json()).events.map((/** @type {{event: string}} */ event) => event.event),
      ['storage-failure', 'accepted', 'rejected']);
    assert.doesNotMatch(JSON.stringify(await (await fetch(`${baseUrl}/app/api/admin/kofi/operations`,
      { headers: owner })).json()), /secret|private|membership|sensitive database error|integration/u);
    const entries = await fetch(`${baseUrl}/app/api/admin/kofi/entries`, { headers: owner });
    assert.equal(entries.headers.get('cache-control'), 'no-store');
    const listed = await entries.json();
    assert.equal(listed.entries[0].ownerDiscordUserId, '12345678901234567');
    assert.deepEqual({ ip: listed.entries[0].sourceIp, port: listed.entries[0].sourcePort,
      viaProxy: listed.entries[0].sourceViaProxy }, { ip: '198.51.100.42', port: 43210, viaProxy: true });
    assert.equal(listed.nextCursor, 'receipt');
    assert.doesNotMatch(JSON.stringify(listed), /private@example|secret|verificationToken/u);
    assert.deepEqual((await (await fetch(`${baseUrl}/app/api/admin/kofi/entries?before=receipt`,
      { headers: owner })).json()).entries, []);
  });

  it('streams only verified receipt notices to the current authorized integration owner', async () => {
    const key = Buffer.alloc(32, 7);
    const endpoints = ['a'.repeat(43), 'b'.repeat(43)];
    const owners = ['alpha', 'beta'];
    const integrations = endpoints.map((endpointId, index) => {
      const integration = { id: `integration-${index}`, accountId: `account-${index}`, endpointId,
        verificationTokenCiphertext: '' };
      integration.verificationTokenCiphertext = encryptSetting('secret', key,
        integrationSecretOwner(integration), 'verification-token');
      return integration;
    });
    let alphaAllowed = true;
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      guilds: { fetch: async () => ({ members: { fetch: async (/** @type {{ user: string }} */ options) => ({
        roles: { cache: { has: () => options.user === 'beta' || (options.user === 'alpha' && alphaAllowed) } },
      }) } }) },
    }));
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async (/** @type {string} */ id) => integrations[owners.indexOf(id)] ?? null,
      findIntegrationByEndpoint: async (/** @type {string} */ id) => integrations[endpoints.indexOf(id)] ?? null,
      recordKofiReceipt: async () => 'accepted',
    }));
    const baseUrl = await startServer({ bot, database, config: { ...config, modderRoleId: 'modder' },
      settingsConfig: { key, minimumAmount: '5.00', currency: 'USD' } });
    const stream = (/** @type {string} */ id) => fetch(`${baseUrl}/app/api/modder/kofi/events`, {
      headers: { Cookie: `renobot_session=${createSession({ id, username: id }, secret)}` },
    });
    assert.equal((await stream('visitor')).status, 403);
    assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi/events`)).status, 401);
    const alpha = await stream('alpha');
    const beta = await stream('beta');
    assert.equal(alpha.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const alphaReader = alpha.body?.getReader();
    const betaReader = beta.body?.getReader();
    assert.ok(alphaReader && betaReader);
    try {
      assert.match(new TextDecoder().decode((await alphaReader.read()).value), /: connected/u);
      assert.match(new TextDecoder().decode((await betaReader.read()).value), /: connected/u);
      const send = (/** @type {string} */ endpointId, /** @type {string} */ amount, /** @type {string} */ token = 'secret') => fetch(`${baseUrl}/prod/kofi/${endpointId}`, {
        method: 'POST', body: new URLSearchParams({ data: JSON.stringify({ verification_token: token,
          message_id: 'test', kofi_transaction_id: 'transaction', timestamp: '2026-09-18T01:31:20Z',
          type: 'Donation', amount, currency: 'USD', email: 'private@example.com', message: 'do not send',
        }) }),
      });
      assert.equal((await send(endpoints[0] ?? '', '3.00', 'wrong')).status, 403);
      assert.equal((await send(endpoints[0] ?? '', '3.00')).status, 200);
      const alphaEvent = new TextDecoder().decode((await alphaReader.read()).value);
      assert.match(alphaEvent, /event: receipt/u);
      assert.doesNotMatch(alphaEvent, /private@example|do not send|"verificationToken"|"messageId"|3\.00/u);
      assert.equal((await send(endpoints[1] ?? '', '7.00')).status, 200);
      const betaEvent = new TextDecoder().decode((await betaReader.read()).value);
      assert.match(betaEvent, /event: receipt/u);
      assert.doesNotMatch(betaEvent, /3\.00|private@example/u);
      alphaAllowed = false;
      assert.equal((await send(endpoints[0] ?? '', '4.00')).status, 200);
      assert.equal((await alphaReader.read()).done, true);
    } finally {
      await alphaReader.cancel();
      await betaReader.cancel();
    }
  });

  it('requires fresh modder roles and CSRF for own settings, never exposing secrets or an activation URL', async () => {
    let hasRole = true;
    let unavailable = false;
    /** @type {unknown[]} */
    const writes = [];
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      guilds: { fetch: async () => {
        if (unavailable) throw new Error('Discord unavailable');
        return { members: { fetch: async () => ({ roles: { cache: { has: () => hasRole } } }) } };
      } },
    }));
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async () => null,
      saveIntegration: async (/** @type {unknown} */ user, /** @type {unknown} */ settings) => {
        writes.push({ user, settings });
      },
    }));
    const baseUrl = await startServer({ bot, database, config: { ...config, modderRoleId: 'modder' },
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const token = createSession({ id: 'member', username: 'member' }, secret);
    const headers = { Cookie: `renobot_session=${token}` };
    const data = new URLSearchParams({ csrf: csrfToken(token, secret), minimumAmount: '5.00', currency: 'USD',
      verificationToken: 'top-secret', forwardUrlAction: 'replace', forwardUrl: 'https://example.com/hooks' });
    const post = (/** @type {URLSearchParams} */ body) => fetch(`${baseUrl}/app/api/modder/kofi`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi`, { method: 'POST', body: data })).status, 401);
    assert.equal((await post(new URLSearchParams({ ...Object.fromEntries(data), csrf: 'bad' }))).status, 403);
    assert.equal((await post(new URLSearchParams({ ...Object.fromEntries(data), enabled: 'true' }))).status, 400);
    assert.equal(writes.length, 0);
    data.delete('minimumAmount');
    const saved = await post(data);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { configured: false, currency: 'USD',
      hasVerificationToken: false, hasForwardUrl: false, active: false,
      prodUrl: null, lastWebhookAt: null });
    assert.equal(writes.length, 1);
    assert.deepEqual(/** @type {any} */ (writes[0]).user, { id: 'member', username: 'member' });
    const settings = /** @type {any} */ (writes[0]).settings;
    assert.equal(settings.minimumAmount, '5.00');
    assert.equal(settings.verificationToken, 'top-secret');
    assert.equal(settings.forwardUrl, 'https://example.com/hooks');
    assert.equal(settings.forwardUrlAction, 'replace');
    assert.doesNotMatch(JSON.stringify(writes), /"enabled"/u);
    hasRole = false;
    assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi`, { headers })).status, 403);
    assert.equal((await post(data)).status, 403);
    assert.equal(writes.length, 1);
    unavailable = true;
    assert.equal((await fetch(`${baseUrl}/app/api/modder/kofi`, { headers })).status, 503);
  });

  it('fails closed when settings storage is absent, uninitialized, or fails without logging secrets', async () => {
    const owner = createSession({ id: 'owner', username: 'owner' }, secret);
    const headers = { Cookie: `renobot_session=${owner}`, 'Content-Type': 'application/x-www-form-urlencoded' };
    const settingsConfig = { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' };
    const missingDb = await startServer({ settingsConfig });
    assert.equal((await fetch(`${missingDb}/app/api/modder/kofi`, { headers })).status, 503);
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async () => null,
      saveIntegration: async () => { throw new MissingVerificationTokenError('Verification token required.'); },
    }));
    const baseUrl = await startServer({ settingsConfig, database });
    const body = new URLSearchParams({ csrf: csrfToken(owner, secret), minimumAmount: '5.00', currency: 'USD',
      verificationToken: '', forwardUrlAction: 'keep', forwardUrl: '' });
    const response = await fetch(`${baseUrl}/app/api/modder/kofi`, { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'A verification token is required for new settings' });
  });

  it('returns safe status for existing settings without revealing credentials or an endpoint', async () => {
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      getIntegration: async () => ({ minimumAmount: { toFixed: () => '7.50' },
        verificationTokenCiphertext: 'v1:secret-token', forwardUrlCiphertext: 'v1:secret-url',
        endpointId: 'private-endpoint', enabled: false }),
    }));
    const baseUrl = await startServer({ database,
      settingsConfig: { key: Buffer.alloc(32, 7), minimumAmount: '5.00', currency: 'USD' } });
    const cookie = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    const result = await fetch(`${baseUrl}/app/api/modder/kofi`, { headers: cookie });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { configured: true, currency: 'USD',
      hasVerificationToken: true, hasForwardUrl: true, active: false,
      prodUrl: 'https://renobot.example/prod/kofi/private-endpoint', lastWebhookAt: null });
  });

  it('returns 404 for unavailable app pages regardless of cookies', async () => {
    const baseUrl = await startServer();
    const anonymous = await fetch(`${baseUrl}/app/account`, { redirect: 'manual' });
    const session = createSession({ id: 'visitor', username: 'visitor' }, secret);
    const missing = await fetch(`${baseUrl}/app/account`, { headers: { Cookie: `renobot_session=${session}` } });

    assert.equal(anonymous.status, 404);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /This page does not exist/u);
  });

  it('does not look up roles merely to serve or reject public HTML', async () => {
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      guilds: { fetch: async () => { throw new Error('Discord unavailable'); } },
    }));
    const baseUrl = await startServer({ bot, config: { ...config, modderRoleId: 'modder' } });
    assert.equal((await fetch(`${baseUrl}/app`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/app/modder`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/app/admin/appeals`)).status, 404);
  });

  it('authorizes capability endpoints on each request using current member roles', async () => {
    let roles = ['modder'];
    let lookups = 0;
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      guilds: { fetch: async () => ({ members: { fetch: async () => {
        lookups += 1;
        return { roles: { cache: { has: (/** @type {string} */ role) => roles.includes(role) } } };
      } } }) },
    }));
    const baseUrl = await startServer({ bot, config: { ...config, modderRoleId: 'modder', moderatorRoleId: 'moderator' } });
    const cookie = { Cookie: `renobot_session=${createSession({ id: 'visitor', username: 'visitor' }, secret)}` };
    assert.equal((await fetch(`${baseUrl}/app/api/capabilities`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/app/api/admin/access`, { headers: cookie })).status, 403);
    assert.equal((await fetch(`${baseUrl}/app/api/admin/appeals/access`, { headers: cookie })).status, 403);
    assert.deepEqual(await (await fetch(`${baseUrl}/app/api/capabilities`, { headers: cookie })).json(),
      { capabilities: ['authenticated', 'modder'] });
    assert.deepEqual(await (await fetch(`${baseUrl}/app/api/modder/access`, { headers: cookie })).json(),
      { capability: 'modder' });
    roles = ['moderator'];
    assert.equal((await fetch(`${baseUrl}/app/api/modder/access`, { headers: cookie })).status, 403);
    assert.equal((await fetch(`${baseUrl}/app/api/admin/appeals/access`, { headers: cookie })).status, 200);
    assert.deepEqual(await (await fetch(`${baseUrl}/app/api/capabilities`, { headers: cookie })).json(),
      { capabilities: ['authenticated', 'appeal:review'] });
    assert.equal(lookups, 7);
  });

  it('handles confirmed non-members, owner bypass and Discord failures', async () => {
    /** @type {Error} */
    let failure = new DiscordAPIError({ code: 10007, message: 'Unknown Member' }, 10007, 404,
      'GET', 'https://discord.com/api/v10/guilds/g/members/u', { body: null, files: undefined });
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      guilds: { fetch: async () => ({ members: { fetch: async () => { throw failure; } } }) },
    }));
    const baseUrl = await startServer({ bot, config: { ...config, modderRoleId: 'modder' } });
    const visitor = { Cookie: `renobot_session=${createSession({ id: 'visitor', username: 'visitor' }, secret)}` };
    const owner = { Cookie: `renobot_session=${createSession({ id: 'owner', username: 'owner' }, secret)}` };
    assert.deepEqual(await (await fetch(`${baseUrl}/app/api/capabilities`, { headers: visitor })).json(),
      { capabilities: ['authenticated'] });
    assert.equal((await fetch(`${baseUrl}/app/api/modder/access`, { headers: visitor })).status, 403);
    failure = new Error('Discord unavailable');
    const unavailable = await fetch(`${baseUrl}/app/api/capabilities`, { headers: visitor });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'Please try again later' });
    assert.equal((await fetch(`${baseUrl}/app/api/modder/access`, { headers: visitor })).status, 503);
    assert.deepEqual(await (await fetch(`${baseUrl}/app/api/capabilities`, { headers: owner })).json(),
      { capabilities: ['authenticated', 'admin', 'modder', 'appeal:review'] });
    assert.equal((await fetch(`${baseUrl}/app/api/admin/access`, { headers: owner })).status, 200);
    assert.equal((await fetch(`${baseUrl}/app/api/admin/appeals/access`, { headers: owner })).status, 200);
  });

  it('grants ordinary guild members only basic capabilities and does not expose unknown APIs', async () => {
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
      isReady: () => true,
      guilds: { fetch: async () => ({ members: { fetch: async () => ({
        roles: { cache: { has: () => false } },
      }) } }) },
    }));
    const baseUrl = await startServer({ bot, config: { ...config, modderRoleId: 'modder' } });
    const headers = { Cookie: `renobot_session=${createSession({ id: 'member', username: 'member' }, secret)}` };
    assert.deepEqual(await (await fetch(`${baseUrl}/app/api/capabilities`, { headers })).json(),
      { capabilities: ['authenticated'] });
    assert.equal((await fetch(`${baseUrl}/app/api/modder/access`, { headers })).status, 403);
    assert.equal((await fetch(`${baseUrl}/app/api/modder/private`, { headers })).status, 404);
  });

  it('rejects unsafe login returns before contacting Discord', async () => {
    const baseUrl = await startServer();
    for (const path of ['https://evil.test', '//evil.test', '/app/%2f%2fevil', '/app/../auth/logout']) {
      const response = await fetch(`${baseUrl}/auth/discord?returnTo=${encodeURIComponent(path)}`, { redirect: 'manual' });
      assert.equal(response.status, 400, path);
      assert.equal(response.headers.get('location'), null);
    }
  });

  it('returns to a signed app path after login', async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'visitor', username: 'visitor' }), { status: 200 }),
    ];
    const baseUrl = await startServer({ request: async () => responses.shift() ?? new Response(null, { status: 500 }) });
    const login = await beginLogin(baseUrl, '/app/modder');
    const callback = await fetch(`${baseUrl}/auth/discord/callback?code=code&state=${encodeURIComponent(login.state)}`, {
      headers: { Cookie: login.cookie }, redirect: 'manual',
    });
    assert.equal(callback.headers.get('location'), '/app/modder');
  });

  it('rejects callbacks with invalid state before contacting Discord', async () => {
    let requests = 0;
    const baseUrl = await startServer({ request: async () => { requests += 1; return new Response(); } });
    const response = await fetch(`${baseUrl}/auth/discord/callback?code=code&state=invalid`, {
      headers: { Cookie: 'renobot_oauth_state=invalid' },
      redirect: 'manual',
    });

    assert.equal(response.status, 400);
    assert.equal(requests, 0);
  });

  it('creates a logged-in session without assigning privileged access', async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'stranger', username: 'visitor' }), { status: 200 }),
    ];
    const baseUrl = await startServer({ request: async () => responses.shift() ?? new Response(null, { status: 500 }) });
    const login = await beginLogin(baseUrl);
    const response = await fetch(`${baseUrl}/auth/discord/callback?code=code&state=${encodeURIComponent(login.state)}`, {
      headers: { Cookie: login.cookie },
      redirect: 'manual',
    });
    const session = (response.headers.get('set-cookie') ?? '').split(';', 1)[0];
    if (!session) throw new Error('Expected an application session cookie.');
    const app = await fetch(`${baseUrl}/app`, { headers: { Cookie: session } });
    const html = await app.text();
    const account = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: session } });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/app');
    assert.match(session, /^renobot_session=/u);
    assert.equal(app.status, 200);
    assert.match(html, /Hi, <strong id="username">Loading…<\/strong>\./u);
    assert.deepEqual(await account.json(), { username: 'visitor', ready: true, owner: false,
      csrf: csrfToken(session.split('=')[1] ?? '', secret) });
    assert.match(html, /id="account-emails"/u);
  });

  it('persists an OAuth identity before issuing a session and denies login on persistence failure', async () => {
    /** @type {unknown[]} */
    const saved = [];
    let fail = false;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      saveLogin: async (/** @type {unknown} */ user) => {
        saved.push(user);
        if (fail) throw new Error('database unavailable');
      },
    }));
    const request = async (/** @type {RequestInfo | URL} */ url) => new Response(JSON.stringify(
      String(url).endsWith('/token') ? { access_token: 'token' } : { id: 'visitor', username: 'visitor' },
    ));
    const baseUrl = await startServer({ database, request });
    const first = await beginLogin(baseUrl);
    const success = await fetch(`${baseUrl}/auth/discord/callback?code=code&state=${encodeURIComponent(first.state)}`, {
      headers: { Cookie: first.cookie }, redirect: 'manual',
    });
    assert.equal(success.status, 303);
    assert.deepEqual(saved, [{ id: 'visitor', username: 'visitor' }]);
    fail = true;
    const second = await beginLogin(baseUrl);
    const denied = await fetch(`${baseUrl}/auth/discord/callback?code=code&state=${encodeURIComponent(second.state)}`, {
      headers: { Cookie: second.cookie }, redirect: 'manual',
    });
    assert.equal(denied.status, 502);
    assert.doesNotMatch(denied.headers.get('set-cookie') ?? '', /renobot_session=/u);
  });

  it('returns owner account data as JSON without embedding it in HTML', async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'owner', username: '<owner>' }), { status: 200 }),
    ];
    const baseUrl = await startServer({ request: async () => responses.shift() ?? new Response(null, { status: 500 }) });
    const login = await beginLogin(baseUrl);
    const callback = await fetch(`${baseUrl}/auth/discord/callback?code=code&state=${encodeURIComponent(login.state)}`, {
      headers: { Cookie: login.cookie },
      redirect: 'manual',
    });
    const session = (callback.headers.get('set-cookie') ?? '').split(';', 1)[0];
    if (!session) throw new Error('Expected a dashboard session cookie.');
    const app = await fetch(`${baseUrl}/app`, { headers: { Cookie: session } });
    const html = await app.text();

    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/app');
    assert.match(session, /^renobot_session=/u);
    assert.equal(app.status, 200);
    assert.doesNotMatch(html, /<owner>|&lt;owner&gt;/u);
    assert.match(html, /id="account-emails"/u);
    const account = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: session } });
    assert.deepEqual(await account.json(), { username: '<owner>', ready: true, owner: true,
      csrf: csrfToken(session.split('=')[1] ?? '', secret) });
  });

  it('never puts account text or tokens in static HTML', async () => {
    const baseUrl = await startServer();
    const session = createSession({ id: 'visitor', username: '<visitor>{{csrf}}' }, secret);
    const cookie = `renobot_session=${session}`;
    const app = await fetch(`${baseUrl}/app`, { headers: { Cookie: cookie } });
    const home = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
    const html = await app.text();

    const anonymousHome = await fetch(`${baseUrl}/`);
    assert.equal(await home.text(), await anonymousHome.text());
    assert.doesNotMatch(html, /visitor|\{\{|name="csrf" value="[^"]+"/u);
    const account = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: cookie } });
    assert.equal((await account.json()).username, '<visitor>{{csrf}}');
    const anonymous = await fetch(`${baseUrl}/auth/session`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { authenticated: false });
    assert.equal(account.headers.get('cache-control'), 'no-store');
  });

  it('requires a valid per-session CSRF token to sign out', async () => {
    const baseUrl = await startServer();
    const session = createSession({ id: 'visitor', username: 'visitor' }, secret);
    const cookie = `renobot_session=${session}`;
    const csrf = csrfToken(session, secret);
    const anonymous = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', redirect: 'manual' });
    const denied = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'invalid' }), redirect: 'manual',
    });
    const oversized = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, padding: 'x'.repeat(4096) }), redirect: 'manual',
    });
    const app = await fetch(`${baseUrl}/app`, { headers: { Cookie: cookie } });
    assert.match(await app.text(), /name="csrf" id="csrf"/u);
    const account = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: cookie } });
    assert.equal((await account.json()).csrf, csrf);
    const response = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });

    assert.equal(anonymous.status, 403);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('set-cookie'), null);
    assert.equal(oversized.status, 413);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.match(response.headers.get('set-cookie') ?? '', /^renobot_session=;.*Max-Age=0/u);
  });
});
