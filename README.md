# Renobot

Renobot is the official RenoDX Discord bot. Commands are registered in one
configured server and are owner-only except for authorized `/pin` and
`/summarize` users. Week-in-review collection currently previews counts only;
the separate `/summarize` command sends explicitly supplied text or a JSONL
file to a configurable OpenAI-compatible model endpoint.

For a portable Docker Compose deployment with GHCR, Nginx, and the Discord
OAuth web application, see [Deployment](docs/deployment.md).

## Technology

- Node.js 24 with ECMAScript modules
- Plain JavaScript runtime and test source
- JSDoc and TypeScript `checkJs` type checking without build output
- Discord.js with centralized interaction routing
- Structured JSON logging with Pino
- ESLint flat configuration and the built-in Node.js test runner

## Discord setup

Create a Discord application and bot. On the **Bot** page:

- Disable **Public Bot**.
- Disable **Requires OAuth2 Code Grant**.
- Leave **Message Content Intent** disabled until Discord approves it for
	Renobot's week-in-review use case.

Discord does not permit a default authorization link for a private application.
On the **Installation** page, set **Install Link** to **None** and support only
**Guild Install**.

Install Renobot from **OAuth2 > URL Generator** while signed in as the application
owner:

1. Select the `bot` and `applications.commands` scopes.
2. Leave every bot permission unchecked initially.
3. Open the generated URL and add Renobot to RenoDX. The installing account must
	have **Manage Server** in RenoDX.

Interaction responses do not require **View Channels** or **Send Messages**.
Review collection requires the privileged `MessageContent` intent. Renobot
requests only `Guilds` by default, and command registration is always limited
to `DISCORD_GUILD_ID`. Set `DISCORD_MESSAGE_CONTENT_INTENT=true` only after
Discord approves and enables that intent for the application.

Before requesting Message Content, prepare App Verification, policy pages,
data-handling commitments, and evidence that matches the deployed behavior.

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token. |
| `DISCORD_CLIENT_ID` | Application ID used to register slash commands. |
| `DISCORD_GUILD_ID` | RenoDX server ID; commands are registered only here. |
| `DISCORD_OWNER_USER_ID` | User allowed to execute owner-only commands; also allowed to summarize. |
| `DISCORD_SUMMARIZE_ROLE_ID` | Optional role allowed to use `/summarize` in the configured server. |
| `DISCORD_MODDER_ROLE_ID` / `DISCORD_MODERATOR_ROLE_ID` | Optional guild roles; the modder role gates Ko-fi settings, while appeals remain unavailable. |
| `DISCORD_MESSAGE_CONTENT_INTENT` | Request approved Message Content access; defaults to `false`. |
| `REVIEW_INCLUDE_BOTS` | Include other bots' messages; defaults to `false`. Renobot's own messages are always excluded. |
| `REVIEW_LOOKBACK_DAYS` | Collection period from 1 through 30 days; defaults to `7`. |
| `REVIEW_MAX_MESSAGES` | Global collection limit from 1 through 10,000 messages; defaults to `2500`. |
| `LOG_LEVEL` | Pino log level; defaults to `info`. |
| `DISCORD_CLIENT_SECRET` | OAuth client secret; enables the website only when all web settings are present. |
| `PUBLIC_BASE_URL` | HTTPS website origin, such as `https://renobot.renodx.com/`. |
| `SESSION_SECRET` | At least 32 random bytes used to authenticate OAuth state and sessions. |
| `HTTP_HOST` / `HTTP_PORT` | Private HTTP listener; Compose uses `0.0.0.0:3000` inside the container. |
| `DATABASE_URL` | SQLite file for account persistence and modder Ko-fi settings (`file:/data/renobot.db` on the host volume); migrations must be applied before use. |
| `KOFI_ENCRYPTION_KEY` | Separate 32-byte base64 AES-GCM key for encrypted settings; never store it in the database. |
| `SUPPORTER_MINIMUM_AMOUNT` / `SUPPORTER_CURRENCY` | Owner-controlled minimum recurring amount and single supported currency; required with the encryption key to enable modder settings. |

