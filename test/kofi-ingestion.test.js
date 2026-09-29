import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingestKofiPayment, parseKofiPayment, verifyKofiTestDelivery } from '../src/kofi-ingestion.js';
import { encryptSetting, integrationSecretOwner } from '../src/modder-settings.js';

const key = Buffer.alloc(32, 7);
const integration = { id: 'integration-one', accountId: 'owner-one', endpointId: 'endpoint-one', enabled: true,
  verificationTokenCiphertext: '' };
integration.verificationTokenCiphertext = encryptSetting('secret', key, integrationSecretOwner(integration), 'verification-token');
const payload = { verification_token: 'secret', message_id: 'payment-1', timestamp: '2026-09-18T01:31:20Z',
  type: 'Subscription', amount: '5.00', currency: 'USD', kofi_transaction_id: 'transaction-1',
  is_subscription_payment: true, is_first_subscription_payment: false, discord_userid: '012345678901234567',
  tier_name: 'Bronze', email: 'private@example.com', message: 'private payment note',
  shipping: { full_name: 'Private Person' } };

/** @param {Record<string, unknown>} [data] */
function form(data = payload) { return new URLSearchParams({ data: JSON.stringify(data) }).toString(); }

describe('inactive Ko-fi ingestion core', () => {
  it('validates the checked-in schema and retains only minimal ledger fields', () => {
    const parsed = parseKofiPayment(form());
    assert.deepEqual(parsed, { verificationToken: 'secret', messageId: 'payment-1', transactionId: 'transaction-1',
      eventType: 'Subscription', amount: '5.00', currency: 'USD', subscriptionPayment: true,
      firstSubscriptionPayment: false, occurredAt: new Date('2026-09-18T01:31:20Z'),
      supporterDiscordUserId: '012345678901234567', tierName: 'Bronze' });
    assert.doesNotMatch(JSON.stringify(parsed), /private@example\.com|private payment note|Private Person/u);
    assert.equal(parseKofiPayment(form({ ...payload, future_field: 'allowed' }))?.messageId, 'payment-1');
    assert.equal(parseKofiPayment(form({ ...payload, is_subscription_payment: undefined }))?.subscriptionPayment, false);
  });

  it('rejects malformed forms, schema failures, and values outside database bounds', () => {
    for (const body of ['', 'data=%7B', 'other=anything', `${form()}&data=%7B%7D`, `${form()}&extra=1`,
      form({ ...payload, verification_token: 7 }), form({ ...payload, type: 'Unknown' }),
      form({ ...payload, timestamp: 'not-a-date' }), form({ ...payload, amount: '1.234' }),
      form({ ...payload, amount: '9'.repeat(17) }), form({ ...payload, discord_userid: 'not-a-snowflake' }),
      form({ ...payload, message_id: 'x'.repeat(256) }), form({ ...payload, email: 'not-email' }),
      'x'.repeat(32769)]) assert.equal(parseKofiPayment(body), undefined);
  });

  it('rejects disabled or copied integrations and never persists on invalid tokens', async () => {
    /** @type {import('../src/kofi-ingestion.js').KofiPayment[]} */
    const recorded = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findEnabledIntegrationByEndpoint: async (/** @type {string} */ id) => id === integration.endpointId ? integration : null,
      recordKofiPayment: async (/** @type {string} */ _id, /** @type {string} */ _ciphertext, /** @type {import('../src/kofi-ingestion.js').KofiPayment} */ payment) => {
        recorded.push(payment);
        return 'accepted';
      },
    }));
    assert.equal(await ingestKofiPayment(database, key, 'other', form()), 'rejected');
    assert.equal(await ingestKofiPayment(database, key, integration.endpointId, form({ ...payload, verification_token: 'wrong' })), 'rejected');
    assert.equal(await ingestKofiPayment(database, key, integration.endpointId, form({ ...payload, amount: 'invalid' })), 'rejected');
    assert.equal(recorded.length, 0);
    assert.equal(await ingestKofiPayment(database, key, integration.endpointId, form()), 'accepted');
    assert.equal(recorded.length, 1);
    const copied = { ...integration, id: 'another-integration' };
    const copiedDatabase = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findEnabledIntegrationByEndpoint: async () => copied, recordKofiPayment: () => { throw new Error('Must not store'); },
    }));
    assert.equal(await ingestKofiPayment(copiedDatabase, key, integration.endpointId, form()), 'rejected');
    assert.equal(await ingestKofiPayment(database, Buffer.alloc(32, 8), integration.endpointId, form()), 'rejected');
  });

  it('verifies a disabled integration without recording a payment or granting anything', async () => {
    let tests = 0;
    /** @type {unknown[]} */
    const notifications = [];
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      findTestIntegrationByEndpoint: async (/** @type {string} */ id) => id === integration.endpointId
        ? { ...integration, enabled: false } : null,
      recordKofiTest: async () => { tests++; return true; },
      recordKofiPayment: () => { throw new Error('Test payload must not enter the event ledger'); },
    }));
    const notify = (/** @type {string} */ id, /** @type {import('../src/kofi-ingestion.js').KofiTestSummary} */ summary) => {
      notifications.push({ id, summary });
    };
    assert.equal(await verifyKofiTestDelivery(database, key, integration.endpointId, form(), notify), true);
    assert.equal(tests, 1);
    assert.deepEqual(Object.keys(/** @type {any} */ (notifications[0]).summary).sort(),
      ['amount', 'currency', 'eventType', 'receivedAt', 'subscriptionPayment']);
    assert.doesNotMatch(JSON.stringify(notifications), /private@example|private payment note|secret|Private Person|payment-1/u);
    assert.equal(await verifyKofiTestDelivery(database, key, integration.endpointId,
      form({ ...payload, verification_token: 'wrong' }), notify), false);
    assert.equal(await verifyKofiTestDelivery(database, key, 'missing', form()), false);
    assert.equal(await verifyKofiTestDelivery(database, key, integration.endpointId, 'data=invalid'), false);
    assert.equal(tests, 1);
    assert.equal(notifications.length, 1);
  });
});