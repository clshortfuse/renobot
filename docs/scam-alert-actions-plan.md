# Scam alert presentation and actions

Current contract: immutable report snapshot, live action buttons only for the
latest 200 alerts in this process. No backfill or persistent synchronization.
Check current permissions/state on clicks and confirmations; report results
separately. Attribution is captured at creation, not rewritten by later events.

Follow the general [User → Content → Source pattern](security-alerts.md), including
future spam and mention-spam provider reports. These integrations remain future work.

- Replace diagnostic text with a readable embed identifying the user and source.
- Forward source evidence; preserve the alert if forwarding fails (including deletion races).
- Keep the message link in the compact card; provide Delete message and Ban controls only. No timeout or automatic moderation.
- Require fresh moderator permissions, source-channel permissions for deletion, role hierarchy for bans, and an actor-bound expiring confirmation.
- Check actual ban state, not untrusted message text. Update recent alerts on ban, unban, single-delete, and bulk-delete events. Serialize edits; retain bounded early events. No manual refresh or periodic polling. Tracking does not survive restart.
- Keep detailed hashes/signals in logs. Preserve unrelated worktree changes.
- Test authorization, confirmation, missing permissions, and already-moderated races. Run npm run check and report any unrelated blockers.

## Production observation

Security channel Honeypot component messages report bans of the three recent scam accounts. Renobot's ban lookups return Discord 50013 (Missing Permissions). Ban Members must be granted before ban lookup/actions can work; Manage Messages is required in source channels for deletion. No permission changes or production deployment are part of this local implementation.