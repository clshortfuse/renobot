# Renobot portal implementation plan

## Purpose

Build a public Renobot website with a Discord-authenticated portal for RenoDX
community members, modders, moderators, and administrators. Authentication
identifies an account; server-side capabilities determine what that account may
see and do.

The first portal-backed feature will bridge qualifying recurring Ko-fi payments
from participating modders to one shared RenoDX supporter role. The design must
also leave a clean path for account information, requests, and ban appeals.

## Principles

- Keep `/` public and independent from the authenticated application.
- Keep browser-authenticated features under `/app`, but do not treat public HTML
  or JavaScript as an authorization boundary.
- Treat Discord login as identity proof, not authorization.
- Resolve capabilities on the server from current Discord and application state.
- Allow users outside the guild to authenticate so banned users can appeal.
- Keep machine endpoints outside `/app` and authenticate them independently.
- Store only information needed to operate and audit each feature.
- Never log secrets, supporter email, payment messages, shipping data, or raw
  webhook bodies.
- Keep runtime and test source in plain JavaScript with ESM and JSDoc/checkJs.
- Run one Renobot replica until scheduled work and database coordination are
  designed for multiple replicas.
- Do not offer modders a production Ko-fi webhook URL until Renobot can durably
  accept payments, reconcile the shared role, and forward to existing webhook
  destinations. Ko-fi offers only one webhook destination per creator.

## Route structure

### Public

| Route | Purpose |
| --- | --- |
| `GET /` | Public Renobot landing page. |
| `GET /app` | Public static portal shell; private data comes from authenticated endpoints. |
| `GET /assets/site.css`, `GET /assets/site.js` | Public static assets. |
| `GET /auth/session` | Signed-in account status and CSRF token; `401` without a session. |
| `GET /auth/discord` | Start Discord OAuth. |
| `GET /auth/discord/callback` | Complete Discord OAuth and create a session. |
| `POST /auth/logout` | Clear the current session. |
| `GET /health` | Internal container health check. |

The canonical RenoDX privacy policy remains at
`https://renodx.com/privacy.html`. Renobot links to it rather than maintaining a
second copy.

### Authenticated application

| Route | Capability | Purpose |
| --- | --- | --- |
| `GET /app/account` | public page shell | Discord identity and relevant account state, loaded through protected JSON. |
| `GET /app/appeals` | public page shell | View or start an eligible appeal, loaded through protected JSON. |
| `POST /app/appeals` | appeal:create | Submit an appeal. |
| `GET /app/modder` | public page shell | Modder area; data endpoints require `modder`. |
| `GET /app/modder/kofi` | public page shell | Ko-fi integration settings; data endpoints require `modder`. |
| `GET /app/api/modder/kofi` | modder | Read only safe Ko-fi configuration status. |
| `POST /app/api/modder/kofi` | modder + CSRF | Save only the signed-in modder's Ko-fi settings. |
| `GET /app/api/modder/kofi/events` | modder + signed session | SSE notifications for verified deliveries to the signed-in modder's integration. |
| `GET /app/admin` | public page shell | Administrative overview; data endpoints require `admin`. |
| `GET /app/admin/appeals` | public page shell | Appeal review queue; data endpoints require `appeal:review`. |

Final route names may change with the UI, but public, authenticated, privileged,
and machine scopes must remain distinct.

### Machine endpoints

| Route | Authentication | Purpose |
| --- | --- | --- |
| `POST /test/kofi/:endpointId` | Endpoint ID plus Ko-fi verification token | Verify and discard Ko-fi-format deliveries; record a success timestamp only. |
| `POST /webhooks/kofi/:endpointId` | Endpoint ID plus Ko-fi verification token | Receive a creator's Ko-fi payment events. |

Browser cookies must not authorize webhook requests.

## Authentication and capabilities

### OAuth

Continue using Discord OAuth with the `identify` scope. The callback creates a
short-lived signed session containing only the Discord user ID, username, and
expiration. OAuth success redirects to `/app`, or to a validated `/app` path
carried in the signed OAuth state when login started from an application page.

### Capability resolution

Resolve capabilities for each authenticated request that needs authorization:

