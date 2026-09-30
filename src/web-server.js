import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { DiscordAPIError } from 'discord.js';

import { adminEarlyAccessPage, adminKofiPage, appPage, errorPage, homePage, materialJs, modderKofiPage, notFoundPage, siteCss, siteJs } from './web-assets.js';
import { requiredCapability, resolveCapabilities } from './web-capabilities.js';
import { MissingVerificationTokenError } from './database.js';
import { maxKofiBodyBytes, receiveKofiReceipt } from './kofi-ingestion.js';
import { parseModderSettings } from './modder-settings.js';
import { parseKofiCsv } from './kofi-csv.js';
import { createOAuthState, createSession, csrfToken, oauthReturnTo, readCookie, readSession, safeAppPath, secureCookie, verifyCsrfToken, verifyOAuthState } from './web-session.js';

const stateCookie = 'renobot_oauth_state';
const sessionCookie = 'renobot_session';

/** @param {import('node:http').IncomingMessage} incoming @param {string | undefined} trustedProxyIp */
function deliverySource(incoming, trustedProxyIp) {
  const peerIp = incoming.socket.remoteAddress ?? null;
  const peerPort = incoming.socket.remotePort ?? null;
  const ip = incoming.headers['x-renobot-client-ip'];
  const port = incoming.headers['x-renobot-client-port'];
  if (trustedProxyIp && peerIp === trustedProxyIp && typeof ip === 'string' && isIP(ip)
    && typeof port === 'string' && /^\d{1,5}$/u.test(port) && Number(port) > 0 && Number(port) <= 65535) {
    return { ip, port: Number(port), viaProxy: true, peerIp, peerPort };
  }
  return { ip: peerIp, port: peerPort, viaProxy: false, peerIp, peerPort };
}

/**
 * @param {Readonly<{
 *   bot: import('discord.js').Client,
 *   config: import('./web-config.js').WebConfig | undefined,
 *   database?: import('./database.js').PortalDatabase,
 *   settingsConfig?: import('./modder-settings.js').ModderSettingsConfig,
 *   supporterRoleId?: string,
 *   earlyAccessRoleId?: string,
 *   trustedKofiProxyIp?: string,
 *   logger: import('pino').Logger,
 *   request?: typeof fetch,
 * }>} options
 */
