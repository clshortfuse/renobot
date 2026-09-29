# Account emails and personal payments

Every signed-in user can view their recorded Ko-fi payments and Early Access status on the Overview page. No modder or owner role is required.

An account can own multiple verified email addresses. Under **Verified Emails**, **Add Discord Email** requests optional Discord email permission and adds only the address Discord marks as verified. It never replaces existing addresses. Re-authorizing after changing your verified Discord email can add another address. An address already owned by another Renobot account is not transferred.

Verification by emailed link, SMTP setup, and arbitrary-address verification are not implemented yet. There is no endpoint accepting an address supplied by the browser as verified.

**Find my payments** checks all verified addresses and attaches matching unassigned receipts to the signed-in Discord user. Payments already linked to that Discord ID are always visible, even without a verified email. Payments linked to someone else are never reassigned. Matching is explicit and can be repeated safely; it processes batches of 50 receipts.

Linking is attribution-only and preserves original receipt dates. It does not create Early Access credits, balances, or periods, create subscription entitlements, or queue any role changes. Historical crediting and retroactive role application remain separate owner-controlled actions. Existing live-payment behavior is unchanged.

## Storage and deployment

Deploy the `20260929030000_verified_account_emails` migration before running the updated application. This creates account email ownership records and adds an optional payer email to payment receipts. No production migration is applied by development tests.

Emails are private personal data stored in SQLite and its backups. Restrict database and backup access. Payment APIs do not expose payer email or network diagnostics to supporters; account email lists are visible only to their signed-in owner. OAuth email values are not placed in the session cookie.

Addresses are trimmed and case-folded for matching. Dots and plus tags are not removed, and aliases are not inferred. Existing receipts that did not retain an email cannot be retrospectively matched by email without a separately verified import. There is no Ko-fi account OAuth linkage or historical-payment API involved.