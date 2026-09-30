# Read-only Discord integration test

Set `RENOBOT_LIVE_DISCORD=1` and run `npm run discord:test` with the configured
`DISCORD_TOKEN` and `DISCORD_GUILD_ID`. Without explicit opt-in the test skips.

The test only sends GET requests, opens no gateway connection, and changes no
roles, accounts, messages, or production database data. It verifies complete
1000-member pagination, names, and role arrays. Output contains aggregate counts
or HTTP/Discord error codes, not tokens, member identities, or response bodies.

This is a live API contract test, not a replacement for repository and HTTP-route
tests. Discord's bulk listing requires Server Members privileged access enabled
on the application, independently of gateway intents requested by the bot.