import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { PrismaClient } from '@prisma/client';

import { connectPortalDatabase, createPortalDatabase, MissingVerificationTokenError } from '../../src/database.js';
import { ingestKofiPayment, receiveKofiReceipt } from '../../src/kofi-ingestion.js';
import { decryptSetting, encryptSetting, integrationSecretOwner } from '../../src/modder-settings.js';
import { reconcileSupporterRole } from '../../src/supporter-roles.js';
import { membership } from '../fixtures/kofi-membership.js';

const url = process.env.DATABASE_URL;
if (!url?.startsWith('file:') || !url.endsWith('/renobot_test.db')) {
  throw new Error('Database integration tests require a disposable SQLite database.');
}

const client = new PrismaClient({ datasources: { db: { url } } });
before(async () => { await client.$connect(); });
after(async () => { await client.$disconnect(); });

/** @returns {string} */
function discordId() { return `10${randomInt(10000000, 100000000)}${randomInt(10000000, 100000000)}`; }

describe('SQLite migrations and repositories', () => {
  it('renews 35-day leases per modder without shortening them or creating work for ineligible receipts', async () => {
    const database = createPortalDatabase(client);
    const key = Buffer.alloc(32, 7);
    const users = [{ id: discordId(), username: 'alpha' }, { id: discordId(), username: 'beta' }];
    const supporter = discordId();
    const now = Date.now();
    try {
      /** @type {import('@prisma/client').KofiIntegration[]} */
      const integrations = [];
      for (const user of users) integrations.push(await database.saveIntegration(user, {
        minimumAmount: '5.00', currency: 'USD', verificationToken: 'secret',
        forwardUrlAction: 'keep', forwardUrl: '',
      }, key));
      const send = (/** @type {number} */ index, /** @type {string} */ messageId, /** @type {number} */ offsetDays,
        /** @type {string} */ amount = '5.00', /** @type {boolean} */ subscription = true) =>
        receiveKofiReceipt(database, key, integrations[index]?.endpointId ?? '', new URLSearchParams({ data: JSON.stringify({
          ...membership, verification_token: 'secret', message_id: messageId,
          timestamp: new Date(now + offsetDays * 86400000).toISOString(),
          discord_userid: supporter, amount, is_subscription_payment: subscription,
        }) }).toString(), undefined, '5.00');
      assert.equal(await send(0, 'first', -3), 'accepted');
      assert.equal(await send(0, 'first', -3), 'duplicate');
      assert.equal(await send(0, 'renewal', -1), 'accepted');
      assert.equal(await send(0, 'out-of-order', -2), 'accepted');
      assert.equal(await send(1, 'other-modder', -1), 'accepted');
      assert.equal(await send(0, 'too-small', 0, '4.99'), 'accepted');
      assert.equal(await send(0, 'not-recurring', 0, '5.00', false), 'accepted');
      assert.equal(await send(0, 'too-old', -36), 'accepted');
      assert.equal(await send(0, 'future', 1), 'accepted');
      const leases = await database.activeSupporterLeases(supporter, new Date(now));
      assert.equal(leases.length, 2);
      assert.equal((await client.kofiEntitlement.findUniqueOrThrow({ where: {
        integrationId_discordUserId: { integrationId: integrations[0]?.id ?? '', discordUserId: supporter },
      } })).lastPaymentAt.toISOString(), new Date(now - 86400000).toISOString());
      assert.equal((await database.dueSupporterSync(new Date(now + 60000)))?.discordUserId, supporter);
      assert.equal(await client.kofiEvent.count({ where: { outcome: 'renewed', supporterDiscordUserId: supporter } }), 3);
      assert.equal(await database.hasManagedSupporterRole(supporter, 'role'), false);
      let hasRole = false;
      let grants = 0;
      let removals = 0;
      const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({
        guilds: { fetch: async () => ({ roles: { fetch: async () => ({ editable: true }) },
          members: { fetch: async () => ({ roles: {
            cache: { has: () => hasRole },
            add: async () => { hasRole = true; grants++; },
            remove: async () => { hasRole = false; removals++; },
          } }) },
        }) },
      }));
      assert.equal(await reconcileSupporterRole(database, bot, 'guild', 'role', new Date(now + 60000)), true);
      assert.equal(grants, 1);
      assert.equal(await database.hasManagedSupporterRole(supporter, 'role'), true);
      assert.equal(await database.hasManagedSupporterRole(supporter, 'different-role'), false);
      await client.kofiEntitlement.update({ where: { integrationId_discordUserId: {
        integrationId: integrations[0]?.id ?? '', discordUserId: supporter,
      } }, data: { expiresAt: new Date(now - 1000) } });
      await client.supporterRoleSync.update({ where: { discordUserId: supporter }, data: { nextAttemptAt: new Date(0) } });
      await reconcileSupporterRole(database, bot, 'guild', 'role', new Date(now + 120000));
      assert.equal(removals, 0);
      await client.kofiEntitlement.update({ where: { integrationId_discordUserId: {
        integrationId: integrations[1]?.id ?? '', discordUserId: supporter,
      } }, data: { expiresAt: new Date(now - 1000) } });
      await client.supporterRoleSync.update({ where: { discordUserId: supporter }, data: { nextAttemptAt: new Date(0) } });
      await reconcileSupporterRole(database, bot, 'guild', 'role', new Date(now + 180000));
      assert.equal(removals, 1);
      assert.equal(await database.hasManagedSupporterRole(supporter, 'role'), false);
    } finally {
      await client.supporterRoleSync.deleteMany({ where: { discordUserId: supporter } });
      await client.managedSupporterRole.deleteMany({ where: { discordUserId: supporter } });
      await client.kofiEntitlement.deleteMany({ where: { discordUserId: supporter } });
      const ids = users.map((user) => user.id);
      await client.kofiEvent.deleteMany({ where: { integration: { account: { discordUserId: { in: ids } } } } });
      await client.kofiIntegration.deleteMany({ where: { account: { discordUserId: { in: ids } } } });
      await client.account.deleteMany({ where: { discordUserId: { in: ids } } });
    }
  });
  it('pages durable receipts across modder accounts without exposing raw Ko-fi content', async () => {
    const database = createPortalDatabase(client);
    const key = Buffer.alloc(32, 7);
    const users = [{ id: discordId(), username: 'alpha' }, { id: discordId(), username: 'beta' }];
    try {
      for (const [index, user] of users.entries()) {
        const integration = await database.saveIntegration(user, {
          minimumAmount: '5.00', currency: 'USD', verificationToken: 'secret',
          forwardUrlAction: 'keep', forwardUrl: '',
        }, key);
        const body = new URLSearchParams({ data: JSON.stringify({ ...membership,
          verification_token: 'secret', message_id: `owner-receipt-${index}`,
        }) });
        assert.equal(await receiveKofiReceipt(database, key, integration.endpointId, body.toString()), 'accepted');
      }
      const page = await database.listAdminKofiEntries();
      assert.equal(page.entries.length, 2);
      assert.deepEqual(new Set(page.entries.map((entry) => entry.integration.account.discordUserId)),
        new Set(users.map((user) => user.id)));
      assert.ok(page.entries[0]?.integration.account.lastKnownUsername);
      assert.equal((await database.listAdminKofiEntries(page.entries[0]?.id)).entries.length, 1);
      assert.deepEqual(await database.listAdminKofiEntries('not-a-cursor'), { entries: [], nextCursor: null });
      assert.doesNotMatch(JSON.stringify(page), /fixture-token|jo\.example@example\.com|Jo Example/u);
      assert.equal((await database.listKofiEntries(users[0]?.id ?? '')).entries.length, 1);
    } finally {
      const ids = users.map((user) => user.id);
      await client.kofiEvent.deleteMany({ where: { integration: { account: { discordUserId: { in: ids } } } } });
      await client.kofiIntegration.deleteMany({ where: { account: { discordUserId: { in: ids } } } });
      await client.account.deleteMany({ where: { discordUserId: { in: ids } } });
    }
  });
  it('stores verified prod receipts for only their owner without creating supporter work', async () => {
    const repository = createPortalDatabase(client);
    const key = Buffer.alloc(32, 7);
    const owner = { id: discordId(), username: 'receipt-owner' };
    const other = { id: discordId(), username: 'other-owner' };
    try {
      const settings = { minimumAmount: '5.00', currency: 'USD', verificationToken: 'secret',
        forwardUrlAction: /** @type {const} */ ('keep'), forwardUrl: '' };
      const integration = await repository.saveIntegration(owner, settings, key);
      await repository.saveIntegration(other, settings, key);
      assert.equal(integration.enabled, false);
      const payload = new URLSearchParams({ data: JSON.stringify({ ...membership, verification_token: 'secret' }) }).toString();
      const source = { ip: '198.51.100.42', port: 43210, viaProxy: true,
        peerIp: '172.18.0.1', peerPort: 50000 };
      assert.equal(await receiveKofiReceipt(repository, key, integration.endpointId, payload,
        undefined, undefined, source), 'accepted');
      assert.equal(await receiveKofiReceipt(repository, key, integration.endpointId, payload,
        undefined, undefined, { ...source, ip: '203.0.113.9' }), 'duplicate');
      assert.equal((await repository.listKofiEntries(owner.id)).entries.length, 1);
      assert.equal((await repository.listKofiEntries(other.id)).entries.length, 0);
      const receipt = (await repository.listKofiEntries(owner.id)).entries[0];
      assert.equal(receipt?.messageId, membership.message_id);
      assert.equal(receipt?.transactionId, membership.kofi_transaction_id);
      assert.equal(receipt?.supporterDiscordUserId, membership.discord_userid);
      assert.equal(receipt?.tierName, 'Bronze');
      assert.deepEqual({ ip: receipt?.sourceIp, port: receipt?.sourcePort, viaProxy: receipt?.sourceViaProxy,
        peerIp: receipt?.peerIp, peerPort: receipt?.peerPort }, source);
      assert.equal((await repository.listAdminKofiEntries()).entries.find((entry) => entry.id === receipt?.id)?.sourceIp,
        source.ip);
      const receivedAt = new Date('2026-09-29T02:00:00Z');
      await client.kofiEvent.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
        integrationId: integration.id, messageId: `older-${index}`, transactionId: `transaction-${index}`,
        eventType: 'Donation', amount: '1.00', currency: 'USD', subscriptionPayment: false,
        firstSubscriptionPayment: false, occurredAt: receivedAt, receivedAt,
        outcome: 'recorded-no-entitlement',
      })) });
      const first = await repository.listKofiEntries(owner.id);
      assert.equal(first.entries.length, 50);
      assert.ok(first.nextCursor);
      assert.deepEqual(await repository.listKofiEntries(other.id, first.nextCursor), { entries: [], nextCursor: null });
      const second = await repository.listKofiEntries(owner.id, first.nextCursor);
      assert.equal(second.entries.length, 50);
      assert.ok(second.nextCursor);
      const last = await repository.listKofiEntries(owner.id, second.nextCursor);
      assert.equal(last.entries.length, 6);
      assert.equal(last.nextCursor, null);
      assert.equal(new Set([...first.entries, ...second.entries, ...last.entries].map((entry) => entry.id)).size, 106);
      const reopened = await connectPortalDatabase(url);
      assert.ok(reopened);
      try {
        assert.equal((await reopened.listKofiEntries(owner.id)).entries.length, 50);
        assert.equal((await reopened.listKofiEntries(other.id)).entries.length, 0);
      } finally { await reopened.disconnect(); }
      assert.doesNotMatch(JSON.stringify(await repository.listKofiEntries(owner.id)), /jo\.example@example\.com|Jo Example|Jo#4105|fixture-token/u);
      assert.equal(await client.kofiEntitlement.count({ where: { integrationId: integration.id } }), 0);
      assert.equal(await client.supporterRoleSync.count(), 0);
      assert.equal(await client.kofiForwardDelivery.count({ where: { event: { integrationId: integration.id } } }), 0);
    } finally {
      const users = [owner.id, other.id];
      await client.kofiEvent.deleteMany({ where: { integration: { account: { discordUserId: { in: users } } } } });
      await client.kofiIntegration.deleteMany({ where: { account: { discordUserId: { in: users } } } });
      await client.account.deleteMany({ where: { discordUserId: { in: users } } });
    }
  });
  it('records verified retries once per enabled integration without granting roles or retaining personal data', async () => {
    const repository = createPortalDatabase(client);
    const key = Buffer.alloc(32, 7);
    const users = [discordId(), discordId()];
    try {
      const integrations = [];
      for (const id of users) {
        const account = await client.account.create({ data: {
          discordUserId: id, lastKnownUsername: 'modder', lastLoginAt: new Date(),
        } });
        const integration = await client.kofiIntegration.create({ data: {
          accountId: account.id, endpointId: randomUUID(),
          verificationTokenCiphertext: 'pending', minimumAmount: '5.00', currency: 'USD', enabled: true,
        } });
        integrations.push(await client.kofiIntegration.update({ where: { id: integration.id }, data: {
          verificationTokenCiphertext: encryptSetting('secret', key, integrationSecretOwner(integration), 'verification-token'),
        } }));
      }
      const first = integrations[0];
      const second = integrations[1];
      assert.ok(first && second);
      const body = new URLSearchParams({ data: JSON.stringify({ verification_token: 'secret',
        message_id: 'shared-message-id', kofi_transaction_id: 'transaction', timestamp: '2026-09-18T01:31:20Z',
        type: 'Subscription', amount: '5.00', currency: 'USD', is_subscription_payment: true,
        email: 'private@example.com', message: 'private payment note',
      }) }).toString();
      assert.deepEqual((await Promise.all(Array.from({ length: 4 }, () => ingestKofiPayment(repository, key, first.endpointId, body)))).sort(),
        ['accepted', 'duplicate', 'duplicate', 'duplicate']);
      assert.equal(await ingestKofiPayment(repository, key, second.endpointId, body), 'accepted');
      assert.equal(await client.kofiEvent.count({ where: { messageId: 'shared-message-id', integrationId: first.id } }), 1);
      assert.ok((await client.kofiIntegration.findUniqueOrThrow({ where: { id: first.id } })).lastWebhookAt);
      const event = await client.kofiEvent.findFirstOrThrow({ where: { integrationId: first.id } });
      assert.equal(event.outcome, 'recorded-no-entitlement');
      assert.doesNotMatch(JSON.stringify(event), /private@example\.com|private payment note|secret/u);
      assert.equal(await client.kofiEntitlement.count({ where: { integrationId: first.id } }), 0);
      assert.equal(await client.supporterRoleSync.count(), 0);
      assert.equal(await client.kofiForwardDelivery.count({ where: { event: { integrationId: first.id } } }), 0);
      await client.kofiIntegration.update({ where: { id: first.id }, data: { enabled: false } });
      assert.equal(await ingestKofiPayment(repository, key, first.endpointId, body), 'rejected');
      assert.equal(await repository.recordKofiPayment(first.id, first.verificationTokenCiphertext, {
        verificationToken: 'secret', messageId: 'another', transactionId: 'another', eventType: 'Donation',
        amount: '5.00', currency: 'USD', subscriptionPayment: false, firstSubscriptionPayment: false,
        occurredAt: new Date(), supporterDiscordUserId: null, tierName: null,
      }), 'rejected');
      await client.kofiIntegration.update({ where: { id: second.id }, data: { verificationTokenCiphertext: 'rotated' } });
      assert.equal(await ingestKofiPayment(repository, key, second.endpointId, body), 'rejected');
      assert.equal(await repository.recordKofiPayment(second.id, second.verificationTokenCiphertext, {
        verificationToken: 'secret', messageId: 'new-message', transactionId: 'new-transaction',
        eventType: 'Subscription', amount: '5.00', currency: 'USD', subscriptionPayment: true,
        firstSubscriptionPayment: false, occurredAt: new Date(), supporterDiscordUserId: null, tierName: null,
      }), 'rejected');
      assert.equal(await client.kofiEvent.count({ where: { integrationId: second.id } }), 1);
    } finally {
      const where = { integration: { account: { discordUserId: { in: users } } } };
      await client.kofiEvent.deleteMany({ where });
      await client.kofiIntegration.deleteMany({ where: { account: { discordUserId: { in: users } } } });
      await client.account.deleteMany({ where: { discordUserId: { in: users } } });
    }
  });

  it('stores only encrypted settings under the authenticated modder account', async () => {
    const repository = createPortalDatabase(client);
    const alpha = { id: discordId(), username: 'alpha' };
    const beta = { id: discordId(), username: 'beta' };
    const users = [alpha, beta];
    const key = Buffer.alloc(32, 7);
    try {
      await assert.rejects(repository.saveIntegration(alpha, {
        minimumAmount: '5.00', currency: 'USD', verificationToken: '', forwardUrlAction: 'keep', forwardUrl: '',
      }, key), MissingVerificationTokenError);
      assert.equal(await client.account.count({ where: { discordUserId: alpha.id } }), 0);
      const first = await repository.saveIntegration(alpha, {
        minimumAmount: '5.00', currency: 'USD', verificationToken: 'private-alpha',
        forwardUrlAction: 'replace', forwardUrl: 'https://example.com/alpha',
      }, key);
      const second = await repository.saveIntegration(beta, {
        minimumAmount: '7.00', currency: 'USD', verificationToken: 'private-beta', forwardUrlAction: 'keep', forwardUrl: '',
      }, key);
      assert.equal(decryptSetting(first.verificationTokenCiphertext, key, integrationSecretOwner(first), 'verification-token'), 'private-alpha');
      assert.equal(decryptSetting(first.forwardUrlCiphertext ?? '', key, integrationSecretOwner(first), 'forward-url'), 'https://example.com/alpha');
      assert.throws(() => decryptSetting(first.verificationTokenCiphertext, key, integrationSecretOwner(second), 'verification-token'));
      assert.throws(() => decryptSetting(first.verificationTokenCiphertext, key, integrationSecretOwner(first), 'forward-url'));
      assert.throws(() => decryptSetting(first.verificationTokenCiphertext, key,
        integrationSecretOwner({ ...first, accountId: second.accountId }), 'verification-token'));
      await client.kofiIntegration.update({ where: { id: second.id }, data: {
        verificationTokenCiphertext: first.verificationTokenCiphertext,
      } });
      const copied = await repository.getIntegration(beta.id);
      assert.ok(copied);
      assert.throws(() => decryptSetting(copied.verificationTokenCiphertext, key,
        integrationSecretOwner(copied), 'verification-token'));
      await client.kofiIntegration.update({ where: { id: second.id }, data: {
        verificationTokenCiphertext: second.verificationTokenCiphertext,
      } });
      assert.notEqual(first.endpointId, second.endpointId);
      assert.equal(first.enabled, false);
      const testBody = new URLSearchParams({ data: JSON.stringify({ verification_token: 'private-alpha',
        message_id: 'tester-message', kofi_transaction_id: 'tester-transaction',
        timestamp: '2026-09-18T01:31:20Z', type: 'Donation', amount: '5.00', currency: 'USD',
      }) }).toString();
      assert.equal(await receiveKofiReceipt(repository, key, first.endpointId, testBody), 'accepted');
      assert.ok((await repository.getIntegration(alpha.id))?.lastWebhookAt);
      assert.equal(await client.kofiEvent.count({ where: { integrationId: first.id } }), 1);
      assert.equal(await repository.recordKofiReceipt(first.id, 'stale-ciphertext', {
        verificationToken: 'private-alpha', messageId: 'stale', transactionId: 'stale', eventType: 'Donation',
        amount: '5.00', currency: 'USD', subscriptionPayment: false, firstSubscriptionPayment: false,
        occurredAt: new Date(), supporterDiscordUserId: null, tierName: null,
      }), 'rejected');
      assert.equal((await client.account.findUniqueOrThrow({ where: { discordUserId: alpha.id } })).id, first.accountId);
      assert.equal((await repository.getIntegration(beta.id))?.id, second.id);
      assert.doesNotMatch(JSON.stringify(first), /private-alpha|https:\/\/example\.com\/alpha/u);
      const updated = await repository.saveIntegration(alpha, {
        minimumAmount: '9.25', currency: 'USD', verificationToken: '', forwardUrlAction: 'clear', forwardUrl: '',
      }, key);
      assert.equal(updated.id, first.id);
      assert.equal(updated.endpointId, first.endpointId);
      assert.equal(updated.enabled, false);
      assert.equal(updated.verificationTokenCiphertext, first.verificationTokenCiphertext);
      assert.equal(updated.forwardUrlCiphertext, null);
      assert.equal(updated.minimumAmount.toFixed(2), '9.25');
      assert.ok(updated.lastWebhookAt);
      assert.equal((await repository.getIntegration(beta.id))?.verificationTokenCiphertext,
        second.verificationTokenCiphertext);
      const replaced = await repository.saveIntegration(alpha, { minimumAmount: '10.00', currency: 'USD',
        verificationToken: 'replacement', forwardUrlAction: 'keep', forwardUrl: '' }, key);
      assert.equal(decryptSetting(replaced.verificationTokenCiphertext, key, integrationSecretOwner(first), 'verification-token'), 'replacement');
      assert.equal(replaced.forwardUrlCiphertext, null);
      assert.ok(replaced.lastWebhookAt);
      assert.equal(await receiveKofiReceipt(repository, key, first.endpointId, testBody), 'rejected');
    } finally {
      await client.kofiEvent.deleteMany({ where: { integration: { account: { discordUserId: { in: users.map((u) => u.id) } } } } });
      await client.kofiIntegration.deleteMany({ where: { account: { discordUserId: { in: users.map((u) => u.id) } } } });
      await client.account.deleteMany({ where: { discordUserId: { in: users.map((u) => u.id) } } });
    }
  });

  it('applies the checked-in migration and persists an account across connections', async () => {
    const rows = await client.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    assert.deepEqual(new Set(/** @type {{migration_name: string}[]} */ (rows).map((row) => row.migration_name)),
      new Set(['20260928000000_sqlite_portal', '20260929000000_managed_supporter_role',
        '20260929010000_kofi_delivery_source']));
    const id = discordId();
    const database = await connectPortalDatabase(url);
    assert.ok(database);
    try {
      await database.saveLogin({ id, username: 'before' });
      const account = await client.account.findUniqueOrThrow({ where: { discordUserId: id } });
      await database.saveLogin({ id, username: 'after' });
      await database.disconnect();
      const reopened = await connectPortalDatabase(url);
      assert.ok(reopened);
      try {
        assert.equal((await client.account.findUniqueOrThrow({ where: { discordUserId: id } })).lastKnownUsername, 'after');
        assert.equal((await client.account.findUniqueOrThrow({ where: { discordUserId: id } })).id, account.id);
        assert.equal(await client.account.count({ where: { discordUserId: id } }), 1);
        await assert.rejects(client.account.create({ data: {
          discordUserId: id, lastKnownUsername: 'duplicate', lastLoginAt: new Date(),
        } }), { code: 'P2002' });
      } finally {
        await reopened.disconnect();
      }
    } finally {
      await database.disconnect();
      await client.account.deleteMany({ where: { discordUserId: id } });
    }
  });

  it('enforces Ko-fi event idempotency, owner uniqueness, and same-integration event provenance', async () => {
    const ids = [discordId(), discordId()];
    const accounts = await Promise.all(ids.map((id) => client.account.create({
      data: { discordUserId: id, lastKnownUsername: id, lastLoginAt: new Date() },
    })));
    try {
      const integrations = await Promise.all(accounts.map((account) => client.kofiIntegration.create({
        data: { accountId: account.id, endpointId: randomUUID(),
          verificationTokenCiphertext: 'test-ciphertext', minimumAmount: '5.00', currency: 'USD' },
      })));
      const first = integrations[0];
      const second = integrations[1];
      assert.ok(first && second);
      assert.equal(first.minimumAmount.toString(), '5');
      assert.equal(first.enabled, false);
      await assert.rejects(client.kofiIntegration.create({ data: {
        accountId: accounts[0]?.id ?? '', endpointId: randomUUID(),
        verificationTokenCiphertext: 'test-ciphertext', minimumAmount: '5.00', currency: 'USD',
      } }), { code: 'P2002' });
      const event = await client.kofiEvent.create({ data: {
        integrationId: first.id, messageId: randomUUID(), transactionId: randomUUID(), eventType: 'Donation',
        amount: '5.25', currency: 'USD', subscriptionPayment: true, firstSubscriptionPayment: false,
        occurredAt: new Date(), outcome: 'accepted',
      } });
      assert.equal(event.amount.toString(), '5.25');
      await assert.rejects(client.kofiEvent.create({ data: {
        integrationId: first.id, messageId: event.messageId, transactionId: randomUUID(), eventType: 'Donation',
        amount: '5.25', currency: 'USD', subscriptionPayment: true, firstSubscriptionPayment: false,
        occurredAt: new Date(), outcome: 'accepted',
      } }), { code: 'P2002' });
      await assert.rejects(client.kofiEntitlement.create({ data: {
        integrationId: second.id, lastEventId: event.id, discordUserId: discordId(),
        lastPaymentAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      } }), { code: 'P2003' });
      const entitlement = await client.kofiEntitlement.create({ data: {
        integrationId: first.id, lastEventId: event.id, discordUserId: discordId(),
        lastPaymentAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      } });
      await assert.rejects(client.kofiEntitlement.create({ data: {
        integrationId: first.id, lastEventId: event.id, discordUserId: entitlement.discordUserId,
        lastPaymentAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
      } }), { code: 'P2002' });
      await assert.rejects(client.kofiIntegration.delete({ where: { id: first.id } }), { code: 'P2003' });
    } finally {
      await client.kofiEntitlement.deleteMany({ where: { integration: { accountId: { in: accounts.map((a) => a.id) } } } });
      await client.kofiEvent.deleteMany({ where: { integration: { accountId: { in: accounts.map((a) => a.id) } } } });
      await client.kofiIntegration.deleteMany({ where: { accountId: { in: accounts.map((a) => a.id) } } });
      await client.account.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
    }
  });

  it('coalesces role sync per user and retains delivery history after clearing encrypted content', async () => {
    const id = discordId();
    const account = await client.account.create({ data: { discordUserId: id, lastKnownUsername: id, lastLoginAt: new Date() } });
    try {
      const integration = await client.kofiIntegration.create({ data: {
        accountId: account.id, endpointId: randomUUID(), verificationTokenCiphertext: 'test-ciphertext',
        minimumAmount: '5.00', currency: 'USD',
      } });
      const event = await client.kofiEvent.create({ data: {
        integrationId: integration.id, messageId: randomUUID(), transactionId: randomUUID(), eventType: 'Donation',
        amount: '5.00', currency: 'USD', subscriptionPayment: true, firstSubscriptionPayment: true,
        occurredAt: new Date(), outcome: 'accepted',
      } });
      const job = await client.supporterRoleSync.create({ data: { discordUserId: id, nextAttemptAt: new Date() } });
      assert.equal(job.attemptCount, 0);
      await assert.rejects(client.supporterRoleSync.create({ data: {
        discordUserId: id, nextAttemptAt: new Date(),
      } }), { code: 'P2002' });
      const delivery = await client.kofiForwardDelivery.create({ data: {
        eventId: event.id, bodyCiphertext: 'test-ciphertext', nextAttemptAt: new Date(),
      } });
      await assert.rejects(client.kofiForwardDelivery.create({ data: {
        eventId: event.id, bodyCiphertext: 'test-ciphertext', nextAttemptAt: new Date(),
      } }), { code: 'P2002' });
      const updated = await client.kofiForwardDelivery.update({ where: { id: delivery.id },
        data: { bodyCiphertext: null, deliveredAt: new Date() } });
      assert.equal(updated.bodyCiphertext, null);
      assert.ok(updated.deliveredAt);
    } finally {
      await client.kofiForwardDelivery.deleteMany({ where: { event: { integration: { accountId: account.id } } } });
      await client.supporterRoleSync.deleteMany({ where: { discordUserId: id } });
      await client.kofiEvent.deleteMany({ where: { integration: { accountId: account.id } } });
      await client.kofiIntegration.deleteMany({ where: { accountId: account.id } });
      await client.account.delete({ where: { id: account.id } });
    }
  });
});