# Standalone LLM connection

## Plan and scope

- Reuse the existing model client with Locopi's localhost:1234 default server.
- Support explicit Chat Completions or Responses protocol selection.
- Keep inference independent of Discord commands, collection, and credentials.
- Validate with offline requests before testing an actual model.

`readModelConfig()` in `src/reviews/model-config.js` reads the `LLM_*`
settings documented in `.env.example`. Supply the model identifier served by
your endpoint. A root base URL is normalized to `/v1/`; custom API paths are
preserved. The default protocol is `chat-completions`; `responses` is optional.

Pass those settings to `createChatCompletionClient()` and call
`complete(systemPrompt, userPrompt)`. Requests are non-streaming and bounded
by a timeout and output-token budget. Responses requests set `store: false`;
this is not a guarantee about a provider's logging or retention policy.
Only assistant output text is returned, not separate reasoning fields.
HTTP errors omit provider response bodies to avoid leaking prompts or secrets.

No model server startup is performed. No changes are made to Locopi. A live inference test requires
a running endpoint and configured model; no automatic fallback to another
provider occurs.

## Summarize command

`/summarize text:<conversation>` or `/summarize file:<upload.jsonl>` accepts
exactly one input. JSONL records need a nonempty `content` string and may have
string `author` and `timestamp` fields. Uploads must be authorized for processing.
Limits: 100 KB, 1000 JSONL records, six admitted summaries per bot process.
No channel history is fetched. Message Content intent remains unnecessary.

The owner and `DISCORD_SUMMARIZE_ROLE_ID` members in the configured guild can
invoke it. Responses are ephemeral, with longer summaries attached as text.
Input is processed in memory, not written to disk. Discord still hosts uploaded
attachments; ephemeral output is not a guarantee of platform deletion.

Validation: all 69 tests, lint and checkJs passed. A local arithmetic smoke test
previously returned 4. Command registration and runtime loading are separate
steps; no user-running bot is automatically restarted.

## Shared inference queue

- All clients created by `createChatCompletionClient` share one process-local
	FIFO: one active request, up to five waiting requests.
- Waiting requests expire after five minutes and are removed without inference.
- The request timeout starts when inference starts, not during queue wait.
- Summary admission permits one queued/running request per user, with a
	30-second start-to-start cooldown. Admission happens before file downloads.
- Failed requests release their slot; no automatic retry floods the server.
- The queue is in-memory, not durable, and does not coordinate other bot
	processes or unrelated apps using the same LLM. A client-side timeout cannot
	guarantee that the inference server stopped computing the abandoned request.
- No runtime restart is performed as part of this implementation.