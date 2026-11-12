# Deployment & operations

The default deployment is a **single Docker Compose service** on a Linux host. It does not require 1Panel, PostgreSQL, Redis, Kubernetes or a separate instance of chaos-cl's upstream gateway.

## Initial setup

1. Create/publish the independent GitHub repository `jmcgillcoder/novarelay` with this source tree. The installation URL does not work until the repository exists.
2. Install Docker Engine, Compose v2, Git, OpenSSL, tar and curl.
3. Inspect the repository's `install.sh` and `native/Dockerfile` (the latter downloads a fixed upstream MIT commit), then run:

```bash
curl -fsSL https://raw.githubusercontent.com/jmcgillcoder/novarelay/main/install.sh -o /tmp/novarelay-install.sh
sudo bash /tmp/novarelay-install.sh
curl -fsS http://127.0.0.1:8323/healthz
```

4. Use HTTPS reverse proxy to forward `https://YOUR_DOMAIN/` to `http://127.0.0.1:8323`. Change the default admin password after first login. Consider Zero Trust for `/console`.

**Do not** open port 8323 to the public; the app binds to 127.0.0.1. One may use Nginx, Caddy, Traefik, OpenResty, or an optional management panel such as 1Panel.

## Health checks

- `/healthz` checks the HTTP server itself and running version. It returns 200 even with zero 139 accounts.
- `/readyz` checks *configured usable candidates* (enabled, credentials present and not in cooldown). It can return 503 when no accounts are configured. It is **not** an authenticated 139 token check and does not perform billable inference.
- `docker ps --filter name=novarelay` and `docker logs --tail 80 novarelay` help inspect runtime failures.
- `systemctl status novarelay-updater.path` / `.service` and `journalctl -u novarelay-updater.service -n 100 --no-pager` help inspect host-side updates.

## Updates and rollback

On a standard `/opt/novarelay` installation with systemd, use **Online Updates** in the admin UI. The host service fetches only the project's pinned GitHub `main` remote; the web container has no Docker Socket. Existing service keeps running while the new image builds. The updater stops the service, snapshots `.env` and `data`, verifies the compressed backup, switches the image, checks `/healthz` version and admin session endpoint, and attempts to roll back on failure.

- The check does not prove a user's 139 session still works. Use a separate test key/account and `scripts/protocol-smoke.mjs` after the update.
- A failed update leaves logs and backups; do not repeatedly overwrite the same incident before inspecting status.
- Keeping only 5 local update archives is not off-host backup. Export encrypted offsite snapshots yourself.
- Without systemd, use the installation script for updates. Non-standard `APP_DIR` deliberately disables automatic web updates.

## Backups and restore

The backup archive contains cookies, session tokens, admin password hash, API Key hashes, price mappings and private `MASTER_KEY`. Never upload it to GitHub or send it to a chat service.

```bash
sudo bash /opt/novarelay/native/scripts/backup.sh create
bash /opt/novarelay/native/scripts/backup.sh verify /opt/novarelay/backups/manual-XXXX.tar.gz
sudo bash /opt/novarelay/native/scripts/backup.sh restore /opt/novarelay/backups/manual-XXXX.tar.gz --confirm
```

Backup creation pauses the application briefly for a consistent data snapshot. Restore validates archive structure, saves the previous data, restarts the container, and does not automatically claim that 139 authentication was recovered. Test the restored accounts and `healthz` separately.

## Ports and data

- `/opt/novarelay/native/.env`: runtime config, mode `0600`.
- `/opt/novarelay/native/data`: account credentials, hashed API Keys, logs, price catalog cache and update status, mode `0700` owner uid 10001.
- `/opt/novarelay/backups`: unencrypted root-only archives. Encrypt for offsite use.
- `127.0.0.1:8323`: gateway; old MailBridge AI may remain on 8322.
- Console login cookie is HTTP-only, SameSite=Strict, Secure by default. Use HTTPS externally.

## Deployment acceptance checklist

- `healthz` HTTP 200 with correct version and `readyz` expected status.
- Browser login works over HTTPS, can change admin password and add 139 accounts.
- Original API Key and model access confirmed after any migration.
- Model list and Chat/Responses/Messages real requests verified; tools tested separately.
- Backup creation and archive verification work; perform a controlled restore rehearsal on a nonproduction machine.
- `docker logs` rotating, host update log accessible, TLS/Cloudflare configuration correct.

No operation auto-registers or bypasses 139 web login. Unofficial upstream API changes can break this gateway.
