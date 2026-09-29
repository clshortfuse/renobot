import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { PrismaClient } from '@prisma/client';

import { connectPortalDatabase, createPortalDatabase, MissingVerificationTokenError } from '../../src/database.js';
import { ingestKofiPayment, verifyKofiTestDelivery } from '../../src/kofi-ingestion.js';
import { decryptSetting, encryptSetting, integrationSecretOwner } from '../../src/modder-settings.js';

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
      assert.equal(await verifyKofiTestDelivery(repository, key, first.endpointId, testBody), true);
      assert.ok((await repository.getIntegration(alpha.id))?.lastTestAt);
      assert.equal(await client.kofiEvent.count({ where: { integrationId: first.id } }), 0);
      assert.equal(await repository.recordKofiTest(first.id, 'stale-ciphertext'), false);
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
      assert.ok(updated.lastTestAt);
      assert.equal((await repository.getIntegration(beta.id))?.verificationTokenCiphertext,
        second.verificationTokenCiphertext);
      const replaced = await repository.saveIntegration(alpha, { minimumAmount: '10.00', currency: 'USD',
        verificationToken: 'replacement', forwardUrlAction: 'keep', forwardUrl: '' }, key);
      assert.equal(decryptSetting(replaced.verificationTokenCiphertext, key, integrationSecretOwner(first), 'verification-token'), 'replacement');
      assert.equal(replaced.forwardUrlCiphertext, null);
      assert.equal(replaced.lastTestAt, null);
      assert.equal(await verifyKofiTestDelivery(repository, key, first.endpointId, testBody), false);
    } finally {
      await client.kofiIntegration.deleteMany({ where: { account: { discordUserId: { in: users.map((u) => u.id) } } } });
      await client.account.deleteMany({ where: { discordUserId: { in: users.map((u) => u.id) } } });
    }
  });

  it('applies the checked-in migration and persists an account across connections', async () => {
    const rows = await client.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    assert.deepEqual(new Set(/** @type {{migration_name: string}[]} */ (rows).map((row) => row.migration_name)),
      new Set(['20260928000000_sqlite_portal']));
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