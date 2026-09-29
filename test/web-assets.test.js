import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

import { adminEarlyAccessPage, adminKofiPage, appPage, errorPage, homePage, materialJs, modderKofiPage, notFoundPage, siteCss, siteJs } from '../src/web-assets.js';

describe('static portal assets', () => {
  it('ignores an older payment page after matching refreshes the account', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['account-status', 'account-check-payments', 'account-payments-more',
      'account-emails', 'account-early-access', 'account-payments', 'account-payments-status'].map((id) => [id,
      { hidden: true, disabled: true, state: {}, listeners: /** @type {Record<string, Function>} */ ({}),
        addEventListener(/** @type {string} */ type, /** @type {Function} */ callback) { this.listeners[type] = callback; },
        patch(/** @type {object} */ state) { Object.assign(this.state, state); } }]));
    /** @type {((value: any) => void) | undefined} */
    let finishOlder;
    const older = new Promise((resolve) => { finishOlder = resolve; });
    /** @param {string} transaction @param {string | null} cursor */
    const account = (transaction, cursor) => ({ ok: true, json: async () => ({
      emails: [{ email: 'verified@example.test', verifiedBy: 'discord' }],
      earlyAccess: { enabled: false, expiresAt: null, creditedMonths: 0, roleManaged: false },
      entries: [{ recipient: 'Modder', amount: '5.00', currency: 'USD', receivedAt: '2026-09-29T00:00:00Z',
        eventType: 'Donation', transactionId: transaction, outcome: 'recorded' }], nextCursor: cursor,
    }) });
    let firstPage = 0;
    /** @type {string[]} */
    const calls = [];
    await runInNewContext(siteJs.replace('void loadSession();', "loadSupporterAccount('csrf-value');"), {
      document: { getElementById: (/** @type {string} */ id) => nodes[id] }, URLSearchParams,
      fetch: async (/** @type {string} */ path) => {
        calls.push(path);
        if (path.includes('?before=initial')) return older;
        if (path.endsWith('/link-payments')) return { ok: true, json: async () => ({ linked: 1, more: false }) };
        return account(++firstPage === 1 ? 'initial' : 'refreshed', firstPage === 1 ? 'initial' : 'fresh');
      },
    });
    nodes['account-payments-more'].disabled = false;
    nodes['account-payments-more'].listeners.click();
    nodes['account-check-payments'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes['account-payments'].state.items[0].transaction, 'refreshed');
    finishOlder?.(account('stale', 'stale-cursor'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Array.from(nodes['account-payments'].state.items, (/** @type {any} */ item) => item.transaction), ['refreshed']);
    nodes['account-payments-more'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.at(-1), '/app/api/account?before=fresh');
  });
  for (const roleManaged of [false, true]) {
  it(`shows personal payments with recorded grant status ${roleManaged}`, async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['account-status', 'account-check-payments', 'account-payments-more',
      'account-emails', 'account-early-access', 'account-payments', 'account-payments-status'].map((id) => [id,
      { hidden: true, disabled: true, state: {}, addEventListener() {}, patch(/** @type {object} */ state) { Object.assign(this.state, state); } }]));
    /** @type {string[]} */
    const calls = [];
    await runInNewContext(siteJs.replace('void loadSession();', "loadSupporterAccount('csrf-value');"), {
      document: { getElementById: (/** @type {string} */ id) => nodes[id] },
      fetch: async (/** @type {string} */ path) => {
        calls.push(path);
        return { ok: true, json: async () => ({ emails: [
          { email: 'first@example.test', verifiedBy: 'discord' }, { email: 'second@example.test', verifiedBy: 'discord' },
        ], earlyAccess: { enabled: true, expiresAt: '2099-01-01T00:00:00Z', creditedMonths: 2, roleManaged },
        entries: [{ recipient: '<script>', amount: '5.00', currency: 'USD', receivedAt: '2026-09-29T00:00:00Z',
          eventType: 'Donation', transactionId: 'tx', outcome: 'recorded' }], nextCursor: null }) };
      },
    });
    assert.deepEqual(calls, ['/app/api/account']);
    assert.equal(nodes['account-emails'].state.emails.length, 2);
    assert.equal(nodes['account-emails'].state.emails[1].email, 'second@example.test');
    assert.equal(nodes['account-check-payments'].disabled, false);
    assert.equal(nodes['account-payments'].state.items[0].recipient, '<script>');
    assert.equal(nodes['account-payments-more'].hidden, true);
    assert.match(nodes['account-early-access'].textContent, roleManaged ? /Grant recorded/u : /No grant recorded/u);
    assert.match(nodes['account-early-access'].textContent, /Discord role presence is not checked live/u);
    assert.doesNotMatch(nodes['account-early-access'].textContent, /Discord access granted|Awaiting access approval/u);
  });
  }
  it('keeps the same capability-gated navigation order on every portal page', () => {
    for (const html of [appPage, modderKofiPage, adminKofiPage, adminEarlyAccessPage]) {
      assert.match(html, /<nav id="portal-navigation"[^>]*hidden>/u);
      const items = [...html.matchAll(/<mdw-nav-drawer-item([^>]*)>([^<]*)<\/mdw-nav-drawer-item>/gu)];
      assert.deepEqual(items.map((item) => item[2]), ['Overview', 'Memberships', 'Ko-fi activity', 'Early-access review', 'Renobot home']);
      for (const id of ['kofi-link', 'admin-kofi-link', 'admin-early-access-link']) {
        assert.ok(items.some((item) => item[1]?.includes(`id="${id}"`) && item[1].includes('hidden')));
      }
      assert.equal(items.filter((item) => /\bactive\b/u.test(item[1] ?? '')).length, 1);
    }
  });

  it('keeps the proxy read timeout longer than the SSE heartbeat interval', () => {
    const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');
    const generalProxy = nginx.match(/location \/ \{[\s\S]*?proxy_read_timeout (\d+)s;/u);
    const heartbeat = server.match(/response\.write\(': heartbeat\\n\\n'\);[\s\S]*?\}, ([\d_]+)\);/u);
    assert.ok(generalProxy && heartbeat);
    assert.ok(Number(generalProxy[1]) * 1000 > Number(heartbeat[1]?.replaceAll('_', '')));
  });

  it('contains no template placeholders or server-side user data', () => {
    for (const html of [adminEarlyAccessPage, adminKofiPage, appPage, modderKofiPage, errorPage, homePage, notFoundPage]) {
      assert.match(html, /<!doctype html>/u);
      assert.doesNotMatch(html, /\{\{|<script(?! src="\/assets\/(?:site\.js"|material\.js\?color=00a9c5&amp;lightness=dark&amp;resetCSS=false"))/u);
    }
    assert.doesNotMatch(siteJs, /innerHTML|insertAdjacentHTML|document\.write/u);
  });

  it('serves Material locally and lays out membership records without scrolling tables', () => {
    assert.ok(materialJs.length > 1000);
    for (const html of [adminEarlyAccessPage, modderKofiPage]) {
      assert.match(html, /src="\/assets\/material\.js\?color=00a9c5&amp;lightness=dark&amp;resetCSS=false"/u);
      assert.match(html, /role="list"/u);
      assert.doesNotMatch(html, /<table|membership-table-scroll/u);
    }
    assert.match(siteCss, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,26rem\),1fr\)\)/u);
    assert.doesNotMatch(siteCss, /membership-state|\.record[^\n]*::before|mdw-card\{/u);
    assert.doesNotMatch(siteJs, /createElement\('span'\)|membership-state/u);
    assert.match(siteJs, /\.observe\(/u);
    assert.match(siteJs, /\.childEvents\(/u);
    assert.doesNotMatch(siteJs, /recordFields|createElement\('mdw-/u);
    assert.match(modderKofiPage, /<mdw-box id="kofi-memberships-list" role="list"/u);
    assert.match(siteJs, /col-span-12="3"/u);
  });

  it('uses the documented MDW application shell and form-associated controls', () => {
    for (const html of [appPage, adminEarlyAccessPage, adminKofiPage, modderKofiPage]) {
      assert.match(html, /<mdw-root>/u);
      assert.match(html, /<mdw-nav-drawer[^>]*slot="start"[^>]*auto-open="1100"[^>]*fixed-breakpoint="1100"/u);
      assert.match(html, /<mdw-page><mdw-pane block>/u);
      assert.match(html, /<mdw-top-app-bar /u);
      assert.match(html, /<main id="content" class="portal-content">/u);
      assert.match(html, /<mdw-icon-button id="portal-menu"/u);
    }
    assert.doesNotMatch(modderKofiPage, /id="minimum-amount"/u);
    assert.match(modderKofiPage, /<mdw-input[^>]*id="verification-token"[^>]*autocomplete="off"[^>]*spellcheck="false"/u);
    assert.doesNotMatch(modderKofiPage, /autocomplete="new-password"/u);
    assert.match(modderKofiPage, /<mdw-select[^>]*id="forward-action"/u);
    assert.match(appPage, /<mdw-button outlined type="submit" id="sign-out" disabled>/u);
  });

  it('sets user data as DOM text and the CSRF token as a form value', async () => {
    /** @type {Record<string, { textContent?: string, hidden?: boolean, value?: string, disabled?: boolean }>} */
    const elements = {
      username: {}, connection: {}, 'owner-badge': { hidden: true }, 'modder-badge': { hidden: true },
      'reviewer-badge': { hidden: true }, 'kofi-link': { hidden: true }, 'admin-kofi-link': { hidden: true },
      'admin-early-access-link': { hidden: true }, 'portal-navigation': { hidden: true }, csrf: {}, 'sign-out': { disabled: true },
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
    assert.equal(elements['admin-kofi-link']?.hidden, false);
    assert.equal(elements['admin-early-access-link']?.hidden, false);
    assert.equal(elements['portal-navigation']?.hidden, false);
    assert.equal(elements.csrf?.value, 'csrf-value');
    assert.equal(elements['sign-out']?.disabled, false);
  });

  it('shows only role-derived status and keeps unfinished destinations unlinked', async () => {
    const elements = Object.fromEntries(['username', 'connection', 'csrf', 'sign-out', 'owner-badge',
      'modder-badge', 'reviewer-badge', 'kofi-link', 'admin-kofi-link', 'admin-early-access-link', 'portal-navigation', 'access-status'].map((id) => [id, { hidden: true }]));
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
    assert.equal(elements['admin-kofi-link']?.hidden, true);
    assert.equal(elements['admin-early-access-link']?.hidden, true);
    assert.doesNotMatch(appPage, /href="\/app\/admin(?:"|\/appeals)/u);
  });

  it('fails closed when capability discovery fails after sign-in', async () => {
    const elements = Object.fromEntries(['username', 'connection', 'csrf', 'sign-out', 'owner-badge',
      'modder-badge', 'reviewer-badge', 'kofi-link', 'admin-kofi-link', 'portal-navigation', 'access-status'].map((id) => [id, { hidden: true }]));
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

  it('renders owner receipts and in-memory event labels as DOM text only', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['admin-kofi-status', 'admin-kofi-content', 'admin-entries-more',
      'admin-entries-status', 'admin-entries-list', 'admin-operations-list', 'admin-operations-status',
      'admin-operations-refresh'].map((id) => [id, { hidden: true, addEventListener() {}, replaceChildren() {} }]));
    /** @type {any[]} */
    let entries = [];
    /** @type {{textContent: string}[]} */
    let operations = [];
    nodes['admin-entries-list'].patch = (/** @type {{items: object[]}} */ state) => { entries = state.items; };
    nodes['admin-operations-list'].replaceChildren = (/** @type {{textContent: string}[]} */ ...items) => { operations = items; };
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'admin-kofi' } },
        getElementById: (/** @type {string} */ id) => nodes[id], createElement: () => ({ textContent: '', state: {}, setAttribute() {}, patch(/** @type {object} */ state) { Object.assign(this.state, state); } }) },
      fetch: async (/** @type {string} */ path) => ({ ok: true, json: async () => path === '/auth/session' ? { username: 'owner' }
        : path.endsWith('/operations') ? { events: [{ at: '2026-09-29T01:00:00Z', event: 'accepted' }] }
          : { entries: [{ id: 'receipt', ownerDiscordUserId: '12345678901234567', ownerUsername: '<script>',
            receivedAt: '2026-09-29T01:00:00Z', eventType: 'Subscription', amount: '5.00',
            currency: 'USD', transactionId: 'tx', outcome: 'recorded-no-entitlement' }], nextCursor: null } }),
    });
    assert.equal(nodes['admin-kofi-content'].hidden, false);
    assert.equal(entries[0]?.recipient, '<script>');
    assert.equal(entries[0]?.amount, '5.00 USD');
    assert.equal(entries[0]?.source, '');
    assert.equal(entries[0]?.peer, '');
    assert.match(operations[0]?.textContent ?? '', /accepted/u);
    assert.match(nodes['admin-operations-status'].textContent, /current process only/u);
    assert.doesNotMatch(adminKofiPage, /private@example|fixture-token|<script(?! src="\/assets\/(?:site\.js"|material\.js\?color=00a9c5&amp;lightness=dark&amp;resetCSS=false"))/u);
  });

  it('renders early-access owner review and credited donations only as DOM text', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['early-access-status', 'early-access-approval-status',
      'early-access-import', 'early-access-import-status', 'early-access-content', 'early-access-list',
      'early-access-more', 'early-access-refresh', 'early-access-contributions-more',
      'early-access-detail-status', 'early-access-detail', 'early-access-periods', 'early-access-contributions']
      .map((id) => [id, { hidden: true, addEventListener() {}, replaceChildren() {}, append() {} }]));
    /** @type {any[]} */
    let rows = [];
    /** @type {any[]} */
    let contributions = [];
    nodes['early-access-list'].replaceChildren = (/** @type {any[]} */ ...items) => { rows = items; };
    nodes['early-access-contributions'].replaceChildren = (/** @type {any[]} */ ...items) => { contributions = items; };
    /** @type {(() => void) | undefined} */
    let review;
    /** @type {(() => void) | undefined} */
    let importReceipts;
    /** @type {string[]} */
    const importBodies = [];
    nodes['early-access-import'].addEventListener = (/** @type {string} */ name, /** @type {() => void} */ callback) => {
      if (name === 'click') importReceipts = callback;
    };
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      URLSearchParams,
      document: { body: { dataset: { page: 'admin-early-access' } },
        getElementById: (/** @type {string} */ id) => nodes[id],
        createElement: (/** @type {string} */ tag) => tag === 'renobot-early-access'
          ? { state: {}, patch(/** @type {object} */ state) { Object.assign(this.state, state); }, setAttribute() {}, addEventListener(/** @type {string} */ name, /** @type {() => void} */ callback) {
            if (name === 'review-payments') review = callback;
          } }
          : { tagName: tag, textContent: '', setAttribute() {}, children: /** @type {any[]} */ ([]), append(/** @type {any[]} */ ...items) {
            this.children.push(...items);
          } } },
      fetch: async (/** @type {string} */ path, /** @type {{ body?: URLSearchParams }} */ options) => {
        if (path.endsWith('/import')) importBodies.push(options.body?.toString() ?? '');
        return { ok: true, json: async () => path === '/auth/session'
        ? { username: 'owner', csrf: 'owner-csrf' }
        : path.endsWith('/import') ? { scanned: importBodies.length === 1 ? 50 : 1,
          nextCursor: importBodies.length === 1 ? 'receiptCursor' : null }
        : path === '/app/api/admin/early-access' ? { enabled: true, members: [{ discordUserId: '12345678901234567',
          discordName: '<img onerror=alert(1)>', totalAmount: '13.00', currency: 'USD', creditedMonths: 2,
          expiresAt: '2099-10-29T00:00:00Z', active: true, roleManaged: true, syncStatus: 'scheduled',
          nextAttemptAt: null }], nextCursor: null }
          : { periods: [{ startedAt: '2026-09-29T00:00:00Z', expiresAt: '2026-11-29T00:00:00Z', months: 2 }],
            contributions: [{ eventId: 'receipt', amount: '13.00', currency: 'USD', eventType: 'Donation',
              receivedAt: '2026-09-29T00:00:00Z', modderUsername: '<script>',
                    modderDiscordUserId: '23456789012345678' }], nextCursor: null } };
                  },
    });
    assert.equal(rows[0]?.state.person, '<img onerror=alert(1)>');
    assert.equal(rows[0]?.state.donated, '13.00 USD');
    assert.ok(review);
    review();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(contributions[0]?.textContent ?? '', /<script> \(23456789012345678\)/u);
    assert.equal(nodes['early-access-content'].hidden, false);
    assert.equal(nodes['early-access-detail'].hidden, false);
    assert.deepEqual(importBodies, []);
    assert.ok(importReceipts);
    importReceipts();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(importBodies, ['csrf=owner-csrf', 'csrf=owner-csrf&after=receiptCursor']);
    assert.match(nodes['early-access-import-status'].textContent, /scanned 51 receipts/u);
  });

  it('renders own webhook and paged payment receipts as DOM text without stored secrets', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['settings-status', 'kofi-form', 'minimum-amount', 'currency',
      'floor-note', 'token-status', 'forward-status', 'kofi-prod', 'kofi-prod-url', 'kofi-role-status', 'kofi-webhook-status',
      'kofi-entries', 'kofi-entries-status', 'kofi-entries-list', 'kofi-entries-more',
      'kofi-memberships', 'kofi-memberships-status', 'kofi-memberships-list', 'kofi-memberships-more', 'kofi-memberships-refresh']
      .map((id) => [id, { hidden: true, value: '' }]));
    nodes['kofi-form'] = { hidden: true, addEventListener() {} };
    nodes['kofi-entries-more'].addEventListener = () => {};
    /** @type {{ textContent: string }[]} */
    let rendered = [];
    /** @param {{ textContent: string }[]} items */
    function replaceChildren(...items) { rendered = items; }
    nodes['kofi-entries-list'].replaceChildren = replaceChildren;
    /** @param {{ textContent: string }[]} items */
    function append(...items) { rendered.push(...items); }
    nodes['kofi-entries-list'].append = append;
    /** @type {any[]} */
    let memberships = [];
    nodes['kofi-memberships-list'].replaceChildren = (/** @type {any[]} */ ...items) => { memberships = items; };
    nodes['kofi-memberships-list'].append = (/** @type {any[]} */ ...items) => { memberships.push(...items); };
    nodes['kofi-memberships-more'].addEventListener = () => {};
    nodes['kofi-memberships-refresh'].addEventListener = () => {};
    /** @type {(() => void) | undefined} */
    let loadOlder;
    nodes['kofi-entries-more'].addEventListener = (/** @type {string} */ event, /** @type {() => void} */ callback) => {
      assert.equal(event, 'click');
      loadOlder = callback;
    };
    /** @type {(() => void) | undefined} */
    let onReceipt;
    /** @type {{ state: Record<string, unknown>, tagName: string, setAttribute: () => void, patch: (state: object) => void, addEventListener: (event: string, callback: () => void) => void, click?: () => void } | undefined} */
    let liveRoleButton;
    await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
      document: { body: { dataset: { page: 'modder-kofi' } }, getElementById: (/** @type {string} */ id) => nodes[id],
        createElement: (/** @type {string} */ tag) => tag === 'renobot-membership'
          ? (liveRoleButton = { state: {}, tagName: tag, setAttribute() {}, patch(/** @type {object} */ state) { Object.assign(this.state, state); }, addEventListener(/** @type {string} */ event, /** @type {() => void} */ callback) {
            if (event === 'check-role') this.click = callback;
          } }) : ({ tagName: tag, textContent: '', setAttribute() {}, children: /** @type {any[]} */ ([]), append(/** @type {any[]} */ ...children) { this.children.push(...children); } }) },
      EventSource: class {
        /** @param {string} url */
        constructor(url) { assert.equal(url, '/app/api/modder/kofi/events'); }
        /** @param {string} event @param {() => void} callback */
        addEventListener(event, callback) { assert.equal(event, 'receipt'); onReceipt = callback; }
      },
      fetch: async (/** @type {string} */ path) => ({ ok: true, json: async () => path === '/auth/session'
        ? { username: '<script>', csrf: 'secret-csrf' }
        : path === '/app/api/modder/kofi/memberships/%3Cscript%3E' ? { rolePresent: true }
        : path.startsWith('/app/api/modder/kofi/memberships') ? { members: [{ discordUserId: '<script>',
          discordName: '<img onerror=alert(1)>',
          active: true, expiresAt: '2026-10-29T00:00:00Z', lastPaymentAt: '2026-09-29T00:00:00Z',
          roleStatus: 'granted-by-renobot', nextAttemptAt: null }], nextCursor: null }
        : path.startsWith('/app/api/modder/kofi/entries') ? path.includes('?before=older-id')
          ? { entries: [{ occurredAt: '2026-09-27T12:00:00Z', receivedAt: '2026-09-27T12:00:01Z',
            eventType: 'Donation', transactionId: 'older-tx',
            amount: '1.00', currency: 'USD', supporterDiscordUserId: null, tierName: null,
            subscriptionPayment: false, outcome: 'recorded-no-entitlement' }], nextCursor: null }
          : { entries: [{ occurredAt: '2026-09-28T12:00:00Z', receivedAt: '2026-09-28T12:00:01Z', eventType: '<script>',
            transactionId: 'tx-1', amount: '5.00', currency: 'USD', supporterDiscordUserId: null,
            tierName: null, subscriptionPayment: true, outcome: 'recorded-no-entitlement' }], nextCursor: 'older-id' }
          : { minimumAmount: '5.00', currency: 'USD', floor: '5.00',
          hasVerificationToken: true, hasForwardUrl: true,
          prodUrl: 'https://renobot.example/prod/kofi/private-id', lastWebhookAt: null } }),
    });
    assert.equal(nodes['kofi-form'].hidden, false);
    assert.equal(nodes['kofi-memberships'].hidden, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(memberships[0]?.tagName, 'renobot-membership');
    assert.equal(memberships[0]?.state.person, '<img onerror=alert(1)>');
    assert.equal(memberships[0]?.state.userId, '<script>');
    assert.equal(memberships[0]?.state.membership, 'Active');
    assert.equal(memberships[0]?.state.sync, 'Role grant recorded by Renobot');
    assert.ok(liveRoleButton?.click);
    liveRoleButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(liveRoleButton.state.roleLabel, 'Discord role present');
    assert.equal(nodes['token-status'].textContent, 'Token saved');
    assert.equal(nodes['forward-status'].textContent, 'Destination saved');
    assert.doesNotMatch(modderKofiPage, /id="floor-note"/u);
    assert.equal(nodes['kofi-prod-url'].textContent, 'https://renobot.example/prod/kofi/private-id');
    assert.match(nodes['kofi-role-status'].textContent, /Automatic roles are off/u);
    assert.ok(onReceipt);
    onReceipt();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(nodes['kofi-webhook-status'].textContent, /New payment received/u);
    assert.match(rendered[0]?.textContent ?? '', /<script>.*5\.00 USD.*No linked Discord account/u);
    assert.match(rendered[0]?.textContent ?? '', /Transaction tx-1.*Recurring/u);
    assert.equal(nodes['kofi-entries-status'].textContent, 'Entries shown: 1');
    assert.ok(loadOlder);
    loadOlder();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rendered.length, 2);
    assert.match(rendered[1]?.textContent ?? '', /Donation.*1\.00 USD/u);
    assert.equal(nodes['kofi-entries-status'].textContent, 'Entries shown: 2');
    assert.equal(nodes['kofi-entries-more'].hidden, true);
    assert.match(modderKofiPage, /Keep your existing webhook/u);
    assert.match(modderKofiPage, /<mdw-card outlined><mdw-details id="kofi-setup">/u);
    assert.doesNotMatch(modderKofiPage, /<details|<summary/u);
    assert.doesNotMatch(modderKofiPage, /value="(?:v1:|secret)|webhooks\/kofi/u);
  });

  it('explains why a webhook URL is missing before the verification token is saved', async () => {
      /** @type {Record<string, any>} */
      const nodes = Object.fromEntries(['settings-status', 'minimum-amount', 'currency', 'floor-note',
        'token-status', 'forward-status', 'kofi-prod', 'kofi-prod-url', 'kofi-role-status', 'kofi-webhook-status',
        'kofi-entries', 'kofi-memberships', 'kofi-memberships-status', 'kofi-memberships-list',
        'kofi-memberships-more', 'kofi-memberships-refresh', 'kofi-entries-more'].map((id) => [id, { hidden: true,
          addEventListener() {}, replaceChildren() {} }]));
      nodes['kofi-form'] = { hidden: true, addEventListener() {} };
      await runInNewContext(siteJs.replace('void loadSession();', 'loadSession();'), {
        document: { body: { dataset: { page: 'modder-kofi' } }, getElementById: (/** @type {string} */ id) => nodes[id] },
        fetch: async (/** @type {string} */ path) => ({ ok: true, json: async () => path === '/auth/session'
          ? { username: 'owner', csrf: 'csrf' }
          : path.endsWith('/memberships') ? { members: [], nextCursor: null }
            : { minimumAmount: '5.00', currency: 'USD', floor: '5.00',
            hasVerificationToken: false, hasForwardUrl: false, prodUrl: null, lastWebhookAt: null } }),
      });
          assert.match(nodes['kofi-webhook-status'].textContent, /Save a verification token.*webhook URL/u);
          assert.equal(nodes['kofi-prod'].hidden, true);
          assert.equal(nodes['kofi-prod-url'].textContent, null);
  });

  it('submits the authenticated settings form without leaving secrets in browser fields', async () => {
    /** @type {Record<string, any>} */
    const nodes = Object.fromEntries(['settings-status', 'minimum-amount', 'currency', 'floor-note',
      'token-status', 'forward-status',
      'verification-token', 'forward-action', 'forward-url', 'save-settings',
      'kofi-prod', 'kofi-prod-url', 'kofi-role-status', 'kofi-webhook-status', 'kofi-entries', 'kofi-entries-status', 'kofi-entries-list', 'kofi-entries-more',
      'kofi-memberships', 'kofi-memberships-status', 'kofi-memberships-list', 'kofi-memberships-more', 'kofi-memberships-refresh']
      .map((id) => [id, { value: '', hidden: true, disabled: false }]));
    nodes['kofi-entries-list'].replaceChildren = () => {};
    nodes['kofi-entries-more'].addEventListener = () => {};
    nodes['kofi-memberships-list'].replaceChildren = () => {};
    nodes['kofi-memberships-more'].addEventListener = () => {};
    nodes['kofi-memberships-refresh'].addEventListener = () => {};
    /** @type {((event: { preventDefault: () => void }) => void) | undefined} */
    let submit;
    nodes['kofi-form'] = { hidden: true, addEventListener: (/** @type {string} */ name, /** @type {typeof submit} */ handler) => {
      if (name === 'submit') submit = handler;
    } };
    /** @type {URLSearchParams | undefined} */
    let posted;
    const settings = { minimumAmount: '5.00', currency: 'USD', floor: '5.00',
      hasVerificationToken: false, hasForwardUrl: false,
      prodUrl: null };
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
        return { ok: true, json: async () => path.endsWith('/memberships') ? { members: [], nextCursor: null }
          : path.endsWith('/entries') ? { entries: [], nextCursor: null }
          : ({ ...settings, hasVerificationToken: Boolean(posted),
            prodUrl: posted ? 'https://renobot.example/prod/kofi/private-id' : null }) };
      },
    });
    assert.ok(submit);
    assert.equal(streams, 0);
    assert.match(nodes['kofi-webhook-status'].textContent, /Save a verification token/u);
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
    assert.equal(nodes['token-status'].textContent, 'Token saved');
    assert.equal(nodes['settings-status'].textContent, 'Settings saved.');
    assert.equal(streams, 1);
    assert.equal(nodes['kofi-prod'].hidden, false);
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
