# Production deployment

Renobot deploys as one OCI container on a generic Linux host. GitHub Actions
validates the repository, publishes a multi-architecture image to GHCR, and
deploys its immutable digest over SSH. Docker Compose owns the bot container;
host-managed Nginx and Certbot provide HTTPS for `renobot.renodx.com`.

The design requires no AWS-specific service. A small Ubuntu VM such as an EC2
`t4g.micro` is suitable as an initial estimate, but capacity has not been load
tested. Run exactly one bot replica because Discord processing and current
admission state are not coordinated between instances.

## Optional SQLite persistence

Use a single local SQLite database on the Lightsail host; it is not a separate
database service. The deployment script creates `/opt/renobot/data` if absent,
as a private persistent host directory owned by UID/GID 1000 (the container's
`node` user), mode `0700`. It refuses symlinks or an existing directory with
different ownership or permissions instead of modifying existing data. The
deployment user must be able to create directories under `/opt/renobot`.
Set `DATABASE_URL=file:/data/renobot.db` in the private host environment file.
Compose bind-mounts the host directory at `/data` even with a read-only app
filesystem. Never put the database in the image, static files, Git, or `/tmp`.
Do not run multiple app replicas against the same file or use a network-mounted
SQLite database. Without `DATABASE_URL`, the bot and portal remain usable
without account persistence.

**Backups are not implemented yet.** A host disk failure can lose settings and
the encryption key must also be backed up separately. Before depending on this
for real modder data, implement encrypted off-host backups with a
transaction-consistent SQLite snapshot and test restores. Do not copy a live
`.db` file to S3 as a backup. A process/container restart does not remove the
host directory, but deleting or replacing the host disk can.

The image generates its Prisma JavaScript client during build and includes the
checked-in SQLite migration. Authored SQLite table, column, constraint, and
index names use lowercase `snake_case`; Prisma maps these to the existing
JavaScript model and field names. The deployment script runs `prisma migrate deploy`
on the persistent volume **before** switching the app when `DATABASE_URL` is set.
Migration failures block the switch. A successful migration is not undone by
switching to an older image: review compatibility before deploying. In
development, `npm run db:generate` generates the client and `npm run db:migrate`
creates/applies migrations; `npm run db:deploy` applies checked-in migrations.
`npm run db:validate` validates the schema. For local development set
`DATABASE_URL=file:./dev.db` (relative to `prisma/schema.prisma`). There is no
automatic import of data from a PostgreSQL database; export and migrate any
existing records deliberately before switching a populated deployment.

To enable **inactive Ko-fi settings** (not payment processing), configure
`DATABASE_URL`, `DISCORD_MODDER_ROLE_ID`, `KOFI_ENCRYPTION_KEY` (a dedicated
base64-encoded 32-byte key), `SUPPORTER_MINIMUM_AMOUNT`, and
`SUPPORTER_CURRENCY` together in the private environment file. Losing or
changing the key makes existing ciphertext unreadable; back it up separately
from the database and plan key rotation before changing it. `v1:` ciphertext
authenticates its owning account, integration ID, and secret field;
copies between owners or fields fail decryption. Do not rotate the key without
a deliberate re-encryption plan; there is no automatic fallback or old-key
keyring. New integrations stay disabled, and the UI does not publish creator
webhook URLs or enable supporter roles. The forwarding URL is stored encrypted
but is never contacted by this phase. Only future audited forwarding code may
send private payment payloads.
The payment parser and idempotent ledger repository are internal-only: no
webhook route invokes them, and they do not grant entitlements or forward data.
A separate `/test/kofi/:endpointId` endpoint, available only with
`KOFI_TEST_MODE=true`, verifies Ko-fi-format POSTs using
the stored secret and only updates a last-test timestamp; it discards all
payloads, including real payments accidentally sent there. The test URL is
available only through the authenticated modder settings API. Never replace a
creator's only live Ko-fi webhook with the test URL. No production webhook or
supporter-role processing is enabled.
Open modder settings pages receive safe test summaries via authenticated SSE.
Subscriptions and fan-out are in-process (one replica); a restart loses live
notifications but preserves the last successful test timestamp. No raw Ko-fi
payload is retained or streamed.

### Owner-controlled Ko-fi test deployment