Keep `.env` private. It is excluded from Git.

Optional model settings are documented in `.env.example` and
[LLM connection](docs/llm-connection.md). Leave `LLM_MODEL` empty to keep
summarization unconfigured; other commands do not require a model.

### Review collection setup

The owner selects one text, announcement, forum, or media source with Discord's
channel picker each time `/review-collect` runs. Renobot reads only that channel
and its active or archived public threads/posts. It never requests private
archived threads or reads unrelated channels.

To prepare channels for `/review-collect`:

1. Obtain Discord approval for **Message Content Intent**, then enable it on the
	application's **Bot** page.
2. Set `DISCORD_MESSAGE_CONTENT_INTENT=true` in the runtime environment.
3. Grant Renobot **View Channel** and **Read Message History** only in channels
	that the owner should be able to select.
4. Restart Renobot so it connects with the approved `MessageContent` intent.

The command reports only the period and collection counts in an ephemeral
response. Source text is not included in the response or operational logs, and
the preview does not invoke the dormant model integration. Until approval is
available, the command returns an explanatory ephemeral response without
attempting collection.

## Running Renobot

1. Install Node.js 24+ and npm 11+, then dependencies with `npm ci`.
2. Configure `.env`.
3. Register the current guild commands with `npm run commands:register`.
4. Start Renobot with `npm start`.

Run `/ping` in the configured server from the configured owner account. Other
users receive an ephemeral private-bot response for owner-only commands.
The `/pin` command authorizes effective Pin Messages permission holders or the
creator of the invoking public thread/post. `/summarize` also permits the
configured role in the configured server.

## Commands

| Command | Description |
| --- | --- |
| `/ping` | Confirm that Renobot can receive and answer a command. |
| `/pin message:<message-link>` | Pin in the same channel/post with effective Pin Messages permission, or as its public thread/post creator. |
| `/review-collect channel:#channel` | Ephemerally report bounded counts for the selected channel and its public threads/posts, without model access. |
| `/summarize text:<text>`, `/summarize file:<file>`, or `/summarize channel:<channel> count:<count>` | Owner or configured role: privately summarize one explicit source through the configured model. Channel history requires Message Content. |
| `/findmessages userid:<id> channel:#channel` | Owner-only: find message links in one channel/public post; optional scan limit, no deletion. |
| `/fixpng file:<png>` or `/fixpng message:<link>` | Owner-only: replace supported BT.2020/PQ PNG metadata with the reference ICC profile, preserving compressed pixels. |

## Development

### Creator-authorized pinning

In a public thread or forum/media post in the configured server, its creator
can copy a message link and run `/pin message:<link>` inside that same thread.
Users with effective **Pin Messages** permission can also use it in regular
server message channels and threads, including private threads. Private-thread
creators receive no special exception. Bot/server ownership alone is not a
bypass. Archived and locked threads are rejected; Renobot does not reopen them.

Grant Renobot **Pin Messages**, **View Channel**, and **Read Message History**
on the relevant parent channels. This does not grant users those permissions.
Message Content approval is not required: the bot pins the supplied message ID
without reading message text. Responses are ephemeral; the pin itself is shared.

| Script | Purpose |
| --- | --- |
| `npm start` | Start Renobot, loading `.env` when present. |
| `npm run dev` | Start in Node.js watch mode. |
| `npm run commands:register` | Replace Discord application commands. |
| `npm run lint` | Check JavaScript with ESLint. |
| `npm run typecheck` | Type-check JavaScript and JSDoc without emitting files. |
| `npm test` | Run the Node.js test suite. |
| `npm run check` | Run linting, type checking, and tests. |

Add slash-command modules under `src/commands/definitions`. Use the **Launch
Renobot** F5 configuration to run Renobot under the VS Code debugger.