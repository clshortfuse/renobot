import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { decryptSetting, integrationSecretOwner } from './modder-settings.js';

const require = createRequire(import.meta.url);
const Ajv2020 = /** @type {typeof import('ajv/dist/2020.js').default} */ (require('ajv/dist/2020.js'));
const addFormats = /** @type {typeof import('ajv-formats').default} */ (require('ajv-formats'));
const validator = new Ajv2020();
addFormats(validator);
const validatePayment = validator.compile(JSON.parse(readFileSync(new URL('../schemas/kofi-payment-webhook.schema.json', import.meta.url), 'utf8')));
export const maxKofiBodyBytes = 256 * 1024;

/** @typedef {Readonly<{ verificationToken: string, messageId: string, transactionId: string,
 *   eventType: string, amount: string, currency: string, subscriptionPayment: boolean,
 *   firstSubscriptionPayment: boolean, occurredAt: Date, supporterDiscordUserId: string | null,
 *   tierName: string | null }>} KofiPayment */
/** @typedef {Readonly<{ ip: string | null, port: number | null, viaProxy: boolean,
 *   peerIp: string | null, peerPort: number | null }>} KofiDeliverySource */

/**
 * Parse Ko-fi's one-field form, retaining only the values needed for the event ledger.
 * @param {string | Buffer} rawBody
 * @returns {KofiPayment | undefined}
 */
export function parseKofiPayment(rawBody) {
  if (Buffer.byteLength(rawBody) > maxKofiBodyBytes) return undefined;
  const body = new URLSearchParams(rawBody.toString());
  if ([...body.keys()].length !== 1 || !body.has('data')) return undefined;
  /** @type {unknown} */
  let payload;
  try { payload = JSON.parse(body.get('data') ?? ''); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const supplied = /** @type {Record<string, unknown>} */ (payload);
  const data = /** @type {{ verification_token: string, message_id: string, kofi_transaction_id: string,
   *  timestamp: string, type: string, amount: string, currency: string,
   *  is_subscription_payment?: boolean, is_first_subscription_payment?: boolean,
   *  discord_userid?: string | null, tier_name?: string | null }} */ (Object.fromEntries([
    'verification_token', 'message_id', 'kofi_transaction_id', 'timestamp', 'type', 'amount', 'currency',
  ].map((name) => [name, supplied[name]])));
  if (typeof supplied.is_subscription_payment === 'boolean') data.is_subscription_payment = supplied.is_subscription_payment;
  if (typeof supplied.is_first_subscription_payment === 'boolean') data.is_first_subscription_payment = supplied.is_first_subscription_payment;
  if (typeof supplied.discord_userid === 'string' && /^\d{17,20}$/u.test(supplied.discord_userid)) {
    data.discord_userid = supplied.discord_userid;
  }
  if (typeof supplied.tier_name === 'string') data.tier_name = supplied.tier_name;
  if (!validatePayment(data)) return undefined;
  if (data.verification_token.length > 256 || data.message_id.length > 255
    || data.kofi_transaction_id.length > 255 || data.type.length > 64
    || data.amount.length > 19 || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(data.amount)
    || (data.tier_name?.length ?? 0) > 255) return undefined;
  const occurredAt = new Date(data.timestamp);
  if (Number.isNaN(occurredAt.getTime())) return undefined;
  return { verificationToken: data.verification_token, messageId: data.message_id,
    transactionId: data.kofi_transaction_id, eventType: data.type, amount: data.amount,
    currency: data.currency, subscriptionPayment: data.is_subscription_payment === true,
    firstSubscriptionPayment: data.is_first_subscription_payment === true,
    occurredAt, supporterDiscordUserId: data.discord_userid ?? null, tierName: data.tier_name ?? null };
}

/** @param {string} supplied @param {string} expected */
function sameToken(supplied, expected) {
  const left = createHash('sha256').update(supplied, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right) && Buffer.byteLength(supplied) === Buffer.byteLength(expected);
}

/** @param {import('@prisma/client').KofiIntegration} integration @param {Buffer} key @param {KofiPayment} payment */
function verifiedToken(integration, key, payment) {
  try {
    return sameToken(payment.verificationToken, decryptSetting(integration.verificationTokenCiphertext, key,
      integrationSecretOwner(integration), 'verification-token'));
  } catch { return false; }
}

/**
 * Internal only: no web route calls this until entitlement and forwarding work is implemented.
 * @param {import('./database.js').PortalDatabase} database
 * @param {Buffer} key
 * @param {string} endpointId
 * @param {string | Buffer} rawBody
 * @returns {Promise<'rejected' | 'accepted' | 'duplicate'>}
 */
export async function ingestKofiPayment(database, key, endpointId, rawBody) {
  const payment = parseKofiPayment(rawBody);
  if (!payment) return 'rejected';
  const integration = await database.findEnabledIntegrationByEndpoint(endpointId);
  if (!integration || !verifiedToken(integration, key, payment)) return 'rejected';
  return database.recordKofiPayment(integration.id, integration.verificationTokenCiphertext, payment);
}

/**
 * Store only a minimal receipt. This deliberately never creates an entitlement,
 * forwards a payload, or changes a Discord role.
 * @param {import('./database.js').PortalDatabase} database
 * @param {Buffer} key
 * @param {string} endpointId
 * @param {string | Buffer} rawBody
 * @param {(integrationId: string) => void} [onRecorded]
 * @param {string} [membershipFloor]
 * @param {KofiDeliverySource} [source]
 * @returns {Promise<'rejected' | 'accepted' | 'duplicate'>}
 */
export async function receiveKofiReceipt(database, key, endpointId, rawBody, onRecorded, membershipFloor, source) {
  const payment = parseKofiPayment(rawBody);
  if (!payment) return 'rejected';
  const integration = await database.findIntegrationByEndpoint(endpointId);
  if (!integration || !verifiedToken(integration, key, payment)) return 'rejected';
  const result = await database.recordKofiReceipt(integration.id, integration.verificationTokenCiphertext, payment, membershipFloor, source);
  if (result === 'accepted') {
    try { onRecorded?.(integration.id); } catch { /* A live notice cannot undo an accepted receipt. */ }
  }
  return result;
}