1. The configured owner receives `admin` and all subordinate capabilities.
2. Fetch the current member from the configured guild when Discord membership is
  relevant. Distinguish a confirmed non-member from a failed Discord lookup;
  never grant or revoke a capability based on a failed lookup.
3. A current member with the configured modder role receives `modder`.
4. A current member with a future configured moderator role receives
   `appeal:review` and related moderation capabilities.
5. Any authenticated Discord user may receive `appeal:create` when application
   rules indicate that an appeal is appropriate.
6. Guild absence must not block authentication or the appeal path.

Do not store role claims in the session as authoritative. A short-lived cache may
reduce Discord API calls, but sensitive actions must tolerate role revocation and
refresh current authorization. Fail closed on Discord lookup failure for
privileged requests, returning a temporary service error rather than treating
the user as a non-member. General portal access and an eligible appeal must not
depend on a successful guild lookup.

### Access responses

- No session on a protected data or action endpoint: return `401`. The public
  page shell may redirect the browser to `/auth/discord` for sign-in as a UX
  choice, preserving a safe application return path in signed OAuth state.
- Valid session without a required capability: return `403`.
- Unknown route: return `404`.
- Machine endpoint authentication failure: return a non-revealing `401` or `403`.

## Portal shell

Keep complete pages, styles, and the small browser script in `src/static/`.
Production Nginx serves `/`, `/app`, and the declared assets directly from the
same immutable image release as the bot. Node serves these files unchanged for
local development; neither tier substitutes user data into HTML. The
same-origin `GET /auth/session` endpoint returns the current signed-in identity,
connection status, owner display flag, and per-session CSRF token as no-store
JSON; `/assets/site.js` sets DOM `textContent`, link destinations, and form
values. Do not insert user data through `innerHTML` or HTML strings. Web
components may enhance future UI without changing this boundary.
Continue building pages without adding HTML to route handlers:

- document layout and security metadata;
- public header and footer;
- authenticated navigation;
- flash/status messages;
- form controls and validation summaries;
- `401`, `403`, `404`, and service-unavailable pages.

The `/app` home page should show the signed-in identity and links only for
available capabilities. It should not explain implementation details or expose
unavailable administrative features. Public pages must not claim that visitors
can submit appeals or use other portal features before those routes actually
exist; describe planned features only as upcoming, or remove the claim.

`GET /app/api/capabilities` requires a signed session and returns the current
capability names as no-store JSON. The scoped access checks at
`GET /app/api/modder/access`, `/app/api/admin/access`, and
`/app/api/admin/appeals/access` refresh authorization on every request and
return `401`, `403`, or `503` as appropriate. They contain no feature data and
are not substitutes for checking each future privileged data/action endpoint.
The modder Ko-fi read/write API separately checks current Discord roles, requires
a signed session, and rejects writes without CSRF or valid single-currency input.
The public shell shows only implemented destinations; role-derived badges are
displayed after a successful capability lookup and remain hidden on failure.

## SQLite and Prisma

Use one local SQLite file on the Lightsail host for this single-instance portal.
Prisma handles migrations and application access. Generated client code is
build output; authored runtime and tests remain JavaScript. The initial SQLite
migration creates accounts, account-owned integrations, and the inactive future
payment ledger together. Keep identities, unique keys, payment decisions, and
entitlement state relational. Never archive complete raw Ko-fi payloads. The
file survives app/container restarts but not loss of its host disk; encrypted
off-host backups and tested restores are required before relying on it for
important modder data and are not implemented yet. See `docs/deployment.md`.

Persistence is currently opt-in via `DATABASE_URL`. On startup, a configured
database must connect successfully; each OAuth login upserts the minimal
Discord account before issuing a session. Database-backed `/health` probes
connectivity and shutdown disconnects. Existing Discord role authorization
continues to use current member lookups rather than persisted account records.
The identity and account-owned Ko-fi settings repositories exist.
An internal-only Ko-fi ingestion core validates the checked-in payment schema,
verifies an enabled integration's owner-bound secret, and durably deduplicates
minimal event ledger rows by integration and message ID. The integration is
checked again at write time. Events receive `recorded-no-entitlement` status;
no qualification decision, entitlement, role sync, or forwarding job is created.
No production webhook route or worker invokes this core yet, and integrations
remain disabled. A separate test-only POST route, explicitly enabled by
`KOFI_TEST_MODE=true`, validates an incoming form
and verification token, then discards all payload data and records only the
last successful verification time. It never invokes event recording, even if
the submitted payload represents a real payment. Its URL and timestamp are
visible only via the current-role-protected modder settings API; changing the
verification token clears the timestamp. A test request is not proof of a
real payment, Ko-fi origin, or future production readiness. Saving settings
does not enable payment ingestion or supporter-role grants.

