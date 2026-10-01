/**
 * Matching policy: trim and case-fold only. Never strip dots or plus tags, or
 * equate provider aliases. Invalid optional payment emails do not reject payments.
 * Accept plain ASCII dot-atom mailboxes only, not display names, comments,
 * address lists, quoted local parts, or SMTPUTF8 addresses.
 * @param {string} email
 */
export function normalizeEmail(email) {
  const normalized = email.trim().toLowerCase();
  const [local, domain, extra] = normalized.split('@');
  if (!local || !domain || extra !== undefined || normalized.length > 254 || local.length > 64) return null;
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u.test(local)
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)
    ? normalized : null;
}