#!/usr/bin/env bash
# Deploy pexl frontend + backend on the VPS.
# Run this after code has been pushed to origin/main.
#
#   bash deploy.sh
#
# The script is location-agnostic — it always operates on the repo it
# lives in, not the caller's cwd.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "==> [1/4] git pull"
git pull --ff-only

echo "==> [2/4] npm install"
npm install

echo "==> [3/4] npm run build"
npm run build

echo "==> [4/4] pm2 restart (with --update-env)"
pm2 restart pexl-backend  --update-env
pm2 restart pexl-frontend --update-env
pm2 save

echo
pm2 list | grep -E "pexl-(backend|frontend)" || true
echo
echo "Deploy complete."
