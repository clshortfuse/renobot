# Ko-fi delivery and membership rollout

## Local checkpoint (implemented and tested without deployment)

- Use one creator webhook URL for Ko-fi test deliveries and real payments; verify, deduplicate, and store minimal event rows for both. No separate test URL or deployment-wide test mode exists.
- Show only the signed-in modder's stored entries; publish a minimal event notification to that modder's SSE stream after a durable insert. Never publish the verification token, private message, email, or shipping data.
- Page through stored entries beyond the latest 50; the event ledger, not SSE, is authoritative. A failed write must never receive a success response, and Discord login failure must not prevent webhook startup.
- By default, store receipts only. When `DISCORD_SUPPORTER_ROLE_ID` is explicitly configured, qualifying subscription deliveries from the same URL (including Ko-fi tests) renew a 35-day creator-scoped lease and enqueue shared-role reconciliation. Manual controls are **not implemented**.
- Keep courtesy forwarding inactive. A successful prod response means an entry was stored, **not** that a supporter role was granted.

## Owner visibility checkpoint

- Show the configured owner a paginated, read-only SQLite receipt ledger across modders, with the owning account identified and no secrets or raw Ko-fi payloads.
- Show only a bounded, in-process operational event summary (receipt accepted, duplicate, rejected, or storage failure). It is not Docker stdout and disappears on restart. Do not include endpoint IDs, tokens, payloads, exception strings, or supporter identifiers in this view.
- Require the signed-in owner's current `admin` capability on each private API request. Public HTML is only a shell; a modder must never gain the cross-owner ledger or operations feed.
- No production DB or Docker logs are available from the development workspace; verify live deliveries separately with authorized host access or the newly deployed owner page.

## Role reconciliation (opt-in, not deployed)

- `KofiEntitlement` tracks each creator/supporter lease; a payment cannot shorten its expiration. The 35-day lease is measured from the payment timestamp. Old/future payments, wrong currency, one-time payments, and payments below either minimum remain receipts only.
- A scheduled worker aggregates all unexpired leases for the Discord user. `ManagedSupporterRole` stores provenance only after Renobot actually adds the role. Existing manual roles are not adopted or removed; removal occurs only after the last lease expires and Renobot still owns the grant. Failures are retried through `SupporterRoleSync`.
- Opt-in activation treats Ko-fi test payments exactly like real payments; a test with a real guild Discord ID can grant the real shared role. Keep `DISCORD_SUPPORTER_ROLE_ID` unset until that consequence is acceptable. Discord role operations are asynchronous and never gate receipt commits.
- Discord and SQLite cannot commit atomically. If the process dies after Discord grants the role but before provenance is saved, Renobot conservatively leaves that role alone rather than risk revoking a manual grant; an operator must reconcile that rare case. Disabling role sync after grants also pauses expiry removals until it is re-enabled.

## Before broad supporter-role rollout

- Add scoped manual allow/revoke decisions per supporter, and define whether they override renewals. The 35-day expiry policy is selected for automatic leases.
- Verify role hierarchy and absence-from-guild behavior against an owner-controlled live guild before setting the role ID in production.
- Decide how revocation interacts with later renewal, what to do with entries without a Discord user ID, and how Ko-fi test payments are distinguished from real payments. Do not infer a test marker from undocumented payload fields.
- Test real creator-to-server deliveries and rollback before asking creators to switch their existing webhook destination. No deployment is part of this checkpoint.