import { createServer } from 'node:http';

import { appPage, errorPage, homePage, modderKofiPage, notFoundPage, siteCss, siteJs } from './web-assets.js';
import { requiredCapability, resolveCapabilities } from './web-capabilities.js';
import { MissingVerificationTokenError } from './database.js';
import { verifyKofiTestDelivery } from './kofi-ingestion.js';
import { parseModderSettings } from './modder-settings.js';
import { createOAuthState, createSession, csrfToken, oauthReturnTo, readCookie, readSession, safeAppPath, secureCookie, verifyCsrfToken, verifyOAuthState } from './web-session.js';

const stateCookie = 'renobot_oauth_state';
const sessionCookie = 'renobot_session';

/**
 * @param {Readonly<{
 *   bot: import('discord.js').Client,
 *   config: import('./web-config.js').WebConfig | undefined,
 *   database?: import('./database.js').PortalDatabase,
 *   settingsConfig?: import('./modder-settings.js').ModderSettingsConfig,
 *   logger: import('pino').Logger,
 *   request?: typeof fetch,
 * }>} options
 */
export function createWebServer(options) {
  const request = options.request ?? fetch;
  /** @type {Map<string, Set<{ userId: string, token: string, response: import('node:http').ServerResponse }>>} */
  const testSubscribers = new Map();
  /** @param {string} integrationId @param {import('./kofi-ingestion.js').KofiTestSummary} summary */
  function publishTest(integrationId, summary) {
    for (const subscriber of testSubscribers.get(integrationId) ?? []) {
      void (async () => {
        try {
          if (!readSession(subscriber.token, options.config?.sessionSecret ?? '')) {
            subscriber.response.end();
            return;
          }
          const capabilities = await resolveCapabilities(options.bot, /** @type {import('./web-config.js').WebConfig} */ (options.config), subscriber.userId);
          const integration = await options.database?.getIntegration(subscriber.userId);
          if (!capabilities.has('modder') || integration?.id !== integrationId) {
            subscriber.response.end();
            return;
          }
          if (!subscriber.response.destroyed) subscriber.response.write(`event: test-delivery\ndata: ${JSON.stringify(summary)}\n\n`);
        } catch { subscriber.response.end(); }
      })();
    }
  }
  const server = createServer(async (incoming, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') {
        const ready = options.bot.isReady() && (!options.database || await options.database.isReady());
        sendJson(response, ready ? 200 : 503, { ready });
        return;
      }
      if (!options.config) {
        sendText(response, 404, 'Not found');
        return;
      }
      const testEndpoint = /^\/test\/kofi\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname);
      if (incoming.method === 'POST' && testEndpoint && options.config.kofiTestMode) {
        if (!options.database || !options.settingsConfig) {
          sendText(response, 503, 'Unavailable');
          return;
        }
        if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(incoming.headers['content-type'] ?? '')) {
          sendText(response, 415, 'Unsupported content type');
          return;
        }
        const rawBody = await readBody(incoming, 32768);
        const verified = await verifyKofiTestDelivery(options.database, options.settingsConfig.key,
          testEndpoint[1] ?? '', rawBody, publishTest);
        sendText(response, verified ? 200 : 403, verified ? 'Test delivery verified' : 'Delivery not verified');
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/assets/site.css') {
        response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(siteCss);
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/assets/site.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(siteJs);
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/') {
        sendHtml(response, homePage);
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/auth/session') {
        const token = readCookie(incoming.headers.cookie, sessionCookie);
        const session = readSession(token, options.config.sessionSecret);
        if (!session) {
          sendJson(response, 401, { authenticated: false });
          return;
        }
        sendJson(response, 200, { username: session.username, ready: options.bot.isReady(),
          owner: session.id === options.config.ownerUserId, csrf: csrfToken(token ?? '', options.config.sessionSecret) });
        return;
      }
      if ((url.pathname === '/app/api/modder/kofi' && (incoming.method === 'GET' || incoming.method === 'POST'))
        || (options.config.kofiTestMode && url.pathname === '/app/api/modder/kofi/events' && incoming.method === 'GET')) {
        const token = readCookie(incoming.headers.cookie, sessionCookie);
        const session = readSession(token, options.config.sessionSecret);
        if (!session) {
          sendJson(response, 401, { error: 'Sign-in required' });
          return;
        }
        try {
          const capabilities = await resolveCapabilities(options.bot, options.config, session.id);
          if (!capabilities.has('modder')) {
            sendJson(response, 403, { error: 'Access denied' });
            return;
          }
        } catch {
          options.logger.warn('Portal role lookup failed');
          sendJson(response, 503, { error: 'Please try again later' });
          return;
        }
        if (!options.database || !options.settingsConfig) {
          sendJson(response, 503, { error: 'Settings are not configured' });
          return;
        }
        if (url.pathname === '/app/api/modder/kofi/events') {
          const integration = await options.database.getIntegration(session.id);
          if (!integration) {
            sendJson(response, 404, { error: 'No integration configured' });
            return;
          }
          let subscribers = testSubscribers.get(integration.id);
          if (!subscribers) {
            subscribers = new Set();
            testSubscribers.set(integration.id, subscribers);
          }
          if (subscribers.size >= 5) {
            sendJson(response, 429, { error: 'Too many test streams' });
            return;
          }
          const subscriber = { userId: session.id, token: token ?? '', response };
          subscribers.add(subscriber);
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write(': connected\n\n');
          const heartbeat = setInterval(() => {
            if (readSession(subscriber.token, options.config?.sessionSecret ?? '')) response.write(': heartbeat\n\n');
            else response.end();
          }, 20_000);
          const expiry = setTimeout(() => response.end(), 5 * 60_000);
          response.on('close', () => {
            clearInterval(heartbeat);
            clearTimeout(expiry);
            subscribers.delete(subscriber);
            if (subscribers.size === 0) testSubscribers.delete(integration.id);
          });
          return;
        }
        if (incoming.method === 'POST') {
          if (!incoming.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
            sendJson(response, 415, { error: 'Unsupported content type' });
            return;
          }
          const body = await readForm(incoming, 4096);
          if (!verifyCsrfToken(body.get('csrf') ?? '', token ?? '', options.config.sessionSecret)) {
            sendJson(response, 403, { error: 'Invalid CSRF token' });
            return;
          }
          const settings = parseModderSettings(body, options.settingsConfig);
          if (!settings) {
            sendJson(response, 400, { error: 'Invalid settings' });
            return;
          }
          try {
            await options.database.saveIntegration(session, settings, options.settingsConfig.key);
          } catch (error) {
            if (error instanceof MissingVerificationTokenError) {
              sendJson(response, 400, { error: 'A verification token is required for new settings' });
              return;
            }
            options.logger.warn('Modder settings write failed');
            sendJson(response, 503, { error: 'Please try again later' });
            return;
          }
        }
        try {
          const integration = await options.database.getIntegration(session.id);
          sendJson(response, 200, { configured: Boolean(integration), minimumAmount: integration?.minimumAmount.toFixed(2)
            ?? options.settingsConfig.minimumAmount, currency: options.settingsConfig.currency,
          floor: options.settingsConfig.minimumAmount, testModeEnabled: options.config.kofiTestMode,
          hasVerificationToken: Boolean(integration?.verificationTokenCiphertext),
          hasForwardUrl: Boolean(integration?.forwardUrlCiphertext), active: false,
          testUrl: options.config.kofiTestMode && integration
            ? new URL(`/test/kofi/${integration.endpointId}`, options.config.publicBaseUrl).href : null,
          lastTestAt: options.config.kofiTestMode ? integration?.lastTestAt?.toISOString() ?? null : null });
        } catch {
          options.logger.warn('Modder settings lookup failed');
          sendJson(response, 503, { error: 'Please try again later' });
        }
        return;
      }
      if (incoming.method === 'GET' && (url.pathname === '/app/api/capabilities'
        || url.pathname === '/app/api/modder/access'
        || url.pathname === '/app/api/admin/access'
        || url.pathname === '/app/api/admin/appeals/access')) {
        const session = readSession(readCookie(incoming.headers.cookie, sessionCookie), options.config.sessionSecret);
        if (!session) {
          sendJson(response, 401, { error: 'Sign-in required' });
          return;
        }
        try {
          const capabilities = await resolveCapabilities(options.bot, options.config, session.id);
          if (url.pathname === '/app/api/capabilities') {
            sendJson(response, 200, { capabilities: [...capabilities] });
            return;
          }
          const required = requiredCapability(url.pathname.replace('/app/api/', '/app/'));
          if (!required || !capabilities.has(required)) {
            sendJson(response, 403, { error: 'Access denied' });
            return;
          }
          sendJson(response, 200, { capability: required });
        } catch {
          options.logger.warn('Portal role lookup failed');
          sendJson(response, 503, { error: 'Please try again later' });
        }
        return;
      }
      if (incoming.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
        if (url.pathname === '/app/modder/kofi') {
          sendHtml(response, modderKofiPage);
          return;
        }
        if (url.pathname !== '/app') {
          sendHtml(response, notFoundPage, 404);
          return;
        }
        sendHtml(response, appPage);
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/auth/discord') {
        const returnTo = url.searchParams.get('returnTo') ?? '/app';
        if (!safeAppPath(returnTo)) {
          sendHtml(response, errorPage, 400);
          return;
        }
        const state = createOAuthState(options.config.sessionSecret, Date.now(), returnTo);
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
          sendHtml(response, errorPage, 400);
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          sendHtml(response, errorPage, 400);
          return;
        }
        const user = await exchangeDiscordCode(options.config, code, request);
        await options.database?.saveLogin(user);
        response.setHeader('Set-Cookie', secureCookie(sessionCookie,
          createSession(user, options.config.sessionSecret), 8 * 60 * 60));
        redirect(response, oauthReturnTo(state, options.config.sessionSecret));
        return;
      }
      if (incoming.method === 'POST' && url.pathname === '/auth/logout') {
        const token = readCookie(incoming.headers.cookie, sessionCookie);
        if (!readSession(token, options.config.sessionSecret)) {
          sendHtml(response, errorPage, 403);
          return;
        }
        if (!incoming.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
          sendHtml(response, errorPage, 403);
          return;
        }
        const body = await readForm(incoming, 4096);
        if (!verifyCsrfToken(body.get('csrf') ?? '', token ?? '', options.config.sessionSecret)) {
          sendHtml(response, errorPage, 403);
          return;
        }
        response.setHeader('Set-Cookie', secureCookie(sessionCookie, '', 0));
        redirect(response, '/');
        return;
      }
      sendHtml(response, notFoundPage, 404);
    } catch (error) {
      if (error instanceof RangeError) {
        sendHtml(response, errorPage, 413);
        return;
      }
      options.logger.error({ err: error }, 'Dashboard request failed');
      sendHtml(response, errorPage, 502);
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

/** @param {import('node:http').IncomingMessage} incoming @param {number} maxBytes */
async function readForm(incoming, maxBytes) {
  return new URLSearchParams((await readBody(incoming, maxBytes)).toString('utf8'));
}

/** @param {import('node:http').IncomingMessage} incoming @param {number} maxBytes */
async function readBody(incoming, maxBytes) {
  let length = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of incoming) {
    const bytes = /** @type {Buffer} */ (chunk);
    length += bytes.length;
    if (length > maxBytes) throw new RangeError('Form exceeds the permitted size.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** @param {import('node:http').ServerResponse} response @param {string} location */
function redirect(response, location) { response.writeHead(303, { Location: location }).end(); }
/** @param {import('node:http').ServerResponse} response @param {number} status @param {string} text */
function sendText(response, status, text) { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text); }
/** @param {import('node:http').ServerResponse} response @param {string} html @param {number} status */
function sendHtml(response, html, status = 200) { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); }
/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
function sendJson(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); }