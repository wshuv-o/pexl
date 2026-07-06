# nginx configs for pexl_api

Tracked so `git pull` on the prod box is enough to update the reverse-proxy
config — no more editing `/etc/nginx/sites-available/…` by hand.

## Apply on server

```bash
cd ~/test/pexl
git pull
sudo bash backend/nginx/apply.sh
```

The script:
1. Backs up the current `/etc/nginx/sites-available/<domain>` to
   `<file>.bak.<timestamp>`
2. Copies the tracked config in its place
3. Ensures the `sites-enabled/<domain>` symlink exists
4. Runs `nginx -t` — if that fails, restores the backup and exits non-zero
5. `systemctl reload nginx`

## Rollback

If a change breaks something in prod:

```bash
sudo bash backend/nginx/apply.sh restore
```

That copies the newest `.bak.*` back into place, validates, and reloads.

## Files

- `pexlbackend.bulkscraper.cloud.conf` — reverse proxy for the FastAPI
  worker on port 8006. Includes the 900 s `proxy_*_timeout` settings that
  keep the OCR download endpoints from being cut at 60 s.
