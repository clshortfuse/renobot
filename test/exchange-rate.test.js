import assert from 'node:assert/strict';
import { it } from 'node:test';
import { historicalExchangeRate } from '../src/exchange-rate.js';

it('requests the payment-date rate without sending payment identities or amounts', async () => {
  const request = /** @type {typeof fetch} */ (async (url) => {
    assert.equal(String(url), 'https://api.frankfurter.dev/v2/rate/EUR/USD?date=2026-09-01');
    return Response.json({ rate: 1.2, date: '2026-09-01' });
  });
  assert.deepEqual(await historicalExchangeRate('EUR', 'USD', new Date('2026-09-01'), request),
    { rate: '1.2', date: '2026-09-01' });
});

it('does not request a rate for matching currencies and refuses unavailable rates', async () => {
  const request = /** @type {typeof fetch} */ (async () => new Response('', { status: 404 }));
  assert.deepEqual(await historicalExchangeRate('USD', 'USD', new Date('2026-09-01'), request),
    { rate: '1', date: '2026-09-01' });
  await assert.rejects(historicalExchangeRate('EUR', 'USD', new Date('2026-09-01'), request));
});