The checked-in Ko-fi JSON Schema includes a **representative example**, not a
payload confirmed from Ko-fi's authenticated tester. To check the real format,
deploy an isolated owner-controlled staging instance at a publicly resolvable
HTTPS origin. The developer's computer needs no public IP. Configure staging
with its own Discord OAuth redirect URL, SQLite file, secrets, and
`PUBLIC_BASE_URL`; give a separate staging deployment its own GitHub environment
and deploy workflow before using it. The existing workflow deploys only to
`production`; setting the `production` GitHub environment variable
`KOFI_TEST_MODE=true` enables the test-only route on that production host,
**not** on a separate staging host. Restrict any such test to an owner-controlled
creator and do not replace an existing live webhook. Remove or set the GitHub
variable to `false` and redeploy to turn the test endpoint off.
The Compose image uses `NODE_ENV=production` even for staging: that setting
does not enable payment processing or disable test mode. The flag is
default-off, requires database and Ko-fi settings, and only enables the
verification-and-discard endpoint plus authenticated SSE notifications.

Sign into the staging portal as the owner or an authorized modder, save the
staging Ko-fi verification token, and leave the modder settings page open.
Use **only an owner-controlled test creator** to send Ko-fi's test delivery to
the displayed test URL; confirm the live result and last verified timestamp.
Ko-fi's signed-in tester has not been verified to accept a temporary URL. If
it requires replacing its one webhook destination, do not change any live
creator's webhook. A test delivery proves only that a token-authenticated
Ko-fi-format request reached this staging instance, not that production
entitlements or forwarding work. Do not deploy the flag as a production
activation mechanism.

### Database integration tests

The regular `npm run check` selects only `test/*.test.js` and stays
database-independent. `npm run db:test` creates a fresh temporary SQLite file,
applies the checked-in migration, and runs `test/integration/database.integration.js`.
It never uses an inherited `DATABASE_URL`, then removes only its own temporary
directory. Tests cover
cross-connection persistence, uniqueness, foreign keys, decimal round trips,
and ledger state. CI and deploy workflows run this test before publishing.

> **Before deployment:** ensure every production credential is current and was
> entered directly into the host secret file. Never paste credentials into
> chat, source control, logs, or command-line arguments.

## Host bootstrap

1. Create a dedicated deployment user with access to Docker and create
   `/opt/renobot`. Restrict SSH to keys and allow only required administration.
2. Install Docker Engine with the Compose plugin, Nginx, and Certbot's Nginx
   integration from the distribution/vendor-supported repositories.
3. Allow inbound SSH, HTTP, and HTTPS in the host and provider firewalls. Keep
   port 3000 closed externally; Compose publishes it only on `127.0.0.1`.
4. Copy `deploy/compose.yaml` and `deploy/deploy.sh` to `/opt/renobot`. The
   workflow refreshes these files on every deployment.
5. Create `/etc/renobot` owned by root and the deployment user's private group.
   Create `/etc/renobot/renobot.env` as `root:<deploy-group>` with mode `0640`;
   Compose must be able to read it. Populate it from `.env.example`. At minimum,
   configure the Discord bot values. To enable the website, configure all web
   values together.
   For persistence, configure `DATABASE_URL` as above. The deployment script
   creates `/opt/renobot/data` with UID/GID 1000 and mode `0700` if it is
   missing. If you pre-create it, use that ownership and mode. Keep the
   directory out of the Nginx root and static release tree.
6. Configure Discord's OAuth redirect URI exactly as
   `https://renobot.renodx.com/auth/discord/callback`.
7. Install `deploy/nginx.conf` as an enabled Nginx site, verify the Nginx
   configuration, and reload Nginx. Obtain and install a certificate for
   `renobot.renodx.com` with Certbot, then verify automatic renewal. The checked-in
   site is the pre-certificate HTTP configuration; Certbot supplies the TLS
   listener and redirect. Ensure the Nginx worker can traverse `/opt/renobot`
   and read `/opt/renobot/public` (the deployment-managed symlink to public
   files). Never place `/etc/renobot/renobot.env` under the public directory.

The deployment user must be able to read `/opt/renobot`, invoke Docker Compose,
replace the deployment files, and read the group-restricted runtime environment
file. Membership in Docker's group is effectively root-level host access, so
keep the account and its SSH key tightly scoped.

## GHCR access

The workflow publishes `ghcr.io/<owner>/<repository>` using `GITHUB_TOKEN`.
For a private package, authenticate Docker on the host once as the deployment
user using a narrowly scoped, revocable GitHub credential with package-read
access. Enter the credential directly on the host rather than storing it in the
repository or workflow arguments. A public package needs no host login.

