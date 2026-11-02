# Report: Rule 8

## Plan
- Expose the guild-scoped **Report: Rule 8** message action to all members.
- Non-moderators submit a request to the configured security channel with an **Accept: delete + 24h timeout** button. Reporting alone never punishes the author.
- Moderators act immediately and send the result to security without requiring another approval.
- Require Manage Messages in the target channel and Moderate Members for either immediate action or acceptance, even for the configured bot owner. Approvers must also be able to view security and the source channel.
- Check moderator and bot role hierarchy before changing anything.
- Timeout the author for 24 hours with audit reason `Rule 8`, then delete only the selected message. Never shorten a longer timeout.
- Report failures privately; if timeout fails, do not delete. If deletion fails, explicitly report that the timeout succeeded.
- Add tests, run `npm run check`, and stage only task changes.

## Review fixes
- Fetch source/security channels before checking permissions; use the fetched objects rather than assuming IDs are cached.
- Reject bot-account reporters. Allow five reports in an immediate burst per member, replenishing one report every two seconds, with no daily quota. Moderators are exempt from burst limits. This throttles automated bursts, not proof of humanity.
- Reserve burst capacity before forwarding/posting, including concurrent requests. Keep limiter state bounded and process-local; duplicate reports do not consume capacity.
- Verify regression tests fail before the fixes, then pass unchanged afterward.

## Usage and deployment
Register application commands with the existing `commands:register` npm script and deploy/restart the updated bot through the normal deployment workflow.
Right-click a message, select **Apps → Report: Rule 8**. There is no confirmation dialog for moderators; other members receive a private report receipt.
The configured `DISCORD_SECURITY_CHANNEL_ID` must identify the security destination. The existing security subsystem also requires `DISCORD_MESSAGE_CONTENT_INTENT=true` and the corresponding Discord privileged intent approval/setting. Evidence is forwarded before deletion when Discord permits it. Reports include reporter, author, message link and status with mentions suppressed.
The security approval button persists across bot restarts. It is consumed before moderation, and repeated clicks are rejected. Failed timeouts can be retried; failed deletions after a successful timeout require manual deletion to avoid extending the punishment. Duplicate member reports for the same message are suppressed for five minutes in a bounded, process-local cache.
The bot needs View Channel, Manage Messages, and Moderate Members and a role above the target member.
The acting moderator must outrank the target (except the server owner). Bots, the acting moderator, and members the bot cannot moderate are rejected.
Discord message deletion has no audit-reason parameter; `Rule 8` is attached to the timeout and recorded with actor/target/message IDs in the bot log. No message content is logged.