import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';
import { addCalendarMonths, newlyEarnedMonths } from '../src/early-access.js';
import { reconcileEarlyAccessRole } from '../src/supporter-roles.js';

describe('early-access periods', () => {
  it('clamps calendar months at month end and preserves the clock', () => {
    assert.equal(addCalendarMonths(new Date('2028-01-31T13:23:00Z'), 1).toISOString(), '2028-02-29T13:23:00.000Z');
    assert.equal(addCalendarMonths(new Date('2026-12-31T13:23:00Z'), 2).toISOString(), '2027-02-28T13:23:00.000Z');
    assert.equal(newlyEarnedMonths(new Prisma.Decimal('13.00'), 0, new Date()), 2);
    assert.equal(newlyEarnedMonths(new Prisma.Decimal('19.00'), 2, new Date()), 1);
    assert.equal(newlyEarnedMonths(new Prisma.Decimal('4.99'), 0, new Date()), 0);
  });

  it('does not adopt or remove a manual role after expiry', async () => {
    let pending = true;
    let removes = 0;
    const database = /** @type {import('../src/database.js').PortalDatabase} */ (/** @type {unknown} */ ({
      dueEarlyAccessSync: async () => pending ? { discordUserId: '12345678901234567',
        nextAttemptAt: new Date(0), attemptCount: 0 } : null,
      earlyAccessExpiry: async () => new Date(0), hasManagedSupporterRole: async () => false,
      settleEarlyAccessSync: async () => { pending = false; },
    }));
    const bot = /** @type {import('discord.js').Client} */ (/** @type {unknown} */ ({ guilds: {
      fetch: async () => ({ members: { fetch: async () => ({ roles: {
        cache: { has: () => true }, remove: async () => { removes++; },
      } }) } }),
    } }));
    assert.equal(await reconcileEarlyAccessRole(database, bot, 'guild', 'early-role'), true);
    assert.equal(removes, 0);
    assert.equal(await reconcileEarlyAccessRole(database, bot, 'guild', 'early-role'), false);
  });
});