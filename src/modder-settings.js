import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** @typedef {Readonly<{ key: Buffer, minimumAmount: string, currency: string }>} ModderSettingsConfig */

/** @param {NodeJS.ProcessEnv} [environment] @returns {ModderSettingsConfig | undefined} */
export function readModderSettingsConfig(environment = process.env) {
  const names = ['KOFI_ENCRYPTION_KEY', 'SUPPORTER_MINIMUM_AMOUNT', 'SUPPORTER_CURRENCY'];
  if (names.every((name) => !environment[name]?.trim())) return undefined;
  if (names.some((name) => !environment[name]?.trim())) throw new Error(`Modder settings require ${names.join(', ')}.`);
  const raw = environment.KOFI_ENCRYPTION_KEY?.trim() ?? '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('KOFI_ENCRYPTION_KEY must be 32 bytes encoded as base64.');
  }
  const minimumAmount = environment.SUPPORTER_MINIMUM_AMOUNT?.trim() ?? '';
  if (!validAmount(minimumAmount)) throw new Error('SUPPORTER_MINIMUM_AMOUNT must be between 0.01 and 100000.00.');
  const currency = environment.SUPPORTER_CURRENCY?.trim() ?? '';
  if (!/^[A-Z]{3}$/u.test(currency)) throw new Error('SUPPORTER_CURRENCY must be a three-letter uppercase currency code.');
  return Object.freeze({ key, minimumAmount, currency });
}

/** @param {string} amount */
function validAmount(amount) {
  return /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(amount)
    && Number(amount) >= 0.01 && Number(amount) <= 100000;
}

/** @typedef {'verification-token' | 'forward-url'} SecretField */

/** @param {{ id: string, accountId: string }} integration */
export function integrationSecretOwner(integration) {
  return JSON.stringify([integration.accountId, integration.id]);
}

/** @param {string} owner @param {SecretField} field */
function associatedData(owner, field) {
  if (!owner) throw new Error('Secret owner is required.');
  return Buffer.from(JSON.stringify(['renobot:kofi:v1', owner, field]));
}

/** @param {string} value @param {Buffer} key @param {string} owner @param {SecretField} field */
export function encryptSetting(value, key, owner, field) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(owner, field));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

/** @param {string} value @param {Buffer} key @param {string} owner @param {SecretField} field */
export function decryptSetting(value, key, owner, field) {
  const parts = /^v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(value);
  if (!parts || value.length > 8192) throw new Error('Invalid encrypted setting.');
  const nonce = Buffer.from(parts[1] ?? '', 'base64url');
  const tag = Buffer.from(parts[2] ?? '', 'base64url');
  const encrypted = Buffer.from(parts[3] ?? '', 'base64url');
  if (nonce.length !== 12 || tag.length !== 16 || encrypted.length === 0
    || nonce.toString('base64url') !== parts[1] || tag.toString('base64url') !== parts[2]
    || encrypted.toString('base64url') !== parts[3]) throw new Error('Invalid encrypted setting.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData(owner, field));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Invalid encrypted setting.');
  }
}

/**
 * @param {URLSearchParams} body
 * @param {ModderSettingsConfig} config
 * @returns {{ minimumAmount: string, currency: string, verificationToken: string, forwardUrlAction: 'keep' | 'replace' | 'clear', forwardUrl: string } | undefined}
 */
export function parseModderSettings(body, config) {
  const keys = ['csrf', 'minimumAmount', 'currency', 'verificationToken', 'forwardUrlAction', 'forwardUrl'];
  if ([...body.keys()].some((key) => !keys.includes(key) || body.getAll(key).length !== 1)) return undefined;
  const minimumAmount = body.get('minimumAmount') ?? '';
  const currency = body.get('currency') ?? '';
  const verificationToken = body.get('verificationToken') ?? '';
  const forwardUrlAction = body.get('forwardUrlAction');
  const forwardUrl = body.get('forwardUrl') ?? '';
  if (!validAmount(minimumAmount) || Number(minimumAmount) < Number(config.minimumAmount)
    || currency !== config.currency || verificationToken.length > 256
    || (verificationToken.length > 0 && (!verificationToken.trim()
      || [...verificationToken].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
    || !['keep', 'replace', 'clear'].includes(forwardUrlAction ?? '')
    || (forwardUrlAction !== 'replace' && forwardUrl) || forwardUrl.length > 2048) return undefined;
  if (forwardUrlAction === 'replace') {
    try {
      const url = new URL(forwardUrl);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash
        || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
        || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(url.hostname) || url.hostname.includes(':')) return undefined;
    } catch { return undefined; }
  }
  return { minimumAmount: Number(minimumAmount).toFixed(2), currency, verificationToken,
    forwardUrlAction: /** @type {'keep' | 'replace' | 'clear'} */ (forwardUrlAction), forwardUrl };
}