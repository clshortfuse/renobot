/**
 * Only currency codes and payment date are sent to the rate provider.
 * @param {string} source
 * @param {string} target
 * @param {Date} occurredAt
 * @param {typeof fetch} [request]
 */
export async function historicalExchangeRate(source, target, occurredAt, request = fetch) {
  const date = occurredAt.toISOString().slice(0, 10);
  if (source === target) return { rate: '1', date };
  const url = new URL(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(source)}/${encodeURIComponent(target)}`);
  url.searchParams.set('date', date);
  const response = await request(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Historical exchange rate unavailable');
  const result = await response.json();
  if (!Number.isFinite(Number(result.rate)) || Number(result.rate) <= 0
    || !/^\d{4}-\d{2}-\d{2}$/u.test(result.date) || result.date > date) {
    throw new Error('Invalid historical exchange rate');
  }
  return { rate: String(result.rate), date: String(result.date) };
}