## GitHub production environment

Create a GitHub Actions environment named `production`. Add approval protection
if desired, then configure these environment secrets:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_HOST` | Public DNS name or address of the Linux host. |
| `DEPLOY_PORT` | SSH port; defaults to `22` when empty. |
| `DEPLOY_USER` | Dedicated deployment account. |
| `DEPLOY_SSH_KEY` | Private SSH key for that account. |
| `DEPLOY_HOST_KEY` | Pinned `known_hosts` line for the host and selected port. |

Optional **environment variable** (not a secret): `KOFI_TEST_MODE`. It must be
exactly `true` or `false`; missing defaults to `false`. The deploy step validates
it, passes only that literal value over SSH, and stores it in the private
deployment Compose environment file (not in Git). Compose explicitly overrides
any `KOFI_TEST_MODE` entry in the host runtime env file. Deployment rollback
restores the prior setting. This does not configure a separate staging host.

Do not use an unverified `ssh-keyscan` result inside the workflow. Obtain and
verify the host key through the provider console or another trusted channel.

## Deploy and rollback

Run the **Deploy production** workflow manually. It performs `npm run check`
and SQLite migration/integration checks,
builds and publishes `linux/amd64` and `linux/arm64`, and sends the manifest
digest to `/opt/renobot/deploy.sh`. The script extracts only `src/static/` from
that exact image into `/opt/renobot/static/releases/<digest>`, pulls and starts
the app, waits for `/health`, then atomically updates `/opt/renobot/public` for
Nginx. If health fails, it restores the previous image without switching static
files. The same procedure restores matching static files on a manual rollback.
Nginx serves `/`, `/app`, and the two declared `/assets/` paths directly; it
proxies OAuth, `/auth/session`, logout, and all future private data/actions to
Node. Static HTML and code are public, not access controls. HTML uses no-cache;
CSS and JavaScript have a one-minute freshness period (no content hashes yet).
Keep old digest directories when rollback is needed; clean them only as part of
an explicit retention procedure.

For an existing host still using the all-proxy Nginx configuration, deploy the
new image first so `/opt/renobot/public` exists, then install the updated
`deploy/nginx.conf`, verify its syntax, and reload Nginx with host administrator
privileges. The CI workflow does **not** change or reload host Nginx. Check
that its worker can traverse the symlink and that `/auth/session` remains
proxied; do not point Nginx's root at the application or environment directory.

Command registration is intentionally separate from bot startup. When slash
command definitions change, run `npm run commands:register` in a trusted
administrative environment using the production application and guild IDs.

For a manual rollback, inspect `/opt/renobot/.deploy.env` and the desired prior
GHCR digest, then invoke `/opt/renobot/deploy.sh` with the complete immutable
`ghcr.io/...@sha256:...` reference and an explicit `true` or `false` test-mode
argument if needed; omitting it defaults to `false`. Never infer a truncated digest.

## Operations

- Confirm the container becomes healthy and logs `Renobot is ready`.
- Verify owner `/ping`, the public landing page and `/app` shell, Discord OAuth
   login, authenticated `/auth/session`, and CSRF-protected logout. Neither a
   public page nor authentication itself grants owner or modder capabilities.
- Keep `DISCORD_MESSAGE_CONTENT_INTENT=false` until Discord authorizes it; live
   Gateway behavior remains authoritative if portal state disagrees.
- Container logs use Docker's bounded `local` driver. Monitor health, restarts,
  disk, memory, certificate renewal, and host security updates externally.
- The website stores only signed cookies in memory. Pending summaries and
  cooldowns are also in-memory and reset when the container restarts.
- If `DATABASE_URL` is configured, the app requires the database at startup,
  persists Discord identities on OAuth login, checks connectivity in `/health`,
   and disconnects on shutdown. The migration includes account-owned Ko-fi
  and Ko-fi ledger, entitlement, sync, and outbox tables. Ko-fi processing and
   Ko-fi settings can be edited by a currently authorized modder, but payment
   processing, forwarding, appeals, and webhook activation remain unimplemented.
- Use an authenticated HTTPS OpenAI-compatible model endpoint or a secured
  private network. `localhost` in the container is not the developer PC.

`deploy/renobot.service` is retained only as a legacy direct-Node alternative.
Do not enable it on a Docker host or both supervisors may run the same bot.
