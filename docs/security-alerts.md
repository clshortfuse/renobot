# Security alert presentation

## Snapshot and live controls

The posted report is a historical snapshot. Never rewrite its text, attribution,
reason, evidence, or source URL after posting. A deletion known at creation may
be recorded in that snapshot; later deletions only disable the Delete button.
Only action controls on the latest 200 alerts tracked in this process respond
to ban/unban/delete events. No historical backfill, polling, or persistent sync.
Clicks on older enabled controls still recheck current state and permissions;
action results are reported separately to the moderator.

All security alerts use the same information order: **Event → User → Content → Source**.
This is a shared pattern, not an image-scam-specific format.

Render one compact Components V2 container: concise event/detection heading,
user mention and status on one line, evidence, direct message URL, then controls.
Append ` (deleted)` to the URL when deletion is confirmed. Keep action labels
`Delete message` and `Ban user`, disabling completed actions without renaming them.
These are ordered items, not labeled sections. If evidence is missing, say "Image unavailable".
No duplicate username/ID, stacked embeds, "Source"
heading, or "Open message" label. Keep status wording short.

Prefer a native forward followed by a slim card with event, user/status, message
link/deletion state, and actions. Do not duplicate the image or show an unavailable
placeholder after a successful forward. If the source is already deleted, skip
forwarding and use the cached OCR image inside the card. Other forwarding failures
also fall back to the cached image, but only confirmed deletion marks the source
`(deleted)`. No second image download is needed. The serial detector queue keeps
Renobot's forward/card pairs ordered; other bots may still post between them.

## User

- Show the identity once.
- Keep user-level state here: banned, not banned, or status unknown.
- For banned users, show `Banned by @executor` when the latest matching ban/unban
	entry among the latest 100 guild audit entries is a ban matching the current
	ban reason. Show the current ban reason beneath it, escaped and without pings.
	Audit lookup requires View Audit Log. Missing permission, missing entries, or
	lookup failure leaves the executor omitted; it must not block the alert.
	Ban metadata is captured only when creating the report.
	Audit entries that arrive later are not polled, so attribution can be absent
	in the snapshot. Later unbans change controls, not the recorded attribution.
	After observing an unbanned state, only audit entries newer than that observation
	can supply attribution. This uses one timestamp in existing bounded state, not a
	separate log. Ambiguous timing omits the executor rather than naming an old one.
- Associate user-level actions (such as Ban) with this subject.

## Content

- Show the relevant evidence: message text, images, attachments, or a forwarded snapshot.
- Accommodate image scams, spam, mention spam, and other future security events.
- Keep the detection reason concise. Raw OCR, hashes, and diagnostic signals belong in logs.
- Treat evidence as untrusted; do not ping users or automatically follow links or instructions.

## Source

- Link the original message and identify its channel without redundant navigation controls.
- Keep message-level state here, including deletion or unavailable evidence.
- Associate message-level actions (such as Delete message) with this subject.
- Distinguish the reporting detector/provider from the original message author.

## Status and actions

- Preserve the distinction between a provider's report and verified current Discord state.
- Unknown status must not be presented as not banned or not deleted.
- Keep moderator actions explicit, permission-checked, and confirmed; no automatic moderation is implied by this layout.

## Future integrations

The security channel can also receive spam, mention-spam, and other reports from
Carl-bot or other providers. Adapt those events to this same pattern rather than
introducing a separate layout for each detector. Carl-bot ingestion, provider
authentication, event correlation/deduplication, and any new detection rules are
future work, not implemented by this document. Do not treat arbitrary messages
claiming to be provider reports as trusted moderation events.