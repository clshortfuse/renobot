import { sharedModelQueue } from './model-queue.js';

/**
 * @param {Readonly<{
 *   apiKey?: string | undefined,
 *   baseUrl: string,
 *   model: string,
 *   protocol?: 'chat-completions' | 'responses',
 *   maxOutputTokens?: number,
 *   onQueued?: (position: number, waiting: number) => Promise<void>,
 *   onStarted?: () => Promise<void>,
 *   temperature: number,
 *   timeoutMs: number,
 * }>} config
 * @param {typeof fetch} [request]
 * @returns {import('./review.js').ChatCompletionClient}
 */
export function createChatCompletionClient(config, request = fetch) {
  const baseUrl = config.baseUrl.endsWith('/')
    ? config.baseUrl
    : `${config.baseUrl}/`;
  const responses = config.protocol === 'responses';
  const endpoint = new URL(responses ? 'responses' : 'chat/completions', baseUrl);

  return Object.freeze({
    async complete(systemPrompt, userPrompt) {
      return sharedModelQueue.run(async () => {
      await config.onStarted?.().catch(() => {});
      /** @type {Record<string, string>} */
      const headers = {
        'content-type': 'application/json',
      };

      if (config.apiKey) {
        headers.authorization = `Bearer ${config.apiKey}`;
      }

      const response = await request(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          stream: false,
          ...(responses ? {
            instructions: systemPrompt,
            input: userPrompt,
            store: false,
            max_output_tokens: config.maxOutputTokens ?? 4096,
          } : { messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ], max_tokens: config.maxOutputTokens ?? 4096 }),
          temperature: config.temperature,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Model request failed with HTTP ${response.status}.`);
      }

      const payload = /** @type {unknown} */ (await response.json());
      const content = responses ? getResponseContent(payload) : getCompletionContent(payload);

      if (!content) {
        throw new Error('The model returned an empty chat completion.');
      }

      return content;
      }, config.onQueued);
    },
  });
}

/**
 * @param {unknown} payload
 * @returns {string | undefined}
 */
function getCompletionContent(payload) {
  if (!isRecord(payload)) {
    return undefined;
  }

  const choices = payload.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }

  const choice = choices[0];

  if (!isRecord(choice)) {
    return undefined;
  }

  const message = choice.message;

  if (!isRecord(message)) {
    return undefined;
  }

  const content = message.content;
  return typeof content === 'string' ? content.trim() : undefined;
}

/** @param {unknown} payload */
function getResponseContent(payload) {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.status === 'string' && payload.status !== 'completed') {
    throw new Error('The model response did not complete.');
  }
  if (!Array.isArray(payload.output)) return undefined;
  const text = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'message' || item.role !== 'assistant'
      || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
        text.push(part.text);
      }
    }
  }
  return text.join('\n').trim();
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}