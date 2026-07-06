#!/usr/bin/env bash
# Copy the tracked nginx config to /etc/nginx/sites-available, verify the
# syntax, and reload nginx. Safe to re-run — takes a backup of whatever
# was there first so a bad edit can be rolled back with `apply.sh restore`.
#
# Run as root or with sudo:
#     sudo bash backend/nginx/apply.sh
#     sudo bash backend/nginx/apply.sh restore
set -euo pipefail

DOMAIN="pexlbackend.bulkscraper.cloud"
SRC="$(cd "$(dirname "$0")" && pwd)/${DOMAIN}.conf"
DEST="/etc/nginx/sites-available/${DOMAIN}"
BACKUP="${DEST}.bak.$(date +%Y%m%d-%H%M%S)"

if [[ "${1:-}" == "restore" ]]; then
  latest=$(ls -1t "${DEST}.bak."* 2>/dev/null | head -1 || true)
  if [[ -z "$latest" ]]; then
    echo "No backup found to restore." >&2
    exit 1
  fi
  echo "Restoring $latest → $DEST"
  cp -a "$latest" "$DEST"
  nginx -t && systemctl reload nginx
  echo "Restore complete."
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "Source file not found: $SRC" >&2
  exit 1
fi

if [[ -f "$DEST" ]]; then
  echo "Backing up existing config → $BACKUP"
  cp -a "$DEST" "$BACKUP"
fi

echo "Installing $SRC → $DEST"
install -m 0644 "$SRC" "$DEST"

# Make sure the symlink from sites-enabled exists.
if [[ ! -L "/etc/nginx/sites-enabled/${DOMAIN}" ]]; then
  ln -sf "$DEST" "/etc/nginx/sites-enabled/${DOMAIN}"
  echo "Created sites-enabled symlink."
fi

echo "Validating nginx config…"
if ! nginx -t; then
  echo
  echo "✗ nginx -t failed. Rolling back."
  if [[ -f "$BACKUP" ]]; then
    cp -a "$BACKUP" "$DEST"
    nginx -t
  fi
  exit 1
fi

echo "Reloading nginx…"
systemctl reload nginx
echo "✔ Done. New timeouts (900s) are live."
