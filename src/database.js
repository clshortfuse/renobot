import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { addCalendarMonths, newlyEarnedMonths, testSupporterDiscordUserId } from './early-access.js';
import { encryptSetting, integrationSecretOwner } from './modder-settings.js';
import { normalizeEmail } from './account-email.js';

/** @typedef {Readonly<{ minimumAmount: string, currency: string, verificationToken: string,
 *   forwardUrlAction: 'keep' | 'replace' | 'clear', forwardUrl: string }>} IntegrationSettings */

export class MissingVerificationTokenError extends Error {}

/**
 * @typedef {Readonly<{
 *   saveLogin: (user: { id: string, username: string }) => Promise<void>,
 *   verifyDiscordEmail: (discordUserId: string, email: string) => Promise<boolean>,
 *   supporterAccount: (discordUserId: string, before?: string) => Promise<{ emails: import('@prisma/client').AccountEmail[], balance: import('@prisma/client').EarlyAccessBalance | null, entries: (import('@prisma/client').KofiEvent & { integration: { account: { lastKnownUsername: string } } })[], nextCursor: string | null }>,
 *   linkEmailPayments: (discordUserId: string) => Promise<{ linked: number, more: boolean }>,
 *   importKofiCsv: (discordUserId: string, payments: import('./kofi-csv.js').CsvPayment[]) => Promise<{ unmatched: number, emailsUpdated: number, unchanged: number }>,
 *   getIntegration: (discordUserId: string) => Promise<import('@prisma/client').KofiIntegration | null>,
 *   findIntegrationByEndpoint: (endpointId: string) => Promise<import('@prisma/client').KofiIntegration | null>,
 *   findEnabledIntegrationByEndpoint: (endpointId: string) => Promise<import('@prisma/client').KofiIntegration | null>,
 *   recordKofiPayment: (integrationId: string, tokenCiphertext: string, payment: import('./kofi-ingestion.js').KofiPayment) => Promise<'rejected' | 'accepted' | 'duplicate'>,
 *   recordKofiReceipt: (integrationId: string, tokenCiphertext: string, payment: import('./kofi-ingestion.js').KofiPayment, membershipFloor?: string, source?: import('./kofi-ingestion.js').KofiDeliverySource, earlyAccessEnabled?: boolean) => Promise<'rejected' | 'accepted' | 'duplicate'>,
 *   listKofiEntries: (discordUserId: string, before?: string) => Promise<{ entries: import('@prisma/client').KofiEvent[], nextCursor: string | null, missingEmailCount?: number }>,
 *   listKofiMemberships: (discordUserId: string, roleId: string | undefined, before?: string) => Promise<{ members: { discordUserId: string, expiresAt: Date, lastPaymentAt: Date, roleManaged: boolean, sync: { nextAttemptAt: Date, lastErrorCode: string | null } | null }[], nextCursor: string | null }>,
 *   hasKofiMembership: (modderDiscordUserId: string, supporterDiscordUserId: string) => Promise<boolean>,
 *   listAdminKofiEntries: (before?: string) => Promise<{ entries: (import('@prisma/client').KofiEvent & { integration: { account: { discordUserId: string, lastKnownUsername: string } } })[], nextCursor: string | null }>,
 *   dueSupporterSync: (now: Date) => Promise<import('@prisma/client').SupporterRoleSync | null>,
 *   activeSupporterLeases: (discordUserId: string, now: Date) => Promise<{ expiresAt: Date }[]>,
 *   hasManagedSupporterRole: (discordUserId: string, roleId: string) => Promise<boolean>,
 *   markManagedSupporterRole: (discordUserId: string, roleId: string) => Promise<void>,
 *   clearManagedSupporterRole: (discordUserId: string, roleId: string) => Promise<void>,
 *   settleSupporterSync: (sync: import('@prisma/client').SupporterRoleSync, nextAttemptAt: Date | null, errorCode?: string) => Promise<void>,
 *   dueEarlyAccessSync: (now: Date) => Promise<import('@prisma/client').EarlyAccessRoleSync | null>,
 *   earlyAccessExpiry: (discordUserId: string) => Promise<Date | null>,
 *   settleEarlyAccessSync: (sync: import('@prisma/client').EarlyAccessRoleSync, nextAttemptAt: Date | null, errorCode?: string) => Promise<void>,
 *   backfillEarlyAccess: (currency: string, after?: string) => Promise<{ scanned: number, nextCursor: string | null } | null>,
 *   approveEarlyAccess: (discordUserId: string, now: Date) => Promise<boolean>,
 *   listEarlyAccessReview: (roleId: string | undefined, before?: string) => Promise<{ members: { discordUserId: string, totalAmount: import('@prisma/client').Prisma.Decimal, creditedMonths: number, expiresAt: Date | null, roleManaged: boolean, sync: { nextAttemptAt: Date, lastErrorCode: string | null } | null }[], nextCursor: string | null }>,
 *   getEarlyAccessReview: (discordUserId: string, before?: string) => Promise<{ periods: import('@prisma/client').EarlyAccessPeriod[], contributions: { eventId: string, amount: import('@prisma/client').Prisma.Decimal, currency: string, eventType: string, receivedAt: Date, modderDiscordUserId: string, modderUsername: string }[], nextCursor: string | null } | null>,
 *   saveIntegration: (user: { id: string, username: string }, settings: IntegrationSettings, key: Buffer) => Promise<import('@prisma/client').KofiIntegration>,
 *   isReady: () => Promise<boolean>,
 *   disconnect: () => Promise<void>,
 * }>} PortalDatabase
 */

