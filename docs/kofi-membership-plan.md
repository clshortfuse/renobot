# Ko-fi delivery and membership rollout

## Local checkpoint (implemented and tested without deployment)

- Use one creator webhook URL for Ko-fi test deliveries and real payments; verify, deduplicate, and store minimal event rows for both. No separate test URL or deployment-wide test mode exists.
- Show only the signed-in modder's stored entries; publish a minimal event notification to that modder's SSE stream after a durable insert. Never publish the verification token, private message, email, or shipping data.
- Page through stored entries beyond the latest 50; the event ledger, not SSE, is authoritative. A failed write must never receive a success response, and Discord login failure must not prevent webhook startup.
- Do not automatically grant or remove Discord roles as a consequence of accepting a webhook. Store receipts only until the membership policy and role-reconciliation worker are tested. Manual controls are **not implemented** in this checkpoint.
- Keep courtesy forwarding inactive. A successful prod response means an entry was stored, **not** that a supporter role was granted.

## Before live supporter-role activation

- Add scoped manual allow/revoke decisions per supporter, an expiration date, and a documented grace policy (35 days is a proposal, not a confirmed rule).
- Reconcile the shared Discord supporter role across all modders' effective entitlements; retry API failures and reconcile expirations without requiring another webhook. Verify role hierarchy and absence-from-guild behavior.
- Decide how revocation interacts with later renewal, what to do with entries without a Discord user ID, and how Ko-fi test payments are distinguished from real payments. Do not infer a test marker from undocumented payload fields.
- Test real creator-to-server deliveries and rollback before asking creators to switch their existing webhook destination. No deployment is part of this checkpoint.