The open modder portal subscribes through `EventSource` to an authenticated
`text/event-stream` endpoint. Its signed session cookie identifies the modder;
this is **not** JWT authentication. The server resolves current Discord modder
access and the owned integration on connection and rechecks both before each
notification. After successful token verification and timestamp persistence,
an in-process integration-scoped pub/sub fan-out sends only receipt time,
event type, amount, currency, and subscription flag. It never sends the raw
payload, token, supporter identifiers, messages, or shipping data. The page
uses DOM text, not HTML, to display the result. Streams reconnect with renewed
authorization and close after five minutes; the pub/sub state is local to the
single bot replica and live notifications are not replayed across restarts.

### Initial models

#### `Account`

Represents a Discord identity known to the portal.

- `id`
- `discordUserId` — unique string
- `lastKnownUsername`
- `createdAt`
- `updatedAt`
- `lastLoginAt`

Do not treat this table as proof of current guild membership or role ownership.

Modder access is a current Discord role check, not a stored account type or
flag. An account has at most one Ko-fi integration.

#### `KofiIntegration`

- `id`
- `accountId` — unique relation to `Account`
- `endpointId` — unique, random, unguessable
- `verificationTokenCiphertext`
- `minimumAmount` — Prisma Decimal stored in SQLite
- `currency` — three-letter currency code
- `forwardUrlCiphertext` — nullable
- `enabled`
- `lastWebhookAt` — nullable
- `lastForwardedAt` — nullable
- `createdAt`
- `updatedAt`

The verification token is write-only in the UI. Display only whether one is
configured. Encrypt secrets using an application encryption key supplied outside
the database. The creator-configured minimum must never be lower than the
server-wide supporter-role eligibility threshold.
Integration and ledger relations restrict deletion while payment records exist;
disabling an integration must not erase its history or active entitlements.

#### `KofiEvent`

Minimal payment ledger for idempotency, entitlement decisions, and support.

- `id`
- `integrationId`
- `messageId`
- `transactionId`
- `eventType`
- `supporterDiscordUserId` — nullable
- `amount`
- `currency`
- `subscriptionPayment`
- `firstSubscriptionPayment`
- `tierName` — nullable
- `occurredAt`
- `receivedAt`
- `outcome`
- `entitlementExpiresAt` — nullable

Unique constraint: `(integrationId, messageId)`.
The entitlement's `lastEventId` is tied to the same integration by a composite
foreign key. Monetary amounts use `decimal(18,2)` rather than binary floats.

Do not store supporter email, message text, shipping information, telephone, the
verification token, or the complete raw payload in this ledger.

#### `KofiEntitlement`

One renewable supporter entitlement from one participating modder.

- `id`
- `integrationId`
- `discordUserId`
- `lastEventId`
- `lastPaymentAt`
- `expiresAt`
- `createdAt`
- `updatedAt`

Unique constraint: `(integrationId, discordUserId)`.

A Discord user receives the shared supporter role while at least one entitlement
is unexpired. Renewals may only advance `lastPaymentAt` and `expiresAt`;
out-of-order payments must never shorten an entitlement.

#### `SupporterRoleSync`

Durable, coalesced work to reconcile the shared supporter role for one Discord
user. It records desired reconciliation, not a grant or removal based on a
single payment; the worker must read all active entitlements before acting.

- `discordUserId` — unique
- `nextAttemptAt`
- `attemptCount`
- `lastErrorCode` — nullable
- `updatedAt`

Enqueue in the same database transaction that changes an entitlement. The
worker removes the record only after a successful reconciliation, including a
confirmed not-in-guild result. Transient Discord failures remain queued for
retry. Schedule reconciliation for expirations even when no new payments arrive.

