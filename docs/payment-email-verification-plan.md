# Additional payment email verification

- Add SMTP-backed verification for authenticated Discord accounts on the account page.
- Store only SHA-256 token digests; links expire after 30 minutes, require the initiating Discord session, and are consumed by CSRF-protected POST, never GET.
- Keep unique normalized email ownership. No transfers, removals, payment reassignment, crediting, or role grants.
- Bound sends per account/address and globally with persisted request history; invalidate older requests for the same account/address.
- Use generic conflict messages and sanitized SMTP failure reporting. SMTP credentials remain environment-only.
- After verification, use the existing bounded Find my payments action for unassigned receipts; owner credit/review stays separate.
- Add database, HTTP, and mail configuration tests; run repository checks. Do not commit or deploy without a separate request. Currency work is excluded.