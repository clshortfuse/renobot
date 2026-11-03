# Nine-rule reporting

- Replace the registered `Report: Rule 8` message action with `Report Rule Violation`, opening a private, single-choice dropdown.
- List all nine rules with concise labels and preserve the supplied full rule text in the shared catalog/security report.
- Apply the standard delete + 24-hour timeout for every rule, using the selected label as the audit reason. Keep longer existing timeouts.
- Members submit to security; moderators act after selecting the rule. Keep authorization, hierarchy checks, report deduplication and burst protection shared across all rules.
- Bind dropdowns to their requesting user, guild and message; expire after five minutes and consume once. Accept only the rule-aware security approval format.
- Test all nine selections, member reports/approvals, invalid/expired/replayed selections and rule-aware approvals; run `npm run check`, stage only task changes. Do not deploy or commit automatically.

## Live security cards
- Replace separate message forwarding with the same Components V2 card style as security alerts: source link, escaped message preview, optional image, rule and moderation status.
- Update one recent card per source with unique reporters and their selected rules; serialize submissions so simultaneous reports are not lost. Repeat submissions do not consume burst capacity.
- Keep the first reported rule as the approval reason; additional allegations are attributed to their reporters, not silently substituted for that reason.
- Preserve evidence/reporters when consuming approvals and updating outcomes. Approval must still work after restart from the card itself.
- Bound recent-card tracking to 1,000 sources per process. Discord's text limit requires compact reporter display with an overflow count for large crowds; cached reporter identities remain deduplicated.
- Test card payloads, multiple/concurrent reporters, repeated reporters, distinct rules, failure retries, and approval/status preservation; run the full check and stage only these changes.

## Review regression fixes
- Resolve source messages inside the serialized operation. Track completed moderation, including partial deletion failures, so queued moderators cannot repeat punishment or overwrite a successful result.
- Verify cached cards before duplicate-report acknowledgements. Recreate only on Discord's confirmed Unknown Message error (10008), retaining reporter metadata and the original approval rule across failed replacement attempts.
- Preserve completed state when recreating cards; permission and transient failures must not produce duplicate cards.
- Demonstrate failing regressions before fixes, rerun unchanged afterward, then run `npm run check` and stage only task files.