/**
 * @param {string | undefined} url
 * @returns {Promise<PortalDatabase | undefined>}
 */
export async function connectPortalDatabase(url) {
  if (!url?.trim()) return undefined;
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    await client.$connect();
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
  return createPortalDatabase(client);
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {import('@prisma/client').KofiEvent} event
 * @param {Date} receivedAt
 * @param {boolean} [queueRole]
 */
async function creditEarlyAccess(tx, event, receivedAt, queueRole = true) {
  const discordUserId = /** @type {string} */ (event.supporterDiscordUserId);
  if (discordUserId === testSupporterDiscordUserId) return;
  if (await tx.earlyAccessCredit.findUnique({ where: { eventId: event.id } })) return;
  const newerCredit = await tx.earlyAccessCredit.findFirst({ where: { discordUserId,
    OR: [{ creditedAt: { gt: receivedAt } }, { creditedAt: receivedAt, eventId: { gt: event.id } }] },
  select: { eventId: true } });
  if (newerCredit) {
    const previous = await tx.earlyAccessBalance.findUnique({ where: { discordUserId }, select: { creditedMonths: true } });
    await tx.earlyAccessCredit.create({ data: { eventId: event.id, discordUserId, creditedAt: receivedAt } });
    const creditedMonths = await rebuildEarlyAccessPeriods(tx, discordUserId);
    if (queueRole && creditedMonths > (previous?.creditedMonths ?? 0)) {
      await tx.earlyAccessRoleSync.upsert({ where: { discordUserId }, create: { discordUserId, nextAttemptAt: receivedAt },
        update: { nextAttemptAt: receivedAt, attemptCount: 0, lastErrorCode: null } });
    }
    return;
  }
  const balance = await tx.earlyAccessBalance.findUnique({ where: { discordUserId } });
  const totalAmount = new Prisma.Decimal(balance?.totalAmount ?? 0).plus(event.amount);
  const start = balance?.expiresAt && balance.expiresAt > receivedAt ? balance.expiresAt : receivedAt;
  const months = newlyEarnedMonths(totalAmount, balance?.creditedMonths ?? 0, start);
  const expiresAt = months ? addCalendarMonths(start, months) : balance?.expiresAt ?? null;
  await tx.earlyAccessBalance.upsert({ where: { discordUserId }, create: {
    discordUserId, totalAmount, creditedMonths: months, expiresAt,
  }, update: { totalAmount, creditedMonths: (balance?.creditedMonths ?? 0) + months, expiresAt } });
  if (months) {
    const active = balance?.expiresAt && balance.expiresAt > receivedAt
      ? await tx.earlyAccessPeriod.findFirst({ where: { discordUserId, expiresAt: balance.expiresAt },
        orderBy: { startedAt: 'desc' } }) : null;
    if (active) await tx.earlyAccessPeriod.update({ where: { id: active.id }, data: {
      expiresAt: /** @type {Date} */ (expiresAt), months: { increment: months },
    } });
    else await tx.earlyAccessPeriod.create({ data: { discordUserId, startedAt: receivedAt,
      expiresAt: /** @type {Date} */ (expiresAt), months } });
    if (queueRole) await tx.earlyAccessRoleSync.upsert({ where: { discordUserId }, create: { discordUserId, nextAttemptAt: receivedAt },
      update: { nextAttemptAt: receivedAt, attemptCount: 0, lastErrorCode: null } });
  }
  await tx.earlyAccessCredit.create({ data: { eventId: event.id, discordUserId, creditedAt: receivedAt } });
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} discordUserId
 */
async function rebuildEarlyAccessPeriods(tx, discordUserId) {
  const credits = await tx.earlyAccessCredit.findMany({ where: { discordUserId },
    orderBy: [{ creditedAt: 'asc' }, { eventId: 'asc' }] });
  const events = await tx.kofiEvent.findMany({ where: { id: { in: credits.map((credit) => credit.eventId) } },
    select: { id: true, amount: true } });
  const amounts = new Map(events.map((item) => [item.id, item.amount]));
  let totalAmount = new Prisma.Decimal(0);
  let creditedMonths = 0;
  /** @type {Date | null} */
  let expiresAt = null;
  /** @type {{ discordUserId: string, startedAt: Date, expiresAt: Date, months: number }[]} */
  const periods = [];
  for (const credit of credits) {
    const amount = amounts.get(credit.eventId);
    if (!amount) throw new Error('Missing credited Ko-fi event');
    totalAmount = totalAmount.plus(amount);
    const active = Boolean(expiresAt && expiresAt > credit.creditedAt);
    const start = active ? /** @type {Date} */ (expiresAt) : credit.creditedAt;
    const months = newlyEarnedMonths(totalAmount, creditedMonths, start);
    if (!months) continue;
    expiresAt = addCalendarMonths(start, months);
    creditedMonths += months;
    const current = periods.at(-1);
    if (active && current) { current.expiresAt = expiresAt; current.months += months; }
    else periods.push({ discordUserId, startedAt: credit.creditedAt, expiresAt, months });
  }
  await tx.earlyAccessPeriod.deleteMany({ where: { discordUserId } });
  if (periods.length) await tx.earlyAccessPeriod.createMany({ data: periods });
  await tx.earlyAccessBalance.upsert({ where: { discordUserId },
    create: { discordUserId, totalAmount, creditedMonths, expiresAt },
    update: { totalAmount, creditedMonths, expiresAt } });
  return creditedMonths;
}

/** @param {import('@prisma/client').PrismaClient} client @returns {PortalDatabase} */
export function createPortalDatabase(client) {
  return {
    async saveLogin({ id, username }) {
      const now = new Date();
      await client.account.upsert({
        where: { discordUserId: id },
        create: { discordUserId: id, lastKnownUsername: username, lastLoginAt: now },
        update: { lastKnownUsername: username, lastLoginAt: now },
      });
    },
    async verifyDiscordEmail(discordUserId, email) {
      const normalized = normalizeEmail(email);
      if (!normalized) return false;
      const account = await client.account.findUniqueOrThrow({ where: { discordUserId }, select: { id: true } });
      // Unique ownership: a later verification must never transfer an address.
      try {
        await client.accountEmail.create({ data: { accountId: account.id, email: normalized,
          verifiedBy: 'discord', verifiedAt: new Date() } });
        return true;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return (await client.accountEmail.findUnique({ where: { email: normalized } }))?.accountId === account.id;
        }
        throw error;
      }
    },
    async supporterAccount(discordUserId, before) {
      const [emails, balance] = await Promise.all([
        client.accountEmail.findMany({ where: { account: { discordUserId } }, orderBy: { verifiedAt: 'asc' } }),
        client.earlyAccessBalance.findUnique({ where: { discordUserId } }),
      ]);
      const cursor = before ? await client.kofiEvent.findFirst({ where: { id: before, supporterDiscordUserId: discordUserId },
        select: { id: true, receivedAt: true } }) : null;
      if (before && !cursor) return { emails, balance, entries: [], nextCursor: null };
      const rows = await client.kofiEvent.findMany({ where: { supporterDiscordUserId: discordUserId,
        ...(cursor ? { OR: [{ receivedAt: { lt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { lt: cursor.id } }] } : {}) },
      include: { integration: { select: { account: { select: { lastKnownUsername: true } } } } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 51 });
      const entries = rows.slice(0, 50);
      return { emails, balance, entries, nextCursor: rows.length > 50 ? entries.at(-1)?.id ?? null : null };
    },
    async linkEmailPayments(discordUserId) {
      return client.$transaction(async (tx) => {
        const emails = await tx.accountEmail.findMany({ where: { account: { discordUserId } }, select: { email: true } });
        const rows = await tx.kofiEvent.findMany({ where: { supporterDiscordUserId: null,
          supporterEmail: { in: emails.map((entry) => entry.email) } },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 51 });
        let linked = 0;
        for (const event of rows.slice(0, 50)) {
          const changed = await tx.kofiEvent.updateMany({ where: { id: event.id, supporterDiscordUserId: null },
            data: { supporterDiscordUserId: discordUserId } });
          if (!changed.count) continue;
          linked++;
        }
        return { linked, more: rows.length > 50 };
      });
    },
    async importKofiCsv(discordUserId, payments) {
      return client.$transaction(async (tx) => {
        const integration = await tx.kofiIntegration.findFirstOrThrow({ where: { account: { discordUserId } } });
        let unmatched = 0;
        let emailsUpdated = 0;
        let unchanged = 0;
        for (const payment of payments) {
          const rows = await tx.kofiEvent.findMany({ where: { integrationId: integration.id, transactionId: payment.transactionId } });
          if (rows.length > 1) throw new Error('Ambiguous stored transaction.');
          const existing = rows[0];
          if (existing) {
            // CSV dates have minute precision; never replace the original webhook timestamp.
            if (!existing.amount.equals(payment.amount) || existing.currency !== payment.currency
              || existing.eventType !== payment.eventType || existing.subscriptionPayment !== payment.subscriptionPayment
              || Math.floor(existing.occurredAt.getTime() / 60_000) !== Math.floor(payment.occurredAt.getTime() / 60_000)
              || existing.supporterEmail && payment.supporterEmail && existing.supporterEmail !== payment.supporterEmail) {
              throw new Error('CSV conflicts with a stored transaction.');
            }
            if (!existing.supporterEmail && payment.supporterEmail) {
              await tx.kofiEvent.update({ where: { id: existing.id }, data: { supporterEmail: payment.supporterEmail } });
              emailsUpdated++;
            } else unchanged++;
          } else {
            unmatched++;
          }
        }
        return { unmatched, emailsUpdated, unchanged };
      }, { timeout: 30_000 });
    },
    async getIntegration(discordUserId) {
      return client.kofiIntegration.findFirst({ where: { account: { discordUserId } } });
    },
    async findIntegrationByEndpoint(endpointId) {
      return client.kofiIntegration.findUnique({ where: { endpointId } });
    },
    async findEnabledIntegrationByEndpoint(endpointId) {
      return client.kofiIntegration.findFirst({ where: { endpointId, enabled: true } });
    },
    async listKofiEntries(discordUserId, before) {
      const owner = { integration: { account: { discordUserId } } };
      const missingEmailCount = await client.kofiEvent.count({ where: { ...owner, supporterEmail: null } });
      const cursor = before ? await client.kofiEvent.findFirst({ where: { ...owner, id: before },
        select: { id: true, receivedAt: true } }) : null;
      if (before && !cursor) return { entries: [], nextCursor: null, missingEmailCount };
      const rows = await client.kofiEvent.findMany({ where: { ...owner,
        ...(cursor ? { OR: [ { receivedAt: { lt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { lt: cursor.id } } ] } : {}) },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 51 });
      const entries = rows.slice(0, 50);
      return { entries, nextCursor: rows.length > 50 ? entries.at(-1)?.id ?? null : null, missingEmailCount };
    },
    async listKofiMemberships(discordUserId, roleId, before) {
      const integration = await client.kofiIntegration.findFirst({ where: { account: { discordUserId } }, select: { id: true } });
      if (!integration) return { members: [], nextCursor: null };
      const cursor = before ? await client.kofiEntitlement.findFirst({ where: { id: before, integrationId: integration.id },
        select: { id: true, expiresAt: true } }) : null;
      if (before && !cursor) return { members: [], nextCursor: null };
      const rows = await client.kofiEntitlement.findMany({ where: { integrationId: integration.id,
        ...(cursor ? { OR: [{ expiresAt: { lt: cursor.expiresAt } },
          { expiresAt: cursor.expiresAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }], take: 51 });
      const page = rows.slice(0, 50);
      const ids = page.map((row) => row.discordUserId);
      const [syncs, managed] = await Promise.all([
        client.supporterRoleSync.findMany({ where: { discordUserId: { in: ids } },
          select: { discordUserId: true, nextAttemptAt: true, lastErrorCode: true } }),
        roleId ? client.managedSupporterRole.findMany({ where: { discordUserId: { in: ids }, roleId },
          select: { discordUserId: true } }) : Promise.resolve([]),
      ]);
      const byId = new Map(syncs.map((sync) => [sync.discordUserId, sync]));
      const managedIds = new Set(managed.map((entry) => entry.discordUserId));
      return { members: page.map((row) => ({ discordUserId: row.discordUserId,
        expiresAt: row.expiresAt, lastPaymentAt: row.lastPaymentAt,
        roleManaged: managedIds.has(row.discordUserId), sync: byId.get(row.discordUserId) ?? null })),
      nextCursor: rows.length > 50 ? page.at(-1)?.id ?? null : null };
    },
    async hasKofiMembership(modderDiscordUserId, supporterDiscordUserId) {
      return Boolean(await client.kofiEntitlement.findFirst({ where: { discordUserId: supporterDiscordUserId,
        integration: { account: { discordUserId: modderDiscordUserId } } }, select: { id: true } }));
    },
    async listAdminKofiEntries(before) {
      const cursor = before ? await client.kofiEvent.findUnique({ where: { id: before },
        select: { id: true, receivedAt: true } }) : null;
      if (before && !cursor) return { entries: [], nextCursor: null };
      const rows = await client.kofiEvent.findMany({ where: cursor ? { OR: [
        { receivedAt: { lt: cursor.receivedAt } },
        { receivedAt: cursor.receivedAt, id: { lt: cursor.id } },
      ] } : {},
      include: { integration: { select: { account: { select: { discordUserId: true, lastKnownUsername: true } } } } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 51 });
      const entries = rows.slice(0, 50);
      return { entries, nextCursor: rows.length > 50 ? entries.at(-1)?.id ?? null : null };
    },
    async dueSupporterSync(now) {
      return client.supporterRoleSync.findFirst({ where: { nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' } });
    },
    async activeSupporterLeases(discordUserId, now) {
      return client.kofiEntitlement.findMany({ where: { discordUserId, expiresAt: { gt: now } },
        select: { expiresAt: true }, orderBy: { expiresAt: 'asc' } });
    },
    async hasManagedSupporterRole(discordUserId, roleId) {
      return Boolean(await client.managedSupporterRole.findUnique({ where: { discordUserId_roleId: { discordUserId, roleId } } }));
    },
    async markManagedSupporterRole(discordUserId, roleId) {
      await client.managedSupporterRole.upsert({ where: { discordUserId_roleId: { discordUserId, roleId } },
        create: { discordUserId, roleId }, update: {} });
    },
    async clearManagedSupporterRole(discordUserId, roleId) {
      await client.managedSupporterRole.deleteMany({ where: { discordUserId, roleId } });
    },
    async settleSupporterSync(sync, nextAttemptAt, errorCode) {
      const where = { discordUserId: sync.discordUserId, nextAttemptAt: sync.nextAttemptAt };
      if (nextAttemptAt) {
        await client.supporterRoleSync.updateMany({ where, data: {
          nextAttemptAt, attemptCount: errorCode ? sync.attemptCount + 1 : 0,
          lastErrorCode: errorCode ?? null,
        } });
      } else await client.supporterRoleSync.deleteMany({ where });
    },
    async dueEarlyAccessSync(now) {
      return client.earlyAccessRoleSync.findFirst({ where: { nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' } });
    },
    async earlyAccessExpiry(discordUserId) {
      return (await client.earlyAccessBalance.findUnique({ where: { discordUserId }, select: { expiresAt: true } }))?.expiresAt ?? null;
    },
    async settleEarlyAccessSync(sync, nextAttemptAt, errorCode) {
      const where = { discordUserId: sync.discordUserId, nextAttemptAt: sync.nextAttemptAt };
      if (nextAttemptAt) {
        await client.earlyAccessRoleSync.updateMany({ where, data: {
          nextAttemptAt, attemptCount: errorCode ? sync.attemptCount + 1 : 0,
          lastErrorCode: errorCode ?? null,
        } });
      } else await client.earlyAccessRoleSync.deleteMany({ where });
    },
    async backfillEarlyAccess(currency, after) {
      const where = { currency, supporterDiscordUserId: { notIn: [testSupporterDiscordUserId] },
        eventType: { in: ['Donation', 'Subscription'] } };
      const cursor = after ? await client.kofiEvent.findFirst({ where: { ...where, id: after },
        select: { id: true, receivedAt: true } }) : null;
      if (after && !cursor) return null;
      const rows = await client.kofiEvent.findMany({ where: { ...where,
        ...(cursor ? { OR: [{ receivedAt: { gt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { gt: cursor.id } }] } : {}) },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 51 });
      const events = rows.slice(0, 50);
      const credited = new Set((await client.earlyAccessCredit.findMany({
        where: { eventId: { in: events.map((event) => event.id) } }, select: { eventId: true },
      })).map((row) => row.eventId));
      // Replay in receipt order so a lapsed donor gets a new period. Never queue a historical grant.
      for (const event of events) {
        if (!credited.has(event.id) && event.occurredAt <= new Date(event.receivedAt.getTime() + 5 * 60_000)) {
          await client.$transaction(async (tx) => { await creditEarlyAccess(tx, event, event.receivedAt, false); });
        }
      }
      return { scanned: events.length, nextCursor: rows.length > 50 ? events.at(-1)?.id ?? null : null };
    },
    async approveEarlyAccess(discordUserId, now) {
      if (discordUserId === testSupporterDiscordUserId) return false;
      return client.$transaction(async (tx) => {
        const balance = await tx.earlyAccessBalance.findUnique({ where: { discordUserId }, select: { expiresAt: true } });
        if (!balance?.expiresAt || balance.expiresAt <= now) return false;
        await tx.earlyAccessRoleSync.upsert({ where: { discordUserId },
          create: { discordUserId, nextAttemptAt: now },
          update: { nextAttemptAt: now, attemptCount: 0, lastErrorCode: null } });
        return true;
      });
    },
    async listEarlyAccessReview(roleId, before) {
      const rows = await client.earlyAccessBalance.findMany({ where: { discordUserId: {
        not: testSupporterDiscordUserId, ...(before ? { gt: before } : {}),
      } },
        orderBy: { discordUserId: 'asc' }, take: 51 });
      const page = rows.slice(0, 50);
      const ids = page.map((row) => row.discordUserId);
      const [managed, syncs] = await Promise.all([
        roleId ? client.managedSupporterRole.findMany({ where: { discordUserId: { in: ids }, roleId },
          select: { discordUserId: true } }) : Promise.resolve([]),
        client.earlyAccessRoleSync.findMany({ where: { discordUserId: { in: ids } },
          select: { discordUserId: true, nextAttemptAt: true, lastErrorCode: true } }),
      ]);
      const managedIds = new Set(managed.map((row) => row.discordUserId));
      const byId = new Map(syncs.map((row) => [row.discordUserId, row]));
      return { members: page.map((row) => ({ discordUserId: row.discordUserId, totalAmount: row.totalAmount,
        creditedMonths: row.creditedMonths, expiresAt: row.expiresAt,
        roleManaged: managedIds.has(row.discordUserId), sync: byId.get(row.discordUserId) ?? null })),
      nextCursor: rows.length > 50 ? page.at(-1)?.discordUserId ?? null : null };
    },
    async getEarlyAccessReview(discordUserId, before) {
      if (discordUserId === testSupporterDiscordUserId) return null;
      if (!await client.earlyAccessBalance.findUnique({ where: { discordUserId }, select: { discordUserId: true } })) return null;
      const cursor = before ? await client.earlyAccessCredit.findFirst({ where: { eventId: before, discordUserId },
        select: { eventId: true, creditedAt: true } }) : null;
      if (before && !cursor) return { periods: [], contributions: [], nextCursor: null };
      const credits = await client.earlyAccessCredit.findMany({ where: { discordUserId,
        ...(cursor ? { OR: [{ creditedAt: { lt: cursor.creditedAt } },
          { creditedAt: cursor.creditedAt, eventId: { lt: cursor.eventId } }] } : {}) },
      orderBy: [{ creditedAt: 'desc' }, { eventId: 'desc' }], take: 51 });
      const page = credits.slice(0, 50);
      const rows = await client.kofiEvent.findMany({ where: { id: { in: page.map((credit) => credit.eventId) } },
      include: { integration: { select: { account: { select: { discordUserId: true, lastKnownUsername: true } } } } },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const periods = await client.earlyAccessPeriod.findMany({ where: { discordUserId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] });
      return { periods, contributions: page.flatMap((credit) => {
        const event = byId.get(credit.eventId);
        return event ? [{ eventId: event.id, amount: event.amount,
          currency: event.currency, eventType: event.eventType, receivedAt: event.receivedAt,
          modderDiscordUserId: event.integration.account.discordUserId,
          modderUsername: event.integration.account.lastKnownUsername }] : [];
      }), nextCursor: credits.length > 50 ? page.at(-1)?.eventId ?? null : null };
    },
    async recordKofiReceipt(integrationId, tokenCiphertext, payment, membershipFloor, source, earlyAccessEnabled) {
      return client.$transaction(async (tx) => {
        const current = await tx.kofiIntegration.updateMany({ where: {
          id: integrationId, verificationTokenCiphertext: tokenCiphertext,
        }, data: { lastWebhookAt: new Date() } });
        if (current.count !== 1) return 'rejected';
        const integration = await tx.kofiIntegration.findUniqueOrThrow({ where: { id: integrationId } });
        /** @type {import('@prisma/client').KofiEvent} */
        let event;
        try {
          event = await tx.kofiEvent.create({ data: { integrationId,
            messageId: payment.messageId, transactionId: payment.transactionId,
            eventType: payment.eventType, amount: payment.amount, currency: payment.currency,
            subscriptionPayment: payment.subscriptionPayment,
            firstSubscriptionPayment: payment.firstSubscriptionPayment,
            occurredAt: payment.occurredAt, supporterDiscordUserId: payment.supporterDiscordUserId,
            supporterEmail: payment.supporterEmail ? normalizeEmail(payment.supporterEmail) : null,
            tierName: payment.tierName, outcome: 'recorded-no-entitlement',
            sourceIp: source?.ip ?? null, sourcePort: source?.port ?? null,
            sourceViaProxy: source?.viaProxy ?? false, peerIp: source?.peerIp ?? null,
            peerPort: source?.peerPort ?? null,
          } });
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return 'duplicate';
          throw error;
        }
        const now = new Date();
        if (earlyAccessEnabled && payment.supporterDiscordUserId
          && payment.supporterDiscordUserId !== testSupporterDiscordUserId && payment.currency === integration.currency
          && ['Donation', 'Subscription'].includes(payment.eventType)
          && payment.occurredAt.getTime() <= now.getTime() + 5 * 60_000) {
          await creditEarlyAccess(tx, event, now);
        }
        const expiresAt = new Date(payment.occurredAt.getTime() + 35 * 24 * 60 * 60 * 1000);
        if (membershipFloor && payment.subscriptionPayment && payment.supporterDiscordUserId
          && payment.currency === integration.currency
          && new Prisma.Decimal(payment.amount).gte(membershipFloor)
          && payment.occurredAt.getTime() <= now.getTime() + 5 * 60_000 && expiresAt > now) {
          const where = { integrationId_discordUserId: { integrationId, discordUserId: payment.supporterDiscordUserId } };
          const existing = await tx.kofiEntitlement.findUnique({ where });
          if (!existing || expiresAt > existing.expiresAt || payment.occurredAt > existing.lastPaymentAt) {
            await tx.kofiEntitlement.upsert({ where, create: { integrationId,
              discordUserId: payment.supporterDiscordUserId, lastEventId: event.id,
              lastPaymentAt: payment.occurredAt, expiresAt }, update: {
              ...(existing && expiresAt <= existing.expiresAt ? {} : { expiresAt }),
              ...(existing && payment.occurredAt <= existing.lastPaymentAt ? {} : {
                lastPaymentAt: payment.occurredAt, lastEventId: event.id,
              }),
            } });
            await tx.kofiEvent.update({ where: { id: event.id }, data: {
              outcome: 'renewed', entitlementExpiresAt: expiresAt,
            } });
            await tx.supporterRoleSync.upsert({ where: { discordUserId: payment.supporterDiscordUserId },
              create: { discordUserId: payment.supporterDiscordUserId, nextAttemptAt: now },
              update: { nextAttemptAt: now, attemptCount: 0, lastErrorCode: null } });
          }
        }
        return 'accepted';
      });
    },
    async recordKofiPayment(integrationId, tokenCiphertext, payment) {
      return client.$transaction(async (tx) => {
        const current = await tx.kofiIntegration.updateMany({
          where: { id: integrationId, enabled: true, verificationTokenCiphertext: tokenCiphertext },
          data: { lastWebhookAt: new Date() },
        });
        if (current.count !== 1) return 'rejected';
        try {
          await tx.kofiEvent.create({ data: { integrationId,
            messageId: payment.messageId, transactionId: payment.transactionId,
            eventType: payment.eventType, amount: payment.amount, currency: payment.currency,
            subscriptionPayment: payment.subscriptionPayment,
            firstSubscriptionPayment: payment.firstSubscriptionPayment,
            occurredAt: payment.occurredAt, supporterDiscordUserId: payment.supporterDiscordUserId,
            supporterEmail: payment.supporterEmail ? normalizeEmail(payment.supporterEmail) : null,
            tierName: payment.tierName, outcome: 'recorded-no-entitlement',
          } });
          return 'accepted';
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return 'duplicate';
          throw error;
        }
      });
    },
    async saveIntegration(user, settings, key) {
      return client.$transaction(async (tx) => {
        const account = await tx.account.upsert({
          where: { discordUserId: user.id },
          create: { discordUserId: user.id, lastKnownUsername: user.username, lastLoginAt: new Date() },
          update: {},
        });
        const existing = await tx.kofiIntegration.findUnique({ where: { accountId: account.id } });
        if (!existing && !settings.verificationToken) throw new MissingVerificationTokenError('Verification token required.');
        const endpointId = existing?.endpointId ?? randomBytes(32).toString('base64url');
        const integrationId = existing?.id ?? randomUUID();
        const owner = integrationSecretOwner({ id: integrationId, accountId: account.id });
        const tokenCiphertext = settings.verificationToken
          ? encryptSetting(settings.verificationToken, key, owner, 'verification-token') : undefined;
        const forwardUrlCiphertext = settings.forwardUrlAction === 'replace'
          ? encryptSetting(settings.forwardUrl, key, owner, 'forward-url') : settings.forwardUrlAction === 'clear' ? null : undefined;
        return tx.kofiIntegration.upsert({
          where: { accountId: account.id },
          create: { id: integrationId, accountId: account.id, endpointId,
            verificationTokenCiphertext: tokenCiphertext ?? '',
            minimumAmount: settings.minimumAmount, currency: settings.currency,
            forwardUrlCiphertext: forwardUrlCiphertext ?? null },
          update: { minimumAmount: settings.minimumAmount, currency: settings.currency,
            ...(tokenCiphertext ? { verificationTokenCiphertext: tokenCiphertext } : {}),
            ...(forwardUrlCiphertext !== undefined ? { forwardUrlCiphertext } : {}) },
        });
      });
    },
    async isReady() {
      try {
        await client.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async disconnect() { await client.$disconnect(); },
  };
}