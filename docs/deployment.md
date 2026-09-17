# Production deployment

Renobot deploys as one OCI container on a generic Linux host. GitHub Actions
validates the repository, publishes a multi-architecture image to GHCR, and
deploys its immutable digest over SSH. Docker Compose owns the bot container;
host-managed Nginx and Certbot provide HTTPS for `renobot.renodx.com`.

The design requires no AWS-specific service. A small Ubuntu VM such as an EC2
`t4g.micro` is suitable as an initial estimate, but capacity has not been load
tested. Run exactly one bot replica because Discord processing and current
admission state are not coordinated between instances.

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
   configure the Discord bot values. To enable the dashboard, configure all
   dashboard values together.
6. Configure Discord's OAuth redirect URI exactly as
   `https://renobot.renodx.com/auth/discord/callback`.
7. Install `deploy/nginx.conf` as an enabled Nginx site, verify the Nginx
   configuration, and reload Nginx. Obtain and install a certificate for
   `renobot.renodx.com` with Certbot, then verify automatic renewal. The checked-in
   site is the pre-certificate HTTP configuration; Certbot supplies the TLS
   listener and redirect.

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

Do not use an unverified `ssh-keyscan` result inside the workflow. Obtain and
verify the host key through the provider console or another trusted channel.

## Deploy and rollback

Run the **Deploy production** workflow manually. It performs `npm run check`,
builds and publishes `linux/amd64` and `linux/arm64`, and sends the manifest
digest to `/opt/renobot/deploy.sh`. The script pulls the digest before changing
the active deployment, waits for `/health`, and restores the previous digest if
the new container fails its health check.

Command registration is intentionally separate from bot startup. When slash
command definitions change, run `npm run commands:register` in a trusted
administrative environment using the production application and guild IDs.

For a manual rollback, inspect `/opt/renobot/.deploy.env` and the desired prior
GHCR digest, then invoke `/opt/renobot/deploy.sh` with the complete immutable
`ghcr.io/...@sha256:...` reference. Never infer a truncated digest.

## Operations

- Confirm the container becomes healthy and logs `Renobot is ready`.
- Verify owner `/ping`, OAuth owner login, rejected non-owner login, and logout.
- Keep `DISCORD_MESSAGE_CONTENT_INTENT=false` until Discord authorizes it; live
   Gateway behavior remains authoritative if portal state disagrees.
- Container logs use Docker's bounded `local` driver. Monitor health, restarts,
  disk, memory, certificate renewal, and host security updates externally.
- The dashboard stores only signed cookies in memory. Pending summaries and
  cooldowns are also in-memory and reset when the container restarts.
- `DATABASE_URL` is reserved for future portable PostgreSQL persistence; no
  current runtime feature connects to a database.
- Use an authenticated HTTPS OpenAI-compatible model endpoint or a secured
  private network. `localhost` in the container is not the developer PC.

`deploy/renobot.service` is retained only as a legacy direct-Node alternative.
Do not enable it on a Docker host or both supervisors may run the same bot.
