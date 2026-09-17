import { createServer } from 'node:http';

import { createOAuthState, createSession, readCookie, readSession, secureCookie, verifyOAuthState } from './web-session.js';

const stateCookie = 'renobot_oauth_state';
const sessionCookie = 'renobot_session';

/**
 * @param {Readonly<{
 *   bot: import('discord.js').Client,
 *   config: import('./web-config.js').WebConfig | undefined,
 *   logger: import('pino').Logger,
 *   request?: typeof fetch,
 * }>} options
 */
export function createWebServer(options) {
  const request = options.request ?? fetch;
  const server = createServer(async (incoming, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') {
        sendJson(response, options.bot.isReady() ? 200 : 503, { ready: options.bot.isReady() });
        return;
      }
      if (!options.config) {
        sendText(response, 404, 'Not found');
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/') {
        const session = readSession(readCookie(incoming.headers.cookie, sessionCookie), options.config.sessionSecret);
        if (!session || session.id !== options.config.ownerUserId) {
          redirect(response, '/auth/discord');
          return;
        }
        sendHtml(response, dashboardPage(session.username, options.bot.isReady()));
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/auth/discord') {
        const state = createOAuthState(options.config.sessionSecret);
        const authorize = new URL('https://discord.com/oauth2/authorize');
        authorize.search = new URLSearchParams({
          client_id: options.config.clientId,
          redirect_uri: new URL('/auth/discord/callback', options.config.publicBaseUrl).href,
          response_type: 'code',
          scope: 'identify',
          state,
        }).toString();
        response.setHeader('Set-Cookie', secureCookie(stateCookie, state, 600));
        redirect(response, authorize.href);
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/auth/discord/callback') {
        const state = url.searchParams.get('state') ?? '';
        const cookieState = readCookie(incoming.headers.cookie, stateCookie) ?? '';
        response.setHeader('Set-Cookie', secureCookie(stateCookie, '', 0));
        if (state !== cookieState || !verifyOAuthState(state, options.config.sessionSecret)) {
          sendText(response, 400, 'Invalid or expired login request.');
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          sendText(response, 400, 'Discord did not provide an authorization code.');
          return;
        }
        const user = await exchangeDiscordCode(options.config, code, request);
        if (user.id !== options.config.ownerUserId) {
          options.logger.warn({ userId: user.id }, 'Rejected dashboard login');
          sendText(response, 403, 'This dashboard is restricted.');
          return;
        }
        response.setHeader('Set-Cookie', secureCookie(sessionCookie,
          createSession(user, options.config.sessionSecret), 8 * 60 * 60));
        redirect(response, '/');
        return;
      }
      if (incoming.method === 'POST' && url.pathname === '/logout') {
        response.setHeader('Set-Cookie', secureCookie(sessionCookie, '', 0));
        redirect(response, '/');
        return;
      }
      sendText(response, 404, 'Not found');
    } catch (error) {
      options.logger.error({ err: error }, 'Dashboard request failed');
      sendText(response, 502, 'Unable to complete the request.');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

/** @param {import('./web-config.js').WebConfig} config @param {string} code @param {typeof fetch} request */
async function exchangeDiscordCode(config, code, request) {
  const tokenResponse = await request('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: new URL('/auth/discord/callback', config.publicBaseUrl).href,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status}).`);
  const token = /** @type {unknown} */ (await tokenResponse.json());
  if (!isRecord(token) || typeof token.access_token !== 'string') throw new Error('Discord returned an invalid token response.');
  const userResponse = await request('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userResponse.ok) throw new Error(`Discord user lookup failed (${userResponse.status}).`);
  const user = /** @type {unknown} */ (await userResponse.json());
  if (!isRecord(user) || typeof user.id !== 'string' || typeof user.username !== 'string') {
    throw new Error('Discord returned an invalid user response.');
  }
  return { id: user.id, username: user.username };
}

/** @param {string} username @param {boolean} ready */
function dashboardPage(username, ready) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Renobot</title><style>html{color-scheme:dark;font:16px system-ui;background:#111827;color:#e5e7eb}main{max-width:42rem;margin:10vh auto;padding:2rem;background:#1f2937;border-radius:1rem}button{padding:.7rem 1rem}</style><main><h1>Renobot</h1><p>Signed in as ${escapeHtml(username)}.</p><p>Discord connection: <strong>${ready ? 'ready' : 'not ready'}</strong></p><form method="post" action="/logout"><button>Sign out</button></form></main></html>`;
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** @param {import('node:http').ServerResponse} response @param {string} location */
function redirect(response, location) { response.writeHead(303, { Location: location }).end(); }
/** @param {import('node:http').ServerResponse} response @param {number} status @param {string} text */
function sendText(response, status, text) { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text); }
/** @param {import('node:http').ServerResponse} response @param {string} html */
function sendHtml(response, html) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); }
/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
function sendJson(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); }