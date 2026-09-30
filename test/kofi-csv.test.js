import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseKofiCsv } from '../src/kofi-csv.js';

const header = 'DateTime (UTC),Received,Given,Currency,TransactionType,TransactionId,BuyerEmail,Message\n';
const row = '09/01/2026 15:51,5.00,0,usd,Tip,transaction-1, USER@example.test ,"hello\nworld"';
it('parses multiline Ko-fi exports without retaining messages', () => {
  const [payment] = parseKofiCsv(header + row);
  assert.equal(payment?.supporterEmail, 'user@example.test');
  assert.equal(payment?.currency, 'USD');
  assert.equal(payment?.occurredAt.toISOString(), '2026-09-01T15:51:00.000Z');
  assert.equal(payment && 'message' in payment, false);
});
it('rejects malformed headers, duplicate transactions, invalid dates and unsupported payments', () => {
  for (const text of [row, `${header}${row}\n${row}`,
    header + row.replace('09/01', '02/31'), header + row.replace(',Tip,', ',Shop Order,'),
    header + row.replace('USER@example.test', 'invalid')]) {
    assert.throws(() => parseKofiCsv(text));
  }
});