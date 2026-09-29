/**
 * Matching policy: trim and case-fold only. Never strip dots or plus tags, or
 * equate provider aliases. Invalid optional payment emails do not reject payments.
 * @param {string} email
 */
export function normalizeEmail(email) {
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : null;
}