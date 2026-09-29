#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! "$1" =~ ^ghcr\.io/.+@sha256:[[:xdigit:]]{64}$
  || ( "${2:-false}" != true && "${2:-false}" != false ) ]]; then
  echo 'Usage: deploy.sh ghcr.io/owner/image@sha256:digest [true|false]' >&2
  exit 2
fi

cd /opt/renobot
new_image=$1
test_mode=${2:-false}
unset KOFI_TEST_MODE
unset KOFI_ENCRYPTION_KEY
if ! IFS= read -r kofi_key || [[ -z "$kofi_key" ]]; then
  echo 'A Ko-fi encryption key must be supplied on stdin.' >&2
  exit 2
fi
if [[ ! "$kofi_key" =~ ^[A-Za-z0-9+/]{43}=$ ]] ||
  [[ $(printf '%s' "$kofi_key" | base64 --decode 2>/dev/null | base64 -w 0) != "$kofi_key" ]]; then
  echo 'Ko-fi encryption key must encode exactly 32 bytes.' >&2
  exit 2
fi
previous_image=$(sed -n 's/^RENOBOT_IMAGE=//p' .deploy.env 2>/dev/null || true)
previous_test_mode=$(sed -n 's/^KOFI_TEST_MODE=//p' .deploy.env 2>/dev/null || true)
previous_key=$(sed -n 's/^KOFI_ENCRYPTION_KEY=//p' .deploy.env 2>/dev/null || true)
if [[ -z "$previous_key" ]]; then
  previous_key=$(sed -n 's/^KOFI_ENCRYPTION_KEY=//p' /etc/renobot/renobot.env 2>/dev/null || true)
fi
if [[ "$previous_test_mode" != true ]]; then previous_test_mode=false; fi
(
  umask 077
  printf 'RENOBOT_IMAGE=%s\nKOFI_TEST_MODE=%s\nKOFI_ENCRYPTION_KEY=%s\n' \
    "$new_image" "$test_mode" "$kofi_key" > .deploy.env.next
  chmod 600 .deploy.env.next
)
docker compose --env-file .deploy.env.next -f compose.yaml pull app

# The mount must exist before either Compose run or up. Only initialize an
# absent directory; refuse symlinks and existing directories with unsafe
# ownership/permissions instead of modifying potentially important data.
if [[ -L data || ( -e data && ! -d data ) ]]; then
  echo '/opt/renobot/data must be a private directory, not a symlink or file.' >&2
  exit 1
fi
if [[ ! -d data ]]; then
  install -d -m 0700 data
  chmod g-s data # /opt/renobot is setgid; install may inherit its setgid bit.
  docker run --rm --network none --read-only --user 0 \
    --mount type=bind,src=/opt/renobot/data,dst=/data \
    --entrypoint chown "$new_image" 1000:1000 /data
fi
if [[ $(stat -c '%u:%g:%a' data) != 1000:1000:700 ]]; then
  echo '/opt/renobot/data must be owned by UID/GID 1000 with mode 0700.' >&2
  exit 1
fi

# Replacing the key would make existing encrypted integration settings unreadable.
# Check through the image as UID 1000 because the private SQLite file is not
# readable by the deployment user. Fail closed on any database inspection error.
if [[ -f data/renobot.db && "$previous_key" != "$kofi_key" ]]; then
  docker run --rm --network none --read-only --user 1000 \
    --mount type=bind,src=/opt/renobot/data,dst=/data,readonly \
    --entrypoint node "$new_image" -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("/data/renobot.db", { readOnly: true });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", "kofi_integration");
      if (table && db.prepare("SELECT COUNT(*) AS count FROM kofi_integration").get().count > 0) {
        console.error("Refusing to replace the Ko-fi key while integrations exist.");
        process.exitCode = 1;
      }
      db.close();
    '
fi

# The database lives on /opt/renobot/data, outside image releases. The selected
# image owns the schema; do not switch the app if its migration fails. The
# private runtime environment file supplies DATABASE_URL inside the container.
docker compose --env-file .deploy.env.next -f compose.yaml run --rm --no-deps \
  --entrypoint sh app -c 'umask 077; if [ -n "${DATABASE_URL:-}" ]; then ./node_modules/.bin/prisma migrate deploy; fi'

# Publish only the image's public files, never its application code or env file.
release_dir="/opt/renobot/static/releases/${new_image##*@sha256:}"
if [[ ! -d "$release_dir" ]]; then
  mkdir -p /opt/renobot/static/releases
  staging=$(mktemp -d /opt/renobot/static/releases/.next.XXXXXX)
  container=
  cleanup() {
    if [[ -n "${container:-}" ]]; then docker rm "$container" >/dev/null; fi
    if [[ -n "${staging:-}" ]]; then rm -rf "$staging"; fi
  }
  trap cleanup EXIT
  container=$(docker create "$new_image")
  docker cp "$container:/app/src/static/." "$staging/"
  docker rm "$container" >/dev/null
  container=
  chmod -R a+rX "$staging"
  mv "$staging" "$release_dir"
  staging=
  trap - EXIT
fi

mv .deploy.env.next .deploy.env

if docker compose --env-file .deploy.env -f compose.yaml up -d --no-deps --wait app \
  && ln -s "$release_dir" /opt/renobot/public.next \
  && mv -Tf /opt/renobot/public.next /opt/renobot/public; then
  docker image prune -f --filter 'until=168h' >/dev/null
  exit 0
fi

rm -f /opt/renobot/public.next
if [[ -n "$previous_image" ]]; then
  (
    umask 077
    printf 'RENOBOT_IMAGE=%s\nKOFI_TEST_MODE=%s\nKOFI_ENCRYPTION_KEY=%s\n' \
      "$previous_image" "$previous_test_mode" "$previous_key" > .deploy.env
    chmod 600 .deploy.env
  )
  docker compose --env-file .deploy.env -f compose.yaml up -d --no-deps --wait app
fi
exit 1