#### `KofiForwardDelivery`

Durable outbox for courtesy forwarding.

- `id`
- `eventId` — unique
- `bodyCiphertext`
- `attemptCount`
- `nextAttemptAt`
- `lastHttpStatus` — nullable
- `lastErrorCode` — nullable
- `deliveredAt` — nullable
- `discardedAt` — nullable
- `createdAt`
- `updatedAt`

Delete the encrypted original body after successful forwarding. Discard it after
a documented retry/retention limit.
`bodyCiphertext` is nullable so these outcomes can clear the encrypted body
without losing delivery history. Due-work indexes support later workers;
workers must still implement atomic claiming and retry limits.

### Future appeal models

Design these in the appeal phase after workflow rules are agreed:

- `Appeal`
- `AppealMessage` or immutable status history
- reviewer assignment and decision metadata
- attachments only if a concrete need and safe retention policy exist

Appeal records must not share assumptions with guild membership because a banned
user may not be a current member.

## Ko-fi modder setup

The modder Ko-fi page provides:

- a generated webhook URL **only after** payment ingestion, role reconciliation,
  and courtesy forwarding are operational; prior versions show configuration
  status without inviting the creator to switch their sole Ko-fi webhook;
- verification-token entry/replacement;
- minimum recurring amount and currency;
- optional courtesy-forwarding URL;
- enable/disable control only after end-to-end payment/forwarding/role tests;
- last received event and forwarding status;
- concise setup instructions linking to Ko-fi's webhook page.

The settings page currently stores the amount, owner-configured currency,
write-only verification token, and optional write-only HTTPS destination.
The destination is saved encrypted but is not contacted yet. Activation and
creator webhook URL remain unavailable. An explicit `KOFI_ENCRYPTION_KEY` and
`DATABASE_URL` are required; losing the encryption key makes existing settings
unreadable. The minimum initially supports one configured currency. Cross-currency
conversion is out of scope until a trusted rate source and pricing policy are
selected. The server owner sets the eligibility floor; a modder may choose a
higher minimum, but must not lower the server-wide floor.

Configured modders can see a **test-only** URL and their last verified test
delivery time. While their portal page is open, a successful delivery also
appears immediately through SSE with a safe, minimal payment summary. POSTing
Ko-fi-format data there can check form parsing and the
stored verification token without persisting a payment or triggering roles or
forwarding. Ko-fi's tester behavior has not been verified from its authenticated
dashboard; do not replace an existing live webhook destination just to run a
test. If the tester requires changing the creator's sole webhook URL, wait for
production activation instead. No test flag in the payload is trusted.

Secrets are encrypted before Prisma writes with authenticated AES-256-GCM `v1:`
envelopes. The authentication data binds the account ID, integration ID and
specific secret field; decryption requires the separate application key and
the integration's ownership context, and is not exposed by the settings API.
Changing the key without re-encryption loses access to the secrets. Webhook
processing and forwarding remain disabled.

## Ko-fi webhook processing

Ko-fi sends `application/x-www-form-urlencoded` with one `data` field containing
a JSON string. Validate the decoded value against
`schemas/kofi-payment-webhook.schema.json`, while keeping compatibility with
unknown additional fields.

Process each request as follows:

1. Apply a strict body-size limit and content-type check.
2. Parse the form and JSON payload.
3. Find the enabled integration using `endpointId`.
4. Compare `verification_token` in constant time with the decrypted configured
   token.
5. Validate required payload fields and supported types.
6. Insert the event using `(integrationId, messageId)` for idempotency.
7. Classify the event without retaining unnecessary personal data. Reject
  implausibly future-dated payments; do not grant access from payments already
  outside the entitlement window. Define the allowable timestamp skew before
  production, and distinguish Ko-fi test events from real payments using
  verified test behavior rather than an assumed payload flag.
8. For a qualifying recurring payment with a valid `discord_userid`, renew that
  creator-specific entitlement without moving its expiration backwards.
9. Persist a `SupporterRoleSync` task in the same transaction as the entitlement
  change. Reconciliation also runs on scheduled expirations.
