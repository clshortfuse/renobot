import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** @param {string} secret @param {number} now */
export function createOAuthState(secret, now = Date.now()) {
  return sign({ expiresAt: now + 10 * 60_000, nonce: randomBytes(24).toString('base64url') }, secret);
}

/** @param {string} token @param {string} secret @param {number} now */
export function verifyOAuthState(token, secret, now = Date.now()) {
  const value = verify(token, secret);
  return Boolean(value && typeof value.nonce === 'string'
    && typeof value.expiresAt === 'number' && value.expiresAt >= now);
}

/** @param {{ id: string, username: string }} user @param {string} secret @param {number} now */
export function createSession(user, secret, now = Date.now()) {
  return sign({ expiresAt: now + 8 * 60 * 60_000, id: user.id, username: user.username }, secret);
}

/** @param {string | undefined} token @param {string} secret @param {number} now */
export function readSession(token, secret, now = Date.now()) {
  if (!token) return undefined;
  const value = verify(token, secret);
  if (!value || typeof value.id !== 'string' || typeof value.username !== 'string'
    || typeof value.expiresAt !== 'number' || value.expiresAt < now) return undefined;
  return Object.freeze({ id: value.id, username: value.username });
}

/** @param {string | undefined} header @param {string} name */
export function readCookie(header, name) {
  if (!header) return undefined;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator > 0 && entry.slice(0, separator).trim() === name) {
      return entry.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** @param {string} name @param {string} value @param {number} maxAge */
export function secureCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** @param {Record<string, unknown>} value @param {string} secret */
function sign(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** @param {string} token @param {string} secret */
function verify(token, secret) {
  const separator = token.lastIndexOf('.');
  if (separator < 1) return undefined;
  const payload = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try {
    const value = /** @type {unknown} */ (JSON.parse(Buffer.from(payload, 'base64url').toString()));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}