export function createWebServer(options) {
  const request = options.request ?? fetch;
  let importingEarlyAccess = false;
  /** @type {{ at: string, event: 'accepted' | 'duplicate' | 'rejected' | 'storage-failure' }[]} */
  const recentWebhookEvents = [];
  /** @param {'accepted' | 'duplicate' | 'rejected' | 'storage-failure'} event */
  function noteWebhook(event) {
    recentWebhookEvents.unshift({ at: new Date().toISOString(), event });
    if (recentWebhookEvents.length > 100) recentWebhookEvents.length = 100;
  }
  /** @type {Map<string, Set<{ userId: string, token: string, response: import('node:http').ServerResponse }>>} */
  const subscribersByIntegration = new Map();
  /** @param {string} integrationId */
  function publishReceipt(integrationId) {
    for (const subscriber of subscribersByIntegration.get(integrationId) ?? []) {
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
          if (!subscriber.response.destroyed) subscriber.response.write('event: receipt\ndata: {}\n\n');
        } catch { subscriber.response.end(); }
      })();
    }
  }
  const server = createServer(async (incoming, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') {
        const ready = options.bot.isReady() && (!options.database || await options.database.isReady());
        sendJson(response, ready ? 200 : 503, { ready });
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/health/webhook') {
        const ready = options.settingsConfig && options.database
          ? await options.database.isReady() : options.bot.isReady() && (!options.database || await options.database.isReady());
        sendJson(response, ready ? 200 : 503, { ready });
        return;
      }
      if (!options.config) {
        sendText(response, 404, 'Not found');
        return;
      }
      if ((incoming.method === 'GET' && url.pathname === '/app/api/account')
        || (incoming.method === 'POST' && url.pathname === '/app/api/account/link-payments')) {
        const token = readCookie(incoming.headers.cookie, sessionCookie);
        const session = readSession(token, options.config.sessionSecret);
        if (!session) { sendJson(response, 401, { error: 'Sign-in required' }); return; }
        if (!options.database) { sendJson(response, 503, { error: 'Please try again later' }); return; }
        if (incoming.method === 'POST') {
          if (!incoming.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
            sendJson(response, 415, { error: 'Unsupported content type' }); return;
          }
          const body = await readForm(incoming, 4096);
          if (!verifyCsrfToken(body.get('csrf') ?? '', token ?? '', options.config.sessionSecret)) {
            sendJson(response, 403, { error: 'Invalid CSRF token' }); return;
          }
          sendJson(response, 200, await options.database.linkEmailPayments(session.id));
          return;
        }
        const before = url.searchParams.get('before') ?? undefined;
        if (before && !/^[A-Za-z0-9_-]{1,255}$/u.test(before)) {
          sendJson(response, 400, { error: 'Invalid cursor' }); return;
        }
        const account = await options.database.supporterAccount(session.id, before);
        const roleManaged = options.earlyAccessRoleId
          ? await options.database.hasManagedSupporterRole(session.id, options.earlyAccessRoleId) : false;
        sendJson(response, 200, {
          emails: account.emails.map(({ email, verifiedBy, verifiedAt }) => ({ email, verifiedBy, verifiedAt })),
          earlyAccess: { enabled: Boolean(options.earlyAccessRoleId), totalAmount: account.balance?.totalAmount.toFixed(2) ?? '0.00',
            creditedMonths: account.balance?.creditedMonths ?? 0, expiresAt: account.balance?.expiresAt ?? null,
            roleManaged },
          entries: account.entries.map((entry) => ({ id: entry.id, recipient: entry.integration.account.lastKnownUsername,
            receivedAt: entry.receivedAt, occurredAt: entry.occurredAt, eventType: entry.eventType,
            amount: entry.amount.toFixed(2), currency: entry.currency, transactionId: entry.transactionId,
            outcome: entry.outcome, entitlementExpiresAt: entry.entitlementExpiresAt })),
          nextCursor: account.nextCursor,
        });
        return;
      }
      const receiptEndpoint = /^\/prod\/kofi\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname);
      if (incoming.method === 'POST' && receiptEndpoint) {
        if (!options.database || !options.settingsConfig) {
          sendText(response, 503, 'Unavailable');
          return;
        }
        if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(incoming.headers['content-type'] ?? '')) {
          sendText(response, 415, 'Unsupported content type');
          return;
        }
        const rawBody = await readBody(incoming, maxKofiBodyBytes);
        const source = deliverySource(incoming, options.trustedKofiProxyIp);
        let result;
        try {
          result = await receiveKofiReceipt(options.database, options.settingsConfig.key,
            receiptEndpoint[1] ?? '', rawBody, publishReceipt,
            options.supporterRoleId ? options.settingsConfig.minimumAmount : undefined, source,
            Boolean(options.earlyAccessRoleId));
        } catch (error) {
          noteWebhook('storage-failure');
          options.logger.warn({ source }, 'Ko-fi webhook storage failure');
          throw error;
        }
        noteWebhook(result);
        options.logger.info({ source, result }, 'Ko-fi webhook delivery');
        sendText(response, result === 'rejected' ? 403 : 200,
          result === 'rejected' ? 'Delivery not verified' : 'Receipt recorded');
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
      if (incoming.method === 'GET' && url.pathname === '/assets/material.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(materialJs);
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
      if (incoming.method === 'POST' && url.pathname === '/app/api/admin/early-access/import') {
        const token = readCookie(incoming.headers.cookie, sessionCookie);
        const session = readSession(token, options.config.sessionSecret);
        if (!session) { sendJson(response, 401, { error: 'Sign-in required' }); return; }
        if (session.id !== options.config.ownerUserId) { sendJson(response, 403, { error: 'Access denied' }); return; }
        if (!options.database || !options.settingsConfig || !options.earlyAccessRoleId) {
          sendJson(response, 503, { error: 'Early-access ledger is unavailable' }); return;
        }
        if (!incoming.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
          sendJson(response, 415, { error: 'Unsupported content type' }); return;
        }
        const body = await readForm(incoming, 4096);
        if (!verifyCsrfToken(body.get('csrf') ?? '', token ?? '', options.config.sessionSecret)) {
          sendJson(response, 403, { error: 'Invalid CSRF token' }); return;
        }
        const after = body.get('after') ?? undefined;
        if ([...body.keys()].some((key) => !['csrf', 'after'].includes(key) || body.getAll(key).length !== 1)
          || after !== undefined && !/^[A-Za-z0-9_-]{1,64}$/u.test(after)) {
          sendJson(response, 400, { error: 'Invalid import cursor' }); return;
        }
        if (importingEarlyAccess) { sendJson(response, 409, { error: 'Import already running' }); return; }
        importingEarlyAccess = true;
        try {
          const result = await options.database.backfillEarlyAccess(options.settingsConfig.currency, after);
          if (!result) { sendJson(response, 400, { error: 'Invalid import cursor' }); return; }
          sendJson(response, 200, result);
        } finally { importingEarlyAccess = false; }
        return;
      }
      if (incoming.method === 'POST' && /^\/app\/api\/admin\/early-access\/[^/]+\/(approve|link|credit)$/u.test(url.pathname)) {
        const token = readCookie(incoming.headers.cookie, sessionCookie);
        const session = readSession(token, options.config.sessionSecret);
        if (!session) { sendJson(response, 401, { error: 'Sign-in required' }); return; }
        if (session.id !== options.config.ownerUserId) { sendJson(response, 403, { error: 'Access denied' }); return; }
        if (!options.database || !options.earlyAccessRoleId) {
          sendJson(response, 503, { error: 'Early-access role is unavailable' }); return;
        }
        const action = url.pathname.split('/').at(-1);
        const supporterId = url.pathname.split('/').at(-2) ?? '';
        if (!/^\d{17,20}$/u.test(supporterId)) { sendJson(response, 400, { error: 'Invalid supporter ID' }); return; }
        if (!incoming.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
          sendJson(response, 415, { error: 'Unsupported content type' }); return;
        }
        const body = await readForm(incoming, 4096);
        if (!verifyCsrfToken(body.get('csrf') ?? '', token ?? '', options.config.sessionSecret)) {
          sendJson(response, 403, { error: 'Invalid CSRF token' }); return;
        }
        if (action === 'link') {
          sendJson(response, 200, await options.database.linkEmailPayments(supporterId)); return;
        }
        if (action === 'credit') {
          if (!options.settingsConfig) { sendJson(response, 503, { error: 'Payment settings unavailable' }); return; }
          sendJson(response, 200, await options.database.creditAccountPayments(supporterId, options.settingsConfig.currency)); return;
        }
        if (!await options.database.approveEarlyAccess(supporterId, new Date())) {
          sendJson(response, 409, { error: 'No active early-access period to approve' }); return;
        }
        sendJson(response, 200, { scheduled: true });
        return;
      }
      if (incoming.method === 'GET' && (url.pathname === '/app/api/admin/early-access'
        || url.pathname.startsWith('/app/api/admin/early-access/')
        || url.pathname === '/app/api/admin/kofi/entries'
        || url.pathname === '/app/api/admin/kofi/operations')) {
        const session = readSession(readCookie(incoming.headers.cookie, sessionCookie), options.config.sessionSecret);
        if (!session) { sendJson(response, 401, { error: 'Sign-in required' }); return; }
        if (session.id !== options.config.ownerUserId) { sendJson(response, 403, { error: 'Access denied' }); return; }
        if (url.pathname === '/app/api/admin/kofi/operations') {
          sendJson(response, 200, { events: recentWebhookEvents });
          return;
        }
        if (!options.database || !options.settingsConfig) {
          sendJson(response, 503, { error: 'Ledger is unavailable' });
          return;
        }
        if (url.pathname === '/app/api/admin/early-access'
          || url.pathname.startsWith('/app/api/admin/early-access/')) {
          const before = url.searchParams.get('before') ?? undefined;
          if (url.pathname === '/app/api/admin/early-access') {
            if ((before && !/^\d{17,20}$/u.test(before)) || url.searchParams.has('before') && !before) {
              sendJson(response, 400, { error: 'Invalid cursor' }); return;
            }
            const result = await options.database.listEarlyAccessReview(options.earlyAccessRoleId, before);
            const guildId = options.config.guildId;
            /** @type {(string | null)[]} */
            const names = [];
            /** @type {('present' | 'missing' | 'not-in-server' | 'unavailable' | 'disabled')[]} */
            const roles = [];
            for (let index = 0; index < result.members.length; index += 5) {
              names.push(...await Promise.all(result.members.slice(index, index + 5).map(async (member) => {
                try {
                  const user = await options.bot.users.fetch(member.discordUserId);
                  return user.globalName ?? user.username;
                } catch { return null; }
              })));
              roles.push(...await Promise.all(result.members.slice(index, index + 5).map(async (member) => {
                if (!options.earlyAccessRoleId) return /** @type {const} */ ('disabled');
                try {
                  const guild = await options.bot.guilds.fetch(guildId);
                  const live = await guild.members.fetch({ user: member.discordUserId, force: true, cache: false });
                  return live.roles.cache.has(options.earlyAccessRoleId)
                    ? /** @type {const} */ ('present') : /** @type {const} */ ('missing');
                } catch (error) {
                  return error instanceof DiscordAPIError && error.code === 10007
                    ? /** @type {const} */ ('not-in-server') : /** @type {const} */ ('unavailable');
                }
              })));
            }
            const now = Date.now();
            sendJson(response, 200, { enabled: Boolean(options.earlyAccessRoleId),
              members: result.members.map((member, index) => ({ discordUserId: member.discordUserId,
                discordName: names[index] ?? null,
                roleStatus: roles[index],
                unlinkedPayments: member.unlinkedPayments ?? 0, uncreditedPayments: member.uncreditedPayments ?? 0,
                totalAmount: member.totalAmount.toFixed(2), currency: options.settingsConfig?.currency,
                creditedMonths: member.creditedMonths, expiresAt: member.expiresAt?.toISOString() ?? null,
                active: Boolean(member.expiresAt && member.expiresAt.getTime() > now),
                roleManaged: member.roleManaged, syncStatus: member.sync?.lastErrorCode ? 'retrying'
                  : member.sync ? 'scheduled' : 'idle', nextAttemptAt: member.sync?.nextAttemptAt.toISOString() ?? null })),
              nextCursor: result.nextCursor });
          } else {
            const supporterId = url.pathname.slice('/app/api/admin/early-access/'.length);
            if (!/^\d{17,20}$/u.test(supporterId)
              || (before && !/^[A-Za-z0-9_-]{1,64}$/u.test(before)) || url.searchParams.has('before') && !before) {
              sendJson(response, 400, { error: 'Invalid supporter ID or cursor' }); return;
            }
            const result = await options.database.getEarlyAccessReview(supporterId, before);
            if (!result) { sendJson(response, 404, { error: 'No early-access record' }); return; }
            sendJson(response, 200, { periods: result.periods.map((period) => ({
              startedAt: period.startedAt.toISOString(), expiresAt: period.expiresAt.toISOString(), months: period.months,
            })), contributions: result.contributions.map((entry) => ({
              eventId: entry.eventId, amount: entry.amount.toFixed(2), currency: entry.currency,
              eventType: entry.eventType, receivedAt: entry.receivedAt.toISOString(),
              modderDiscordUserId: entry.modderDiscordUserId, modderUsername: entry.modderUsername,
            })), nextCursor: result.nextCursor });
          }
          return;
        }
        const before = url.searchParams.get('before') ?? undefined;
        if ((before && !/^[A-Za-z0-9_-]{1,64}$/u.test(before)) || url.searchParams.has('before') && !before) {
          sendJson(response, 400, { error: 'Invalid entry cursor' });
          return;
        }
        const { entries, nextCursor } = await options.database.listAdminKofiEntries(before);
        sendJson(response, 200, { entries: entries.map((entry) => ({
          id: entry.id, ownerDiscordUserId: entry.integration.account.discordUserId,
          ownerUsername: entry.integration.account.lastKnownUsername,
          transactionId: entry.transactionId, eventType: entry.eventType,
          amount: entry.amount.toFixed(2), currency: entry.currency,
          receivedAt: entry.receivedAt.toISOString(), outcome: entry.outcome,
          sourceIp: entry.sourceIp, sourcePort: entry.sourcePort,
          sourceViaProxy: entry.sourceViaProxy, peerIp: entry.peerIp, peerPort: entry.peerPort,
        })), nextCursor });
        return;
      }
      if ((url.pathname === '/app/api/modder/kofi' && (incoming.method === 'GET' || incoming.method === 'POST'))
        || (url.pathname === '/app/api/modder/kofi/import' && incoming.method === 'POST')
        || (['/app/api/modder/kofi/events', '/app/api/modder/kofi/entries',
          '/app/api/modder/kofi/memberships'].includes(url.pathname) && incoming.method === 'GET')
        || (incoming.method === 'GET' && url.pathname.startsWith('/app/api/modder/kofi/memberships/'))) {
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
        if (url.pathname === '/app/api/modder/kofi/import') {
          if (!incoming.headers['content-type']?.startsWith('text/csv')) {
            sendJson(response, 415, { error: 'Upload a CSV file' }); return;
          }
          const csrf = incoming.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !verifyCsrfToken(csrf, token ?? '', options.config.sessionSecret)) {
            sendJson(response, 403, { error: 'Invalid CSRF token' }); return;
          }
          if (!await options.database.getIntegration(session.id)) {
            sendJson(response, 409, { error: 'Configure your Ko-fi connection first' }); return;
          }
          const text = (await readBody(incoming, 2 * 1024 * 1024)).toString();
          try {
            sendJson(response, 200, await options.database.importKofiCsv(session.id, parseKofiCsv(text)));
          } catch {
            sendJson(response, 400, { error: 'CSV could not be imported. Check the export and existing payment details. No changes saved.' });
          }
          return;
        }
        if (url.pathname.startsWith('/app/api/modder/kofi/memberships/')) {
          const supporterId = url.pathname.slice('/app/api/modder/kofi/memberships/'.length);
          if (!/^\d{17,20}$/u.test(supporterId)) { sendJson(response, 400, { error: 'Invalid supporter ID' }); return; }
          if (!await options.database.hasKofiMembership(session.id, supporterId)) {
            sendJson(response, 404, { error: 'Membership not found' }); return;
          }
          if (!options.supporterRoleId) { sendJson(response, 200, { rolePresent: null }); return; }
          try {
            const guild = await options.bot.guilds.fetch(options.config.guildId);
            const member = await guild.members.fetch({ user: supporterId, force: true, cache: false });
            sendJson(response, 200, { rolePresent: member.roles.cache.has(options.supporterRoleId) });
          } catch (error) {
            if (error instanceof DiscordAPIError && error.code === 10007) {
              sendJson(response, 200, { rolePresent: false });
            } else {
              options.logger.warn('Supporter role lookup failed');
              sendJson(response, 503, { error: 'Discord role status is temporarily unavailable' });
            }
          }
          return;
        }
        if (url.pathname === '/app/api/modder/kofi/memberships') {
          const before = url.searchParams.get('before') ?? undefined;
          if ((before && !/^[A-Za-z0-9_-]{1,64}$/u.test(before)) || url.searchParams.has('before') && !before) {
            sendJson(response, 400, { error: 'Invalid membership cursor' });
            return;
          }
          const { members, nextCursor } = await options.database.listKofiMemberships(session.id, options.supporterRoleId, before);
          /** @type {(string | null)[]} */
          const names = [];
          for (let index = 0; index < members.length; index += 5) {
            const batch = await Promise.all(members.slice(index, index + 5).map(async (member) => {
              try {
                const user = await options.bot.users.fetch(member.discordUserId);
                return user.globalName ?? user.username;
              } catch {
                return null;
              }
            }));
            names.push(...batch);
          }
          const now = Date.now();
          sendJson(response, 200, { members: members.map((member, index) => ({
            discordUserId: member.discordUserId, discordName: names[index] ?? null,
            expiresAt: member.expiresAt.toISOString(),
            lastPaymentAt: member.lastPaymentAt.toISOString(), active: member.expiresAt.getTime() > now,
            roleStatus: !options.supporterRoleId ? 'disabled' : member.sync?.lastErrorCode ? 'retrying'
              : member.roleManaged ? 'granted-by-renobot' : member.sync ? 'pending' : 'not-managed',
            nextAttemptAt: member.sync?.nextAttemptAt.toISOString() ?? null,
          })), nextCursor });
          return;
        }
        if (url.pathname === '/app/api/modder/kofi/entries') {
          const before = url.searchParams.get('before') ?? undefined;
          if ((before && !/^[A-Za-z0-9_-]{1,64}$/u.test(before)) || url.searchParams.has('before') && !before) {
            sendJson(response, 400, { error: 'Invalid entry cursor' });
            return;
          }
          const { entries, nextCursor, missingEmailCount = 0 } = await options.database.listKofiEntries(session.id, before);
          sendJson(response, 200, { entries: entries.map((entry) => ({ id: entry.id,
            messageId: entry.messageId, transactionId: entry.transactionId,
            eventType: entry.eventType, amount: entry.amount.toFixed(2), currency: entry.currency,
            subscriptionPayment: entry.subscriptionPayment, firstSubscriptionPayment: entry.firstSubscriptionPayment,
            supporterDiscordUserId: entry.supporterDiscordUserId, tierName: entry.tierName,
            occurredAt: entry.occurredAt.toISOString(), receivedAt: entry.receivedAt.toISOString(),
            outcome: entry.outcome })), nextCursor, missingEmailCount });
          return;
        }
        if (url.pathname === '/app/api/modder/kofi/events') {
          const integration = await options.database.getIntegration(session.id);
          if (!integration) {
            sendJson(response, 404, { error: 'No integration configured' });
            return;
          }
          let subscribers = subscribersByIntegration.get(integration.id);
          if (!subscribers) {
            subscribers = new Set();
            subscribersByIntegration.set(integration.id, subscribers);
          }
          if (subscribers.size >= 5) {
            sendJson(response, 429, { error: 'Too many receipt streams' });
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
            if (subscribers.size === 0) subscribersByIntegration.delete(integration.id);
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
          sendJson(response, 200, { configured: Boolean(integration), currency: options.settingsConfig.currency,
          hasVerificationToken: Boolean(integration?.verificationTokenCiphertext),
          hasForwardUrl: Boolean(integration?.forwardUrlCiphertext), active: Boolean(options.supporterRoleId),
          prodUrl: integration ? new URL(`/prod/kofi/${integration.endpointId}`, options.config.publicBaseUrl).href : null,
          lastWebhookAt: integration?.lastWebhookAt?.toISOString() ?? null });
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
        if (url.pathname === '/app/admin/kofi') {
          sendHtml(response, adminKofiPage);
          return;
        }
        if (url.pathname === '/app/admin/early-access') {
          sendHtml(response, adminEarlyAccessPage);
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
          scope: url.searchParams.get('email') === '1' ? 'identify email' : 'identify',
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
        await options.database?.saveLogin({ id: user.id, username: user.username });
        if (user.verifiedEmail) await options.database?.verifyDiscordEmail(user.id, user.verifiedEmail);
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
  return { id: user.id, username: user.username,
    verifiedEmail: user.verified === true && typeof user.email === 'string' ? user.email : null };
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