10. If forwarding is configured, store an encrypted outbox delivery containing
    the original form body.
11. Commit before returning `200`.

Ko-fi reuses `message_id` for retries. A duplicate must return success after
confirming that the original event and any required outbox work were durably
accepted. No Discord API or downstream HTTP request is performed inside the
payment transaction. When the database is unavailable, do not return `200`;
allow Ko-fi to retry.

### Initial qualification rule

An event qualifies when all are true:

- `is_subscription_payment === true`;
- `discord_userid` is a valid Discord snowflake;
- currency matches the integration currency;
- amount satisfies the agreed threshold (including whether `$5.00` itself
  qualifies) and the integration's equal-or-higher minimum; this must be
  decided before enabling the receiver;
- timestamp and identifiers are valid.

Do not rely exclusively on `type` because Ko-fi's examples and prose have used
both Donation/Tip terminology. Subscription flags are authoritative for this
feature.

### Expiration

Ko-fi reports successful payments but not membership cancellation. Model access
as a renewable lease. Initially, each qualifying monthly payment extends the
entitlement to payment time plus a documented grace period, proposed as 35 days.

A scheduled reconciliation job and the durable `SupporterRoleSync` worker:

- grants the shared supporter role when any entitlement is active;
- removes it only when every entitlement for that Discord user is expired;
- records role-sync outcomes without treating Pino logs as state;
- retries transient Discord failures.

If the member is confirmed absent from the guild, retain entitlement state
until expiry and do not attempt role changes. A transient guild/member lookup
failure is not proof that the member left and must not remove a role or discard
pending sync work.

Confirm the lease duration and overdue-payment policy before implementation.

## Courtesy webhook forwarding

Forward the original request using:

- `POST`;
- `Content-Type: application/x-www-form-urlencoded`;
- the original `data` form field.

Forward asynchronously from the durable outbox. Downstream failures must not
cause Ko-fi delivery retries to repeat Renobot's entitlement processing. The
forwarding worker must claim work atomically and remain safe to retry after a
crash; downstream receivers may see a duplicate if delivery succeeds before
Renobot records the acknowledgement. Preserve Ko-fi's original `message_id` so
they can deduplicate.

Protect the forwarder against SSRF:

- permit HTTPS destinations only;
- reject credentials in URLs;
- reject loopback, private, link-local, multicast, and reserved addresses;
- validate every DNS resolution used for connection;
- disable redirects or validate every redirect target;
- enforce short connection and response timeouts;
- cap response bytes;
- use bounded exponential backoff and a terminal retry limit.

The settings page must disclose that forwarding sends the original Ko-fi payload,
which may contain supporter email, private messages, Discord identity, shop
items, and shipping information.

## Security requirements

- Add CSRF tokens to every authenticated state-changing form.
- Continue `HttpOnly`, `Secure`, and `SameSite=Lax` cookies.
- Rotate the session after login and bound its lifetime.
- Use safe internal return paths only; never accept arbitrary redirect URLs.
- Apply route-specific request-size and rate limits in both Nginx and Node.
- Escape all rendered content.
- Keep the content security policy restrictive.
- Encrypt integration secrets and temporary forwarding payloads at rest.
- Keep the encryption key outside the SQLite database and source control.
- Redact secrets and personal data from errors and logs.
- Verify current capabilities for every privileged operation.
- Record administrative changes in a minimal audit table if the owner can edit
  another modder's configuration.

## Logging and retention

Pino records operational events only:

- route or operation name;
- internal integration/event identifiers;
- Ko-fi message or transaction identifier when needed;
- supporter Discord ID when needed for role troubleshooting;
- outcome, duration, and non-sensitive error classification.

Pino must not receive verification tokens, email, message text, shipping,
telephone, forwarding secrets, raw payloads, OAuth tokens, or cookies.

Define database retention before production:

- minimal Ko-fi event ledger retention;
- forwarding-body deletion after delivery or terminal failure;
- expired entitlement retention;
- account cleanup after inactivity;
- future appeal retention and deletion rules.

## Deployment

Bind-mount a private persistent host directory for SQLite. Plan encrypted
off-host backups and test restoring both the database and encryption key before
production data depends on them; no backup scheduler is included yet.

