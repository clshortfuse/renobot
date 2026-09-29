import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

import { appPage, errorPage, homePage, modderKofiPage, notFoundPage, siteJs } from '../src/web-assets.js';

describe('static portal assets', () => {
  it('keeps the proxy read timeout longer than the SSE heartbeat interval', () => {
    const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');
    const generalProxy = nginx.match(/location \/ \{[\s\S]*?proxy_read_timeout (\d+)s;/u);
    const heartbeat = server.match(/response\.write\(': heartbeat\\n\\n'\);[\s\S]*?\}, ([\d_]+)\);/u);
    assert.ok(generalProxy && heartbeat);
    assert.ok(Number(generalProxy[1]) * 1000 > Number(heartbeat[1]?.replaceAll('_', '')));
  });

  it('contains no template placeholders or server-side user data', () => {
    for (const html of [appPage, modderKofiPage, errorPage, homePage, notFoundPage]) {
      assert.match(html, /<!doctype html>/u);
      assert.doesNotMatch(html, /\{\{|<script(?! src="\/assets\/site\.js")/u);
    }
    assert.doesNotMatch(siteJs, /innerHTML|insertAdjacentHTML|document\.write/u);
  });

  it('sets user data as DOM text and the CSRF token as a form value', async () => {
    /** @type {Record<string, { textContent?: string, hidden?: boolean, value?: string, disabled?: boolean }>} */
    const elements = {
      username: {}, connection: {}, 'owner-badge': { hidden: true }, 'modder-badge': { hidden: true },
      'reviewer-badge': { hidden: true }, 'kofi-link': { hidden: true }, 'portal-navigation': { hidden: true }, csrf: {}, 'sign-out': { disabled: true },
    };
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'app' } }, getElementById: (/** @type {string} */ id) => elements[id] },
      fetch: async (/** @type {string} */ path) => ({ ok: true, json: async () => path === '/auth/session'
        ? { username: '<img onerror=alert(1)>', ready: true, owner: true, csrf: 'csrf-value' }
        : { capabilities: ['authenticated', 'admin', 'modder', 'appeal:review'] } }),
    });
    assert.equal(elements.username?.textContent, '<img onerror=alert(1)>');
    assert.equal(elements.connection?.textContent, 'Ready');
    assert.equal(elements['owner-badge']?.hidden, false);
    assert.equal(elements['modder-badge']?.hidden, true);
    assert.equal(elements['kofi-link']?.hidden, false);
    assert.equal(elements['portal-navigation']?.hidden, false);
    assert.equal(elements.csrf?.value, 'csrf-value');
    assert.equal(elements['sign-out']?.disabled, false);
  });

  it('shows only role-derived status and keeps unfinished destinations unlinked', async () => {
    const elements = Object.fromEntries(['username', 'connection', 'csrf', 'sign-out', 'owner-badge',
      'modder-badge', 'reviewer-badge', 'kofi-link', 'portal-navigation', 'access-status'].map((id) => [id, { hidden: true }]));
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'app' } }, getElementById: (/** @type {string} */ id) => elements[id] },
      fetch: async (/** @type {string} */ path) => ({ ok: true, json: async () => path === '/auth/session'
        ? { username: 'visitor', ready: true, csrf: 'token' }
        : { capabilities: ['authenticated', 'modder'] } }),
    });
    assert.equal(elements['modder-badge']?.hidden, false);
    assert.equal(elements['owner-badge']?.hidden, true);
    assert.equal(elements['reviewer-badge']?.hidden, true);
    assert.equal(elements['portal-navigation']?.hidden, false);
    assert.equal(elements['kofi-link']?.hidden, false);
    assert.doesNotMatch(appPage, /href="\/app\/admin/u);
  });

  it('fails closed when capability discovery fails after sign-in', async () => {
    const elements = Object.fromEntries(['username', 'connection', 'csrf', 'sign-out', 'owner-badge',
      'modder-badge', 'reviewer-badge', 'kofi-link', 'portal-navigation', 'access-status'].map((id) => [id, { hidden: true }]));
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'app' } }, getElementById: (/** @type {string} */ id) => elements[id] },
      fetch: async (/** @type {string} */ path) => path === '/auth/session'
        ? { ok: true, json: async () => ({ username: 'owner', ready: true, owner: true, csrf: 'token' }) }
        : { ok: false, status: 503 },
    });
    assert.equal(elements['owner-badge']?.hidden, true);
    assert.equal(elements['kofi-link']?.hidden, true);
    assert.equal(elements['portal-navigation']?.hidden, true);
    assert.equal(elements['access-status']?.hidden, false);
  });

  it('updates the public portal link and account using DOM properties', async () => {
    const link = { href: '/auth/discord' };
    const account = { textContent: '', hidden: true };
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'home' } },
        getElementById: (/** @type {string} */ id) => id === 'portal-link' ? link : account },
      fetch: async () => ({ ok: true, json: async () => ({ username: '<b>visitor</b>' }) }),
    });
    assert.equal(link.href, '/app');
    assert.equal(account.textContent, 'Signed in as <b>visitor</b>');
    assert.equal(account.hidden, false);
  });

  it('leaves sign out disabled if the session request fails', async () => {
    /** @type {Record<string, { textContent?: string, disabled?: boolean }>} */
    const elements = { username: {}, connection: {}, 'sign-out': { disabled: true } };
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'app' } }, getElementById: (/** @type {string} */ id) => elements[id] },
      fetch: async () => { throw new Error('Unavailable'); },
    });
    assert.equal(elements['sign-out']?.disabled, true);
    assert.equal(elements.username?.textContent, 'Unavailable');
  });

  it('renders own modder settings and the test-only URL as DOM text without stored secrets', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['settings-status', 'kofi-form', 'minimum-amount', 'currency',
      'floor-note', 'token-status', 'forward-status', 'kofi-test', 'kofi-test-url', 'kofi-test-status', 'kofi-test-details']
      .map((id) => [id, { hidden: true, value: '' }]));
    nodes['kofi-form'] = { hidden: true, addEventListener() {} };
    /** @type {((event: { data: string }) => void) | undefined} */
    let onDelivery;
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'modder-kofi' } }, getElementById: (/** @type {string} */ id) => nodes[id] },
      EventSource: class {
        /** @param {string} url */
        constructor(url) { assert.equal(url, '/app/api/modder/kofi/events'); }
        /** @param {string} event @param {typeof onDelivery} callback */
        addEventListener(event, callback) { assert.equal(event, 'test-delivery'); onDelivery = callback; }
      },
      fetch: async (/** @type {string} */ path) => ({ ok: true, json: async () => path === '/auth/session'
        ? { username: '<script>', csrf: 'secret-csrf' }
        : { minimumAmount: '5.00', currency: 'USD', floor: '5.00', hasVerificationToken: true, hasForwardUrl: true,
          testUrl: 'https://renobot.example/test/kofi/private-id', lastTestAt: null } }),
    });
    assert.equal(nodes['kofi-form'].hidden, false);
    assert.equal(nodes['token-status'].textContent, 'Token configured (value hidden)');
    assert.equal(nodes['forward-status'].textContent, 'Destination configured (value hidden)');
    assert.equal(nodes['floor-note'].textContent, 'Minimum allowed: 5.00 USD');
    assert.equal(nodes['kofi-test-url'].textContent, 'https://renobot.example/test/kofi/private-id');
    assert.equal(nodes['kofi-test-status'].textContent, 'No verified test delivery yet.');
    assert.ok(onDelivery);
    onDelivery({ data: JSON.stringify({ receivedAt: '2026-09-28T12:00:00.000Z', eventType: '<script>',
      amount: '5.00', currency: 'USD', subscriptionPayment: true }) });
    assert.match(nodes['kofi-test-details'].textContent, /<script>.*5\.00 USD; subscription payment/u);
    assert.match(modderKofiPage, /Do not replace an existing live Ko-fi webhook/u);
    assert.doesNotMatch(modderKofiPage, /value="(?:v1:|secret)|webhooks\/kofi/u);
  });

  it('submits the authenticated settings form without leaving secrets in browser fields', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['settings-status', 'minimum-amount', 'currency', 'floor-note',
      'token-status', 'forward-status', 'verification-token', 'forward-action', 'forward-url', 'save-settings',
      'kofi-test', 'kofi-test-url', 'kofi-test-status', 'kofi-test-details']
      .map((id) => [id, { value: '', hidden: true, disabled: false }]));
    /** @type {((event: { preventDefault: () => void }) => void) | undefined} */
    let submit;
    nodes['kofi-form'] = { hidden: true, addEventListener: (/** @type {string} */ name, /** @type {typeof submit} */ handler) => {
      if (name === 'submit') submit = handler;
    } };
    /** @type {URLSearchParams | undefined} */
    let posted;
    const settings = { minimumAmount: '5.00', currency: 'USD', floor: '5.00', hasVerificationToken: false, hasForwardUrl: false,
      testUrl: null };
    let streams = 0;
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'modder-kofi' } }, getElementById: (/** @type {string} */ id) => nodes[id] },
      URLSearchParams,
      EventSource: class {
        constructor() { streams++; }
        addEventListener() {}
      },
      fetch: async (/** @type {string} */ path, /** @type {{ method?: string, body?: URLSearchParams }} */ options) => {
        if (path === '/auth/session') return { ok: true, json: async () => ({ csrf: 'csrf-secret' }) };
        if (options.method === 'POST') posted = options.body;
        return { ok: true, json: async () => ({ ...settings, hasVerificationToken: Boolean(posted),
          testUrl: posted ? 'https://renobot.example/test/kofi/private-id' : null }) };
      },
    });
    assert.ok(submit);
    assert.equal(streams, 0);
    nodes['verification-token'].value = 'private-value';
    nodes['forward-action'].value = 'replace';
    nodes['forward-url'].value = 'https://example.com/hook';
    submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted?.get('csrf'), 'csrf-secret');
    assert.equal(posted?.get('verificationToken'), 'private-value');
    assert.equal(posted?.get('forwardUrl'), 'https://example.com/hook');
    assert.equal(nodes['verification-token'].value, '');
    assert.equal(nodes['forward-url'].value, '');
    assert.equal(nodes['forward-action'].value, 'keep');
    assert.equal(nodes['token-status'].textContent, 'Token configured (value hidden)');
    assert.equal(nodes['settings-status'].textContent, 'Settings saved. Webhooks remain inactive.');
    assert.equal(streams, 1);
    assert.equal(nodes['kofi-test'].hidden, false);
    submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(streams, 1);
  });

  it('does not show a settings form to a denied visitor', async () => {
    const status = { textContent: 'Checking access…' };
    const form = { hidden: true };
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'modder-kofi' } },
        getElementById: (/** @type {string} */ id) => id === 'kofi-form' ? form : status },
      fetch: async (/** @type {string} */ path) => path === '/auth/session'
        ? { ok: true, json: async () => ({ csrf: 'secret-csrf' }) }
        : { ok: false, status: 403 },
    });
    assert.equal(form.hidden, true);
    assert.equal(status.textContent, 'Modder access required.');
  });
});
