import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

const migration = readFileSync(new URL('../prisma/migrations/20260928000000_sqlite_portal/migration.sql', import.meta.url), 'utf8');

describe('Ko-fi persistence schema', () => {
  it('generates the five planned relational models without raw payload fields', () => {
    const models = Prisma.dmmf.datamodel.models;
    for (const name of ['KofiIntegration', 'KofiEvent', 'KofiEntitlement', 'SupporterRoleSync', 'KofiForwardDelivery']) {
      assert.ok(models.some((model) => model.name === name), name);
      const table = models.find((model) => model.name === name)?.dbName;
      assert.ok(table);
      assert.match(migration, new RegExp(`CREATE TABLE "${table}"`, 'u'));
    }
    const event = models.find((model) => model.name === 'KofiEvent');
    assert.ok(event);
    assert.ok(event.fields.some((field) => field.name === 'amount' && field.type === 'Decimal'));
    assert.deepEqual(event.uniqueFields, [['integrationId', 'messageId'], ['id', 'integrationId']]);
    assert.doesNotMatch(migration, /"(?:email|phone|shipping|rawPayload|verificationToken|messageText)"/iu);
  });

  it('enforces event provenance, single outbox delivery, and non-cascading ledger ownership', () => {
    assert.match(migration, /UNIQUE INDEX "kofi_integration_endpoint_id_key"/u);
    assert.match(migration, /UNIQUE INDEX "kofi_entitlement_integration_id_discord_user_id_key"/u);
    assert.match(migration, /FOREIGN KEY \("last_event_id", "integration_id"\) REFERENCES "kofi_event" \("id", "integration_id"\) ON DELETE RESTRICT/u);
    assert.match(migration, /UNIQUE INDEX "kofi_forward_delivery_event_id_key"/u);
    assert.match(migration, /"body_ciphertext" TEXT,/u);
    assert.match(migration, /FOREIGN KEY \("integration_id"\) REFERENCES "kofi_integration" \("id"\) ON DELETE RESTRICT/u);
  });

  it('indexes due work and supporter eligibility without using documents for state', () => {
    for (const index of ['supporter_role_sync_next_attempt_at_idx', 'kofi_forward_delivery_next_attempt_at_idx',
      'kofi_entitlement_discord_user_id_expires_at_idx', 'kofi_entitlement_expires_at_idx']) {
      assert.ok(migration.includes(`CREATE INDEX "${index}"`), index);
    }
    assert.match(migration, /"minimum_amount" DECIMAL NOT NULL/u);
    assert.match(migration, /"amount" DECIMAL NOT NULL/u);
    assert.doesNotMatch(migration, /JSONB/u);
  });
});