Deployment requirements:

- configure `DATABASE_URL`;
- configure an application encryption key separately;
- run Prisma migrations before switching the app container;
- fail startup when database-backed features are enabled but unavailable;
- preserve the existing health check and add a readiness decision for required
  database connectivity;
- keep exactly one worker until scheduled jobs use database-backed claiming or
  advisory locks.

## Implementation phases

### Phase 1 — Web foundation

Status: web foundation implemented. Public routes, scoped login return paths,
CSRF-protected logout, and basic HTML error pages are implemented and tested.
Complete pages and assets live in static files without placeholders. Future
forms, navigation, and more specific error pages will be added with their features.

- Public `/` landing page.
- Discord OAuth routes.
- Neutral authenticated `/app` scope.
- Explicit logout route.
- Serve static HTML without server-side rendering. Keep application data in
  authenticated JSON endpoints and update the page with safe DOM properties.
- Add standard error pages.
- Add safe return-to handling and CSRF support.
- Remove or qualify any public-facing claims that appeals and account tools are
  already available; restore them when those features ship.

Exit criteria: public and authenticated routes are tested; OAuth identifies any
Discord user without granting privileges.

### Phase 2 — Capability resolution

Status: capability discovery and scoped access-check JSON endpoints implemented
and tested. Public HTML pages are never protected by role checks. No privileged
feature data or action endpoints exist yet; when those features ship, each
endpoint must call the resolver on every request. Confirmed non-members get no
guild role capabilities, and Discord lookup failures return a temporary error.
Privileged feature pages and navigation remain unavailable until their
respective phases ship.

- Add guild ID and role configuration needed by the website.
- Implement current Discord member/role lookup.
- Define capability names and centralized route guards.
- Add short-lived non-authoritative lookup caching if needed.
- Render `/app` navigation from capabilities.
- Test owner, modder, ordinary member, non-member, and Discord failure cases.

Exit criteria: privileged pages cannot be reached without current server-side
capabilities; non-members can still reach eligible general portal features.

### Phase 3 — SQLite and Prisma

Status: account and Ko-fi integration/event/entitlement/role-sync/outbox
tables and a checked-in SQLite migration exist. The generated client build, account
repository, opt-in startup/readiness, and pre-switch deployment migration are
implemented. Ko-fi processing and access flows remain unimplemented. Host
directory provisioning remains an operator responsibility, and off-host backups
are deferred. Tests cover the schema, repository contract, and HTTP/deployment
boundaries. The SQLite migration and database constraints pass isolated file
integration tests; CI and production publish run the same database test job.
This does not provision or migrate a production database.

- Add Prisma with the SQLite datasource.
- Add `prisma.config.js`, schema, generated-client path, and migrations.
- Add database lifecycle management and graceful disconnect.
- Implement the `Account` repository; create integration,
  event, entitlement, role-sync, and outbox repositories in their feature phases.
- Add migration and deployment scripts.
- Add database-backed integration tests isolated from unit tests.

Exit criteria: migrations run reproducibly and portal account/integration records
persist across restarts.

### Phase 4 — Modder portal and Ko-fi configuration

Status: a public static settings shell and protected read/write API now support
each modder's own inactive Ko-fi configuration. Role, CSRF, validation,
encrypted-at-rest, and per-owner persistence behavior have unit, HTTP, and
SQLite integration tests. A live production deployment is not configured.
Webhook URL/activation, last-event reporting, and courtesy forwarding are
still deferred to later phases.

- Add `/app/modder` and `/app/modder/kofi`.
- Generate endpoint IDs securely.
- Encrypt and save verification tokens and optional forward URLs.
- Provide write-only secret replacement and configuration status.
- Add owner visibility only after explicit administrative requirements are set.
- Keep the webhook URL and activation control unavailable to modders until
  Phases 5–7 pass the end-to-end acceptance checks. Do not instruct anyone to
  replace an existing Ko-fi destination yet.

Exit criteria: an authorized modder can configure only their own integration and
see its setup status; no production webhook traffic is accepted for that
integration yet.

### Phase 5 — Ko-fi ingestion, event ledger, and delivery outboxes

