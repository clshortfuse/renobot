# Verified supporter emails and personal payments

- Account-first: one Renobot account owns multiple independently verified email addresses. Discord is the first verification provider, not the account model.
- Add optional Discord `email` authorization; accept only Discord-verified addresses. Adding another address never replaces previous addresses.
- Keep verified addresses separate from accounts, supporting multiple addresses later. One address has one owner; conflicts never transfer ownership.
- Retain normalized payment email for matching. Do not expose payer email in payment APIs.
- Explicit authenticated, CSRF-protected check links only unassigned receipts. Preserve original payment dates, credit once, and retain owner approval for historical Early Access role grants.
- Provide everyone a personal payment history and Early Access summary on the welcome page.
- SMTP verification is out of scope. Existing receipts without retained email cannot be recovered automatically.
- Add migration and authentication, isolation, matching, and idempotency tests; run `npm run check`.

## Implementation

- `AccountEmail`: unique normalized address ownership, verification provider/date, many addresses per account.
- Explicit Find my payments matches all verified addresses, leaves other users' Discord links intact, and processes bounded batches transactionally.
- Historical Early Access credits preserve receipt dates for owner review. Linking creates no subscription leases or role-sync work; retroactive role grants remain a manual owner decision.
- Personal history is scoped to the session Discord ID, with scoped pagination. No payer email or network diagnostics are returned.
- Email normalization trims and case-folds only; never strips plus tags or dots. Stored addresses are private personal data. Backups and the SQLite file require restricted access.
- Re-authorizing Discord after changing its verified address adds another verified account email. SMTP and arbitrary-address verification are deferred.
