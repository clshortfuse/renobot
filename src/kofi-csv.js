import { parse } from 'csv-parse/sync';
import { normalizeEmail } from './account-email.js';

/** @typedef {{transactionId: string, amount: string, currency: string, occurredAt: Date, eventType: string, subscriptionPayment: boolean, supporterEmail: string | null}} CsvPayment */

/** @param {string} text @returns {CsvPayment[]} */
export function parseKofiCsv(text) {
  const required = ['DateTime (UTC)', 'Received', 'Given', 'Currency', 'TransactionType', 'TransactionId', 'BuyerEmail'];
  /** @type {Record<string, string>[]} */
  const rows = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 256 * 1024,
    columns: (/** @type {string[]} */ headers) => {
      if (new Set(headers).size !== headers.length || required.some((name) => !headers.includes(name))) {
        throw new Error('Use the original Ko-fi transaction CSV export.');
      }
      return headers;
    } });
  if (!rows.length || rows.length > 500) throw new Error('Import between 1 and 500 transactions at a time.');
  const ids = new Set();
  return rows.map((row) => {
    const transactionId = row.TransactionId?.trim() ?? '';
    const amount = row.Received?.trim() ?? '';
    const currency = row.Currency?.trim().toUpperCase() ?? '';
    const parts = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/u.exec(row['DateTime (UTC)'] ?? '');
    const occurredAt = parts ? new Date(`${parts[3]}-${parts[1]}-${parts[2]}T${parts[4]}:${parts[5]}:00Z`) : new Date(NaN);
    const expected = parts ? `${parts[3]}-${parts[1]}-${parts[2]}T${parts[4]}:${parts[5]}:00.000Z` : '';
    const subscriptionPayment = row.TransactionType === 'Monthly Tip';
    const supporterEmail = row.BuyerEmail?.trim() ? normalizeEmail(row.BuyerEmail) : null;
    if (!/^[A-Za-z0-9-]{1,255}$/u.test(transactionId) || ids.has(transactionId)
      || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(amount) || Number(amount) <= 0
      || !/^[A-Z]{3}$/u.test(currency) || Number(row.Given) !== 0
      || !['Tip', 'Monthly Tip'].includes(row.TransactionType ?? '')
      || Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== expected
      || occurredAt.getTime() > Date.now() + 5 * 60_000 || row.BuyerEmail?.trim() && !supporterEmail) {
      throw new Error('Invalid, duplicate, or unsupported transaction in CSV. Only received tips and monthly tips are supported.');
    }
    ids.add(transactionId);
    return { transactionId, amount, currency, occurredAt, subscriptionPayment, supporterEmail,
      eventType: subscriptionPayment ? 'Subscription' : 'Donation' };
  });
}