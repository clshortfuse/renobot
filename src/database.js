import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { encryptSetting, integrationSecretOwner } from './modder-settings.js';

/** @typedef {Readonly<{ minimumAmount: string, currency: string, verificationToken: string,
 *   forwardUrlAction: 'keep' | 'replace' | 'clear', forwardUrl: string }>} IntegrationSettings */

export class MissingVerificationTokenError extends Error {}

/**
 * @typedef {Readonly<{
 *   saveLogin: (user: { id: string, username: string }) => Promise<void>,
 *   getIntegration: (discordUserId: string) => Promise<import('@prisma/client').KofiIntegration | null>,
 *   findIntegrationByEndpoint: (endpointId: string) => Promise<import('@prisma/client').KofiIntegration | null>,
 *   findEnabledIntegrationByEndpoint: (endpointId: string) => Promise<import('@prisma/client').KofiIntegration | null>,
 *   recordKofiPayment: (integrationId: string, tokenCiphertext: string, payment: import('./kofi-ingestion.js').KofiPayment) => Promise<'rejected' | 'accepted' | 'duplicate'>,
 *   recordKofiReceipt: (integrationId: string, tokenCiphertext: string, payment: import('./kofi-ingestion.js').KofiPayment, membershipFloor?: string, source?: import('./kofi-ingestion.js').KofiDeliverySource) => Promise<'rejected' | 'accepted' | 'duplicate'>,
 *   listKofiEntries: (discordUserId: string, before?: string) => Promise<{ entries: import('@prisma/client').KofiEvent[], nextCursor: string | null }>,
 *   listKofiMemberships: (discordUserId: string, roleId: string | undefined, before?: string) => Promise<{ members: { discordUserId: string, expiresAt: Date, lastPaymentAt: Date, roleManaged: boolean, sync: { nextAttemptAt: Date, lastErrorCode: string | null } | null }[], nextCursor: string | null }>,
 *   hasKofiMembership: (modderDiscordUserId: string, supporterDiscordUserId: string) => Promise<boolean>,
 *   listAdminKofiEntries: (before?: string) => Promise<{ entries: (import('@prisma/client').KofiEvent & { integration: { account: { discordUserId: string, lastKnownUsername: string } } })[], nextCursor: string | null }>,
 *   dueSupporterSync: (now: Date) => Promise<import('@prisma/client').SupporterRoleSync | null>,
 *   activeSupporterLeases: (discordUserId: string, now: Date) => Promise<{ expiresAt: Date }[]>,
 *   hasManagedSupporterRole: (discordUserId: string, roleId: string) => Promise<boolean>,
 *   markManagedSupporterRole: (discordUserId: string, roleId: string) => Promise<void>,
 *   clearManagedSupporterRole: (discordUserId: string, roleId: string) => Promise<void>,
 *   settleSupporterSync: (sync: import('@prisma/client').SupporterRoleSync, nextAttemptAt: Date | null, errorCode?: string) => Promise<void>,
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
      const cursor = before ? await client.kofiEvent.findFirst({ where: { ...owner, id: before },
        select: { id: true, receivedAt: true } }) : null;
      if (before && !cursor) return { entries: [], nextCursor: null };
      const rows = await client.kofiEvent.findMany({ where: { ...owner,
        ...(cursor ? { OR: [ { receivedAt: { lt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { lt: cursor.id } } ] } : {}) },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 51 });
      const entries = rows.slice(0, 50);
      return { entries, nextCursor: rows.length > 50 ? entries.at(-1)?.id ?? null : null };
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
    async recordKofiReceipt(integrationId, tokenCiphertext, payment, membershipFloor, source) {
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
        const expiresAt = new Date(payment.occurredAt.getTime() + 35 * 24 * 60 * 60 * 1000);
        if (membershipFloor && payment.subscriptionPayment && payment.supporterDiscordUserId
          && payment.currency === integration.currency
          && new Prisma.Decimal(payment.amount).gte(integration.minimumAmount)
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