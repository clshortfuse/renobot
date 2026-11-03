# Report Rule Violation

The message action now covers all nine rules. Open **Apps → Report Rule Violation** and select one rule from the private dropdown:

1. Rule 1 (Respect Others)
2. Rule 2 (Spam / Self-Promotion)
3. Rule 3 (Obscene Content)
4. Rule 4 (Piracy)
5. Rule 5 (Misleading Info)
6. Rule 6 (Low-Effort Trolling)
7. Rule 7 (Unnecessary Pings)
8. Rule 8 (Read Pins)
9. Rule 9 (Unapproved Payloads)

Every rule uses **delete + 24-hour timeout**, with the selected label as the audit reason. Members send reports to security; moderators act immediately after selecting. The card includes the initial rule's full text. Existing longer timeouts are retained. All rules share the same burst protection and source-message card.
Dropdowns belong to the requesting user, expire after five minutes (or a bot restart), and can be used only once. Opening a new dropdown invalidates that user's previous one.

## Review fixes
- Fetch source/security channels before checking permissions; use the fetched objects rather than assuming IDs are cached.
- Reject bot-account reporters. Allow five reports in an immediate burst per member, replenishing one report every two seconds, with no daily quota. Moderators are exempt from burst limits. This throttles automated bursts, not proof of humanity.
- Reserve burst capacity before posting/updating a card, including concurrent requests. Keep limiter state bounded and process-local; duplicate reporter/rule pairs do not consume capacity.
- Verify regression tests fail before the fixes, then pass unchanged afterward.

## Usage and deployment
Production deployment registers guild application commands automatically after the new app becomes healthy and before publishing its static files. A registration failure fails deployment and, when a previous image exists, rolls back the app and registers that image's commands again. Registration uses the running image's command definitions and production credentials; no extra bot login is started. Older images do not contain the registration CLI script, so deployment invokes their shared configuration and command-loader modules directly.
For local/manual registration, the existing `commands:register` npm script remains available.
Right-click a message, select **Apps → Report Rule Violation**, then choose the rule. There is no further confirmation dialog for moderators; other members receive a private report receipt.
The configured `DISCORD_SECURITY_CHANNEL_ID` must identify the security destination. The existing security subsystem also requires `DISCORD_MESSAGE_CONTENT_INTENT=true` and the corresponding Discord privileged intent approval/setting. Reports use the same Components V2 card style as security alerts, instead of a separate forwarded message. A card contains an escaped, length-limited message preview, the first image attachment when available, author, source link, reporters and moderation status, with mentions suppressed. The preview is not a complete archive of long messages or every attachment.
Additional reports update the same card live, listing each reporter once with their selected rule numbers. The first reported rule remains the approval reason; additional reports cannot silently change it. A moderator acting directly uses the rule they select, recorded in the status and audit reason. Concurrent submissions are serialized. Large reporter lists show as many identities as fit plus an overflow count to respect Discord's text limit.
Source messages are fetched inside the serialized operation, not before waiting. Completed moderation is tracked in the recent-card cache, including successful timeouts followed by failed deletion, preventing another queued moderator or fresh menu from repeating the punishment. A confirmed deleted security card is recreated on a subsequent report with its cached reporters and original approval rule; permission errors and temporary failures do not trigger replacement. Recreated cards for completed moderation have no approval button.
The security approval button persists across bot restarts. It is consumed before moderation without removing the evidence or reporters, and repeated clicks are rejected. Failed timeouts can be retried; failed deletions after a successful timeout require manual deletion to avoid extending the punishment. Attribution updates never restore consumed approval controls. Recent-card aggregation and reporter deduplication are process-local and retain the 1,000 most recently updated sources; after restart or eviction a new report creates a new card, while existing card approvals still work.
The bot needs View Channel, Manage Messages, and Moderate Members and a role above the target member.
The acting moderator must outrank the target (except the server owner). Bots, the acting moderator, and members the bot cannot moderate are rejected.
Discord message deletion has no audit-reason parameter; the selected rule label is attached to the timeout and recorded with actor/target/message IDs in the bot log. No message content is logged.