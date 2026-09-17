#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != ghcr.io/*@sha256:* ]]; then
  echo 'Usage: deploy.sh ghcr.io/owner/image@sha256:digest' >&2
  exit 2
fi

cd /opt/renobot
new_image=$1
previous_image=$(sed -n 's/^RENOBOT_IMAGE=//p' .deploy.env 2>/dev/null || true)
printf 'RENOBOT_IMAGE=%s\n' "$new_image" > .deploy.env.next
docker compose --env-file .deploy.env.next -f compose.yaml pull app
mv .deploy.env.next .deploy.env

if docker compose --env-file .deploy.env -f compose.yaml up -d --no-deps --wait app; then
  docker image prune -f --filter 'until=168h' >/dev/null
  exit 0
fi

if [[ -n "$previous_image" ]]; then
  printf 'RENOBOT_IMAGE=%s\n' "$previous_image" > .deploy.env
  docker compose --env-file .deploy.env -f compose.yaml up -d --no-deps --wait app
fi
exit 1