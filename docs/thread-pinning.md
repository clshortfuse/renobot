# Creator-authorized message pinning

## Plan

- Allow `/pin message:<message-link>` in the configured guild when the requester
  has effective Pin Messages permission in the invoking channel (including
  channel overrides), or created the invoking public thread/forum post.
- Server ownership alone is not a special bypass; effective permissions apply.
- Keep every other command owner-only. Exclude DMs. Private threads require
  effective Pin Messages permission; their creators get no exception.
- Require Renobot's View Channel, Read Message History, and Pin Messages
  permissions. Reject archived/locked threads rather than reopening them.
- Pin only an explicitly linked message in the invoking thread. Do not fetch
  history or request Message Content. Reply ephemerally. Regular server message
  channels are also supported for users with effective Pin Messages permission.
- Test authorization, scope, permissions, invalid links, and operational errors;
  run `npm run check` and register guild commands.
- Existing runtime must be restarted separately before using the new command.

## Checkpoint (2026-09-05)

- Expanded authorization to effective channel Pin Messages permission holders.
- Updated validation: `npm run check` passed all 57 tests, lint, and checkJs.
- This latest change still requires a runtime restart; no restart performed.
- The revised command description requires command re-registration.

- Implemented and guild-registered `/pin message:<message-link>`.
- `npm run check` passed: lint, checkJs, and all 54 tests.
- Editor diagnostics passed. No live message was pinned during validation.
- The existing local bot has not been restarted with this implementation.
- Renobot still needs Pin Messages permission on the intended parent channels.