/**
 * Read standalone inference settings; no Discord configuration is required.
 * @param {Record<string, string | undefined>} [env]
 */
export function readModelConfig(env = process.env) {
  const baseUrl = new URL(env.LLM_BASE_URL?.trim() || 'http://localhost:1234/v1/');
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('LLM_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  }
  if (baseUrl.search || baseUrl.hash) throw new Error('LLM_BASE_URL must not include a query or fragment.');
  if (baseUrl.pathname === '/') baseUrl.pathname = '/v1/';
  const protocol = env.LLM_PROTOCOL?.trim() || 'chat-completions';
  if (protocol !== 'chat-completions' && protocol !== 'responses') {
    throw new Error('LLM_PROTOCOL must be chat-completions or responses.');
  }
  const model = env.LLM_MODEL?.trim();
  if (!model) throw new Error('LLM_MODEL must identify a model served by the endpoint.');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 120000);
  const maxOutputTokens = Number(env.LLM_MAX_OUTPUT_TOKENS || 4096);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error('LLM_TIMEOUT_MS and LLM_MAX_OUTPUT_TOKENS must be positive integers.');
  }
  return Object.freeze({ baseUrl: baseUrl.href, protocol, model,
    apiKey: env.LLM_API_KEY?.trim() || undefined, temperature: 0.2,
    timeoutMs, maxOutputTokens });
}