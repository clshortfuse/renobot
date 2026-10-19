# Alert-only scam detection

Monitor new messages only in the configured guild; never scan channel history.
Set `DISCORD_SECURITY_CHANNEL_ID` to the alert destination channel ID.
Unset or blank disables detection. There are no hardcoded guild/channel defaults.
Detection requires `DISCORD_MESSAGE_CONTENT_INTENT=true` and the privileged intent
enabled in Discord, plus View Channel and Send Messages in the destination.

Use one local Tesseract.js English worker, bounded downloads (8 MiB), decoded
images (8 million pixels), four images per message, and a 20-message queue.
Reuse OCR results by SHA-256 (500 entries); recycle the worker after 100 images.
Each recognition has a 20-second deadline. Resize to at most 1600 pixels per side.
The English model is downloaded on first use into the OS temporary cache; the
container needs outbound access to the Tesseract model host. No image is uploaded.
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
and forwarded-image attachments. Alerts disable mentions and link unfurling.

No deletion, timeout, ban, historical scan, automatic domain-list expansion, or
LLM call. Domain lists are code-reviewed. Jokes can match: moderators decide.
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
search (not channel history). It writes an audit JSONL in the OS temporary
directory with every message's metadata exclusion or inspection result, including
header events, bytes consumed, matched signals, and explicit errors.
Full OCR text is retained only with `--retain-ocr`. Audits use a private temporary
directory and owner-only file modes on POSIX; Windows inherits the temp ACL.
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