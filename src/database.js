import { randomBytes, randomUUID } from 'node:crypto';
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
 *   recordKofiReceipt: (integrationId: string, tokenCiphertext: string, payment: import('./kofi-ingestion.js').KofiPayment) => Promise<'rejected' | 'accepted' | 'duplicate'>,
 *   listKofiEntries: (discordUserId: string, before?: string) => Promise<{ entries: import('@prisma/client').KofiEvent[], nextCursor: string | null }>,
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
    async recordKofiReceipt(integrationId, tokenCiphertext, payment) {
      return client.$transaction(async (tx) => {
        const current = await tx.kofiIntegration.updateMany({
          where: { id: integrationId, verificationTokenCiphertext: tokenCiphertext },
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