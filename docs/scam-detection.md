# Scam detection and moderator review

Use the shared [User → Content → Source security-alert pattern](security-alerts.md).
Ban status belongs to the user; deletion status belongs to the source message.

Monitor new messages only in the configured guild; never scan channel history.
Set `DISCORD_SECURITY_CHANNEL_ID` to the alert destination channel ID.
Unset or blank disables detection. There are no hardcoded guild/channel defaults.
Detection requires `DISCORD_MESSAGE_CONTENT_INTENT=true` and the privileged intent
enabled in Discord, plus View Channel, Send Messages, Embed Links, and Attach Files
in the destination. The bot also needs Read Message History in source channels
to forward originals. Ban Members enables accurate ban lookups and manual bans;
Manage Messages is required in each source channel for manual deletion.
View Audit Log enables automatic ban attribution; current ban reasons are shown
even when audit access is unavailable. Attribution uses a bounded lookup of the
latest 100 guild audit entries and is omitted when no matching ban is available.

Use one local Tesseract.js English worker, bounded downloads (8 MiB), decoded
images (8 million pixels), four images per message, and a 20-message queue.
Reuse OCR results by SHA-256 (500 entries); recycle the worker after 100 images.
Each recognition has a 20-second deadline. Resize to at most 1600 pixels per side.
The English model is downloaded on first use into the OS temporary cache; the
container needs outbound access to the Tesseract model host. No image is uploaded
to an OCR/model provider; detected image evidence is copied to the security channel.
An OCR engine error/deadline invalidates the worker and applies a 30-second retry
cooldown. OCR runs in an owned child process: deadlines and shutdown terminate
the process even if Tesseract model initialization never settles.
Recognition resumes on a subsequent candidate.
Ordinary image decoding/download failures do not invalidate the worker.
Tesseract callback errors are handled through rejected job promises, not throws.
If the first OCR result has no qualifying hook or known domain, inspection stops
at `ocr:no-hook` without downloading supporting images (including in audit scans).

Known domains (`wormwin.com`, `meviwin.com`, `basoowin.com`) alert immediately.
The compressed hook/receipt variant requires a domain, claim instructions, promo
code and immediate bonus-withdrawal promise in one image, plus withdrawal-success,
received-payment text and a dollar amount in another. Bounded observed OCR variants
are accepted; whitespace around domain dots is normalized without substituting
domain letters. The saved two-image sample passes without adding its hostname to
the known-domain list; the regression was demonstrated failing before the fix.
Otherwise require a domain-bearing casino/giveaway pitch and a separate image
showing bonus activation or successful withdrawal. Do not guess OCR corrections.
Record rule names, image positions, domains and hashes, not scam probabilities.
Ignore bots, webhooks, foreign guilds and the destination channel. Include direct
and forwarded-image attachments. Alerts disable mentions and omit OCR-derived URLs.

Alerts prefer a native forward followed by a slim Components V2 card: event,
user/ban status, message link/deletion state, and controls. Forwarding failure
falls back to uploading the already-downloaded image inside the card. Known
deleted sources skip forwarding. Successful forwards do not duplicate image
uploads. Detailed domains, rules, and full SHA-256 hashes remain in logs.

Delete message and Ban require a moderator's actor-bound, single-use confirmation
within 60 seconds. Permissions are freshly checked at both steps; bans also check
both moderator and bot role hierarchy. Ban does not bulk-delete message history.
There is no timeout control. GuildModeration events update the latest 200 alerts
when another bot (such as Honeypot) bans or unbans someone, changing buttons only.
Single and bulk message deletion events disable Delete message,
including uncached messages. There is no refresh button or periodic polling.
Updates are serialized per alert so concurrent ban/deletion events preserve both
control states. Report text, recorded attribution, evidence, and source links stay
immutable after posting. Bounded event tracking covers deletion during OCR or alert delivery.
Tracking is in memory: alerts from before a restart or beyond the latest 200 do
not receive automatic edits. Moderation actions still recheck current state.
Already-banned users have a disabled Ban button.
Missing ban permissions are displayed as unknown, never treated as not banned.
Deleting an already-deleted message or confirming an already-completed ban is safe.
Pending confirmations expire on restart. Old plain-text alerts gain no controls.

No automatic deletion, timeout, ban, historical scan, automatic domain-list
expansion, or LLM call. Domain lists are code-reviewed. Jokes can match: moderators decide.
Exact hashes cache recognition, not identity across recompression. Perceptual
hashing and independent cross-channel repetition detection are deferred.

Tests cover known domains, rotated-domain bundles, benign/joke-like text without
destinations, spoofed suffixes, SSRF/download limits, queue and intake exclusions.
Run `npm run check` before deployment. Existing samples remain outside Git.

## Local verification

## Streaming campaign gate

Live intake now requires empty text, two or four attachments, and a portrait
first image when dimensions are supplied. This is campaign-specific coverage.
The downloader parses at most 64 KiB of prefix with image-size, then cancels
landscape hooks, unsupported detected formats, or images above 8 million pixels.
Supporting images need not be portrait. Inconclusive headers continue under the
8 MiB download limit, never counted as clean. JPEG orientation overrides prevent
raw landscape header dimensions from excluding rotated images. Chunk delivery
can exceed the minimum header bytes before cancellation.

`scripts/scan-scam-images.js` is an operator-only, bounded 500-result indexed
search (not channel history). It writes an audit JSONL in the Git-ignored
`.private/scam-scans/<timestamp>/` directory with every message's metadata exclusion or inspection result, including
header events, bytes consumed, matched signals, and explicit errors.
Full OCR text is retained only with `--retain-ocr`. Audits use a private repository
directory and owner-only file modes on POSIX; Windows inherits the parent ACL.
Audits are retained until the operator removes them; do not retain full OCR unless
needed for investigation, and remove the audit directory afterwards.
It never sends alerts. The live detector still does not run historical searches.

Production preprocessing/OCR recognized the known domain in image 1 of all three
preserved bundles. Replacing known hostnames in OCR text with an unfamiliar host
also matched the bundle rule: image 2 supplied support for Kai Cenat/meviwin and
MrBeast/basoowin; the noisier original MrBeast/wormwin needed image 3.
No alerts were sent to Discord during validation. No bot process was restarted.

## Leak remediation plan

- Own OCR in a child process before model loading and kill it on deadline/close.
- Default scan audits to signals only; require explicit full-text retention.
- Validate lifecycle regressions, lint, types and tests before staging; no commit.
- Exit the OCR child on parent IPC disconnection, even with stuck model loading.
- Exclude indexed-search context (`hit: false`) before deduplication/inspection.
- Demonstrate both regressions fail before the fixes and pass unchanged afterwards.