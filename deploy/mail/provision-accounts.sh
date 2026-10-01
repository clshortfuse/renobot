#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
image=ghcr.io/docker-mailserver/docker-mailserver@sha256:d0fe7668defe157aad57ea31b1707ad1e2fb57d7a91bdf17cbdf876549946c86
secrets=/etc/mailserver/secrets
config=/opt/mailserver/config
[[ -d "$config" && ! -L "$config" ]] || exit 1
if [[ -e "$secrets" ]]; then
  [[ -d "$secrets" && ! -L "$secrets" && $(stat -c '%u:%a' "$secrets") == 0:700 ]] || exit 1
else
  install -d -m 0700 "$secrets"
fi
for name in contact noreply; do
  account="$name@renodx.com"
  file="$secrets/$name.password"
  if [[ -f "$config/postfix-accounts.cf" ]] && grep -q "^$account|" "$config/postfix-accounts.cf"; then
    echo "$account already exists; unchanged."
    continue
  fi
  if [[ -e "$file" || -L "$file" ]]; then
    [[ -f "$file" && ! -L "$file" && $(stat -c '%u:%a' "$file") == 0:600 ]] || exit 1
  else
    (set -o noclobber; openssl rand -hex 32 > "$file")
  fi
  # The pinned helper reads password and confirmation from stdin.
  # Neither plaintext appears in argv, environment, logs or command output.
  { cat "$file"; cat "$file"; } | docker run --rm -i --network none \
    --mount "type=bind,src=$config,dst=/tmp/docker-mailserver" \
    --entrypoint setup "$image" email add "$account" >/dev/null
  echo "$account provisioned; password retained in root-only secret storage."
done

for name in privacy postmaster abuse; do
  alias="$name@renodx.com"
  if [[ -f "$config/postfix-accounts.cf" ]] &&
    awk -F '|' -v account="$alias" '$1 == account { found = 1 } END { exit !found }' "$config/postfix-accounts.cf"; then
    echo "Refusing to replace mailbox $alias with an alias." >&2
    exit 1
  fi
  existing=
  if [[ -f "$config/postfix-virtual.cf" ]]; then
    existing=$(awk -v account="$alias" '$1 == account { $1 = ""; sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print }' \
      "$config/postfix-virtual.cf")
    if [[ -z "$existing" ]] &&
      awk -v account="$alias" '$1 == account { found = 1 } END { exit !found }' "$config/postfix-virtual.cf"; then
      echo "Refusing to replace empty alias mapping for $alias." >&2
      exit 1
    fi
  fi
  if [[ -n "$existing" ]]; then
    [[ "$existing" == contact@renodx.com ]] || {
      echo "Refusing to replace conflicting alias mapping for $alias." >&2
      exit 1
    }
    echo "$alias already routes to contact@renodx.com; unchanged."
    continue
  fi
  docker run --rm --network none \
    --mount "type=bind,src=$config,dst=/tmp/docker-mailserver" \
    --entrypoint setup "$image" alias add "$alias" contact@renodx.com >/dev/null
  echo "$alias routes to contact@renodx.com."
done