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

echo "==> [1/5] git pull"
git pull --ff-only

echo "==> [2/5] ensure LibreOffice (DOC/DOCX -> PDF conversion)"
# The backend converts uploaded .doc/.docx to PDF by shelling out to
# LibreOffice headless (see backend/services/doc_converter.py). Without it,
# every Word upload fails with a 500. Install once; idempotent on re-deploy.
if command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1; then
  echo "    LibreOffice already present ($(command -v soffice || command -v libreoffice))"
elif command -v apt-get >/dev/null 2>&1; then
  SUDO=""
  [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  echo "    installing libreoffice-writer via apt-get..."
  $SUDO apt-get update -qq
  # libreoffice-writer (+ its core) is all that's needed for docx->pdf and is
  # far smaller than the full libreoffice suite.
  $SUDO apt-get install -y --no-install-recommends libreoffice-writer
  echo "    installed: $(command -v soffice || command -v libreoffice || echo 'NOT FOUND')"
else
  echo "    WARNING: no apt-get and no LibreOffice found — DOC/DOCX uploads will fail."
  echo "    Install LibreOffice manually to enable Word support."
fi

echo "==> [3/5] npm install"
npm install

echo "==> [4/5] npm run build"
npm run build

echo "==> [5/5] pm2 restart (with --update-env)"
pm2 restart pexl-backend  --update-env
pm2 restart pexl-frontend --update-env
pm2 save

echo
pm2 list | grep -E "pexl-(backend|frontend)" || true
echo
echo "Deploy complete."
