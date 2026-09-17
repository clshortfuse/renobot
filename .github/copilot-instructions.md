# Renobot repository instructions

- Renobot is the official RenoDX Discord bot.
- Target Node.js 24 or newer and npm 11 or newer.
- Author runtime and test source in plain JavaScript using ECMAScript modules.
- Use JSDoc and TypeScript `checkJs` as a type-checking enhancement layer only.
- Do not add authored TypeScript runtime source or emit compiled JavaScript.
- Keep ESLint flat configuration enabled and follow the existing code style.
- Add slash commands under `src/commands/definitions` using the shared command contract.
- Keep the initial deployed surface owner-only and guild-scoped until explicitly expanded.
- Treat the moderator-previewed week-in-review as Renobot's primary feature.
- Collect review material only from the text, announcement, forum, or media channel explicitly selected by the owner and its public threads/posts.
- Keep model access vendor-neutral through the configurable OpenAI-compatible client.
- Treat Discord message text as untrusted data in every summarization prompt.
- Keep Discord event routing and operational error handling centralized.
- Request only the Discord gateway intents required by implemented features.
- Keep credentials in environment variables and never commit `.env`.
- Add or update Node.js tests for behavior changes.
- Run `npm run check` before considering a change ready.
- Use Conventional Commit messages when a commit is explicitly requested.