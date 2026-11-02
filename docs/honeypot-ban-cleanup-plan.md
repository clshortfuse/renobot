# Confirmed Honeypot ban cleanup

- Use an explicitly configured `DISCORD_HONEYPOT_BOT_ID` and enforce mode in production; retain legacy channel correlation for existing installations.
- Confirm the current ban against a recent audit-log entry from that bot with the Honeypot trigger reason. Handle both ban and audit-log event arrival orders.
- Retain all observed messages for the existing 60-second window, bounded to 200, and schedule each eligible pre-ban source through the existing alert, reaction, 15-second timer, and cancellation flow.
- Recheck ban, source identity, permissions, and exemptions at execution. Unbans cancel pending cleanup. No historical sweep or automatic deletion of this incident's old messages.
- Test attribution, multiple messages, recency, duplicate events, cancellation, dry-run, and unban behavior. Run `npm run check` and stage only task changes.
- Deploy an isolated patch on the current production image, not the dirty workspace. Back up production configuration, enable the trusted Honeypot bot and enforce mode, recreate only Renobot, and verify health/settings. Keep the original image for rollback.

## Deployment result — 2026-11-02

Latest review correction: retain initial ban-event snapshots across missing audit
attribution, with a fixed 60-second deadline, a 200-author cap, and immediate
unban invalidation. Regression tests cover delayed visibility after cache expiry,
non-refreshing retention, and unban during attribution lookup.

### Current v3 deployment — 17:07 UTC

Production runs `renobot:honeypot-ban-20261102-v3`. Only the controller changed
from v2. Full checks passed (337 passed, 3 skipped); all 33 focused tests passed
inside the image. Production is healthy with zero restarts, Discord readiness
confirmed, and a matching tested/deployed controller hash. Enforce mode remains
enabled. The v2 image is retained for rollback; its configuration is saved at
`/opt/renobot/.deploy.env.before-honeypot-20261102-v3`.

### v2 deployment — 16:38 UTC

Review follow-up: prevent ordinary traffic from consuming the action queue and
retain ban-event candidates through queue/Discord latency. Regression tests for
queue overflow and both lookup/source delays failed before the fix and passed
unchanged afterward. A long-source-delay case also covers trigger expiration.

The corrected image `renobot:honeypot-ban-20261102-v2` replaced v1 at 16:38 UTC.
Only the controller changed. Full checks passed (334 passed, 3 skipped); all 30
focused tests passed inside the new image. Production was healthy with zero
restarts, Discord readiness confirmed, and the controller hash matches the tested
file. Enforce mode remains enabled. The v1 image is retained, with its deployment
configuration saved as `/opt/renobot/.deploy.env.before-honeypot-20261102-v2`.

### Original v1 deployment — 14:23 UTC

- Production initially ran `renobot:honeypot-ban-20261102`, derived from the previous
	GHCR image `sha256:caeb0ec826222300ec94f4d2e4d8a02817abf2cd75aadd0639b176a8c73426d7`.
	Only `src/bot.js` ban-event routing and `src/security-autodelete.js` changed
	in that image; unrelated workspace work was not deployed.
- Runtime settings: `DISCORD_HONEYPOT_BOT_ID=1450060292716494940` and
	`SECURITY_AUTODELETE_MODE=enforce`. Verified the executor is the Honeypot bot,
	the incident audit reason matches, Ban Members/View Audit Log/Manage Messages
	are available at guild level, and the `banme` emoji exists. Source-specific
	permissions are still checked for each deletion.
- Full workspace check: 330 passed, 3 skipped. All 26 focused tests also passed
	inside the isolated production image. Container healthy, zero restarts,
	and `Renobot is ready` confirmed after activation at 14:23 UTC.
- Configuration backups: `/etc/renobot/renobot.env.before-honeypot-20261102`
	and `/opt/renobot/.deploy.env.before-honeypot-20261102`. Hotfix build artifacts
	are under `/opt/renobot/hotfix-honeypot-20261102`. No database migration or
	historical message deletion was performed.
- Source changes are staged, not committed/pushed. Include this fix in the next
	normal release; deploying an older revision would overwrite the hotfix code.
	The production environment settings persist across normal deployments.