- Add bounded form-body parsing.
- Add schema validation and normalized payment parsing.
- Authenticate creator-specific webhook requests.
- Persist idempotent sanitized events.
- Implement qualifying entitlement renewal and persist role-sync tasks in the
  same transaction as the event and entitlement changes.
- Add encrypted forwarding outbox and safe, retryable HTTPS delivery, including
  SSRF and DNS-rebinding protections, before modders are asked to redirect Ko-fi.
- Reject payments outside agreed timestamp bounds; test retries, out-of-order
  events, and Ko-fi's test deliveries.
- Show safe last-event status in the modder portal.
- Test the observed direct Ko-fi payload including `discord_userid`. Use an
  owner-controlled staging integration for real Ko-fi test deliveries; do not
  ask a participating modder to replace an existing production webhook yet.

Exit criteria: isolated test events are persisted exactly once together with
required outbox work, invalid events are safely rejected, forwarding works
across restarts, and sensitive fields never enter logs or the event ledger.
Creator webhook URLs remain unavailable for production use.

### Phase 6 — Supporter entitlements and Discord roles

- Configure the shared supporter role ID.
- Verify creator-specific entitlement renewals in end-to-end role tests.
- Implement scheduled expiration and the durable role-sync worker.
- Handle multiple modder subscriptions per supporter.
- Retry transient Discord failures without losing queued work.
- Document required Discord permissions and role ordering.

Exit criteria: one active qualifying subscription grants the role, and the role
is removed only after all qualifying entitlements expire, even across bot
restarts. A Discord outage or confirmed non-member does not erase entitlements.

### Phase 7 — Activate creator webhooks

- Complete end-to-end role and forwarding verification with a real Ko-fi test
  delivery to the owner-controlled staging integration, then verify each
  participating creator's settings without making a synthetic test payment
  grant a production supporter role.
- Expose the stable creator webhook URL and enable control in the modder portal.
- Show forwarding and role-sync status without exposing payload data.
- Publish privacy disclosure and retention controls for forwarding.
- Document a rollback procedure to restore the creator's prior webhook URL if
  Renobot has a production incident.

Exit criteria: creators can safely move their sole Ko-fi webhook to Renobot
without losing their previous integration; Renobot durably processes payments,
updates roles, and forwards independently of downstream availability.

### Phase 8 — Appeals

- Agree on eligibility, states, reviewer roles, notifications, retention, and
  abuse controls.
- Add appeal data model and migrations.
- Add user submission/status pages.
- Add reviewer queue and decision workflow.
- Ensure banned/non-member Discord users can authenticate and participate.

Exit criteria: appeals have a documented human-owned workflow, auditable state
changes, appropriate rate limits, and tested access boundaries.

## Testing strategy

- Unit-test session, CSRF, capability, parser, qualification, encryption, and URL
  validation logic.
- Route-test public, authenticated, forbidden, and machine scopes.
- Use SQLite integration tests for unique constraints, transactions,
  entitlement aggregation, and outbox claiming.
- Test Ko-fi retries with the same `message_id`.
- Test older and future-dated payments, test deliveries, and monotonic renewal.
- Test multiple active creators for one supporter.
- Test expiration with deterministic clocks.
- Test Discord role grant/removal failures, member lookup failures, recovery,
  and crashes between commit and worker execution.
- Test forwarding against private-address and DNS-rebinding cases.
- Run `npm run check` before every phase is considered ready.

## Decisions required before later phases

1. Discord role IDs for modders, moderators, and supporters.
2. Whether exactly `$5.00` qualifies or the requirement is strictly greater than
  `$5.00`; set a server-wide eligibility floor before allowing modders to
  configure a higher per-creator minimum.
3. Supported currency policy.
4. Entitlement lease and grace-period duration.
5. SQLite off-host backup schedule, encryption, and restore policy.
6. Secret-encryption key storage and rotation procedure.
7. Courtesy-forward retry and payload-retention limits.
8. Appeal eligibility, states, reviewer roles, notification policy, and
   retention.
9. Accepted Ko-fi payment timestamp skew, stale-delivery policy, and verified
  treatment of Ko-fi's built-in test deliveries.
