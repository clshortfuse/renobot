import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChatCompletionClient } from '../src/reviews/model-client.js';

describe('OpenAI-compatible model client', () => {
  it('posts a chat completion to the configured endpoint', async () => {
    /** @type {{ init?: RequestInit, url?: string }} */
    const captured = {};
    /** @type {typeof fetch} */
    const request = async (input, init) => {
      if (!init) {
        throw new Error('Expected request options.');
      }

      captured.url = String(input);
      captured.init = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '  compact summary  ' } }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
    const client = createChatCompletionClient(
      {
        apiKey: 'secret',
        baseUrl: 'http://localhost:1234/v1',
        model: 'test-model',
        temperature: 0.2,
        timeoutMs: 5_000,
      },
      request,
    );

    const result = await client.complete('system rules', 'conversation data');
    const headers = new Headers(captured.init?.headers);
    const body = JSON.parse(String(captured.init?.body));

    assert.equal(result, 'compact summary');
    assert.equal(captured.url, 'http://localhost:1234/v1/chat/completions');
    assert.equal(headers.get('authorization'), 'Bearer secret');
    assert.equal(body.model, 'test-model');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'conversation data' },
    ]);
    assert.equal(body.temperature, 0.2);
  });

  it('rejects malformed successful responses', async () => {
    /** @type {typeof fetch} */
    const request = async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = createChatCompletionClient(
      {
        baseUrl: 'http://localhost/v1/',
        model: 'test-model',
        temperature: 0,
        timeoutMs: 5_000,
      },
      request,
    );

    await assert.rejects(
      () => client.complete('system', 'user'),
      /empty chat completion/u,
    );
  });
});