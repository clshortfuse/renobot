# Unified security alerts and delayed deletion

Implementation plan: merge source alerts, share the exact-message deletion operation,
add a cancellable 15-second countdown and marker, test both signal orders, and
review staged changes for obsolete immediate-delete and warning-only paths.

## One alert per source

Honeypot activity is a spam/abuse signal, not a scam classification. The shared
automatic-action controller is `security-autodelete.js`; `scam-detection.js`
remains responsible for scam-specific detection.

Scam detection and honeypot correlation add distinct reasons to the same recent source
alert. Original report evidence and ban attribution remain unchanged; reason and
automatic-action status sections can change. Alert creation is serialized per
source. No alert means no automatic deletion. Evidence is forwarded to Discord
where available, with cached-image fallback for detected spam. No local archive.
If an existing alert lacks an image, later detected-spam evidence can fill that
gap on the same card. Upload failure is logged but does not reject the merged
reason. A source already deleted at timer execution is successful cleanup:
mark the alert deleted without a cancellation or manual-review failure warning.

## Eligibility and countdown

Within 60 seconds, in either arrival order, a configured honeypot post can
correlate with either the same author's recent outside-channel message or a
detected-spam candidate. Detection uses original intake time before OCR.
Neither spam alone nor a honeypot post alone authorizes deletion.

In enforce mode the alert receives a pending status and Cancel deletion / Suspend
auto-delete controls. The bot adds the guild's `banme` emoji to the original
message, if available, then starts a 15-second timer. Missing emoji or reaction
permission is logged and does not bypass the countdown. Dry-run only annotates
the alert; it does not add reactions or start destructive timers.

Cancel requires fresh source View Channel, Read Message History, Manage Messages
permissions for the moderator and bot. Suspend additionally requires the
moderator's Manage Server permission. Suspension cancels all pending deletions
until restart. Cancellation removes only the bot's reaction. Cancellation cannot
undo a deletion request already submitted to Discord.

Execution re-fetches the source, verifies author, guild, exemptions, bot
permissions, and availability of the alert. It calls `deleteAlertSource`, the same
operation used by confirmed manual Delete actions. Results update that alert,
not a separate deletion report. The 60-second window establishes eligibility;
aging past it during the 15-second countdown does not invalidate that decision.

## Configuration and limits

- `DISCORD_HONEYPOT_CHANNEL_ID`: explicit opt-in; must differ from security.
- `SECURITY_AUTODELETE_MODE`: `dry-run` by default; `enforce` starts timers.
- `SECURITY_AUTODELETE_EXEMPT_USER_IDS`, `SECURITY_AUTODELETE_EXEMPT_ROLE_IDS`: comma-separated IDs.
- `SECURITY_AUTODELETE_USER_LIMIT`: default 10 scheduled actions per ten minutes.
- `SECURITY_AUTODELETE_GUILD_LIMIT`: default 30 scheduled actions per ten minutes.

Owner, bots, webhooks, and foreign guilds are excluded. Departed/banned users
have no current exempt roles. Reports must stay in the configured guild.
Recent alerts and activity are bounded to 200 entries; correlation expires after
60 seconds. Activity tracks the latest outside-channel message per author.
Pending and terminal scheduled-action records are bounded to 200 per session;
reaching capacity pauses scheduling rather than forgetting cancellation history.
Queue/cap overflow fails closed. Shutdown cancels timers, cleans reactions best
effort, and drains work. Pending actions are not recovered after restart.

Run `npm run check`. No production configuration or deployment is implied.