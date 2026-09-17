import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createWebServer } from '../src/web-server.js';

const secret = '01234567890123456789012345678901';
const config = Object.freeze({
  clientId: 'client',
  clientSecret: 'client-secret',
  host: '127.0.0.1',
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
 * @param {Readonly<{ ready?: boolean, request?: typeof fetch }>} [options]
 */
async function startServer(options = {}) {
  const logger = { error() {}, warn() {} };
  const server = createWebServer({
    bot: /** @type {import('discord.js').Client} */ ({ isReady: () => options.ready ?? true }),
    config,
    logger: /** @type {import('pino').Logger} */ (/** @type {unknown} */ (logger)),
    ...(options.request ? { request: options.request } : {}),
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

/** @param {string} baseUrl */
async function beginLogin(baseUrl) {
  const response = await fetch(`${baseUrl}/auth/discord`, { redirect: 'manual' });
  const location = new URL(response.headers.get('location') ?? '');
  const cookie = response.headers.get('set-cookie') ?? '';
  const state = location.searchParams.get('state') ?? '';
  const cookiePair = cookie.split(';', 1)[0];
  if (!cookiePair) throw new Error('Expected an OAuth state cookie.');
  return { cookie: cookiePair, location, state };
}

describe('dashboard routes', () => {
  it('reports Discord readiness without exposing a cacheable response', async () => {
    const baseUrl = await startServer({ ready: false });
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('redirects unauthenticated users into a bounded Discord identify flow', async () => {
    const baseUrl = await startServer();
    const home = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    const login = await beginLogin(baseUrl);

    assert.equal(home.status, 303);
    assert.equal(home.headers.get('location'), '/auth/discord');
    assert.equal(login.location.origin, 'https://discord.com');
    assert.equal(login.location.pathname, '/oauth2/authorize');
    assert.equal(login.location.searchParams.get('scope'), 'identify');
    assert.equal(login.location.searchParams.get('redirect_uri'), 'https://renobot.example/auth/discord/callback');
    assert.match(login.cookie, /^renobot_oauth_state=/u);
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

  it('rejects a valid Discord user who is not the configured owner', async () => {
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

    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie')?.startsWith('renobot_session='), false);
  });

  it('creates an owner session and renders escaped account data', async () => {
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
    const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: session } });
    const html = await dashboard.text();

    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/');
    assert.match(session, /^renobot_session=/u);
    assert.equal(dashboard.status, 200);
    assert.match(html, /Signed in as &lt;owner&gt;\./u);
    assert.doesNotMatch(html, /Signed in as <owner>/u);
  });
});
