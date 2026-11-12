# Migrating from MailBridge AI v0.6.0

**Never point the new project at the old application's live `native/data` directory.** The new repository, service, and port are deliberately independent. The old service remains untouched unless you explicitly stop it.

## Safe option: fresh accounts and API Keys

Install NovaRelay on port 8323, open its separate HTTPS test domain and import your own 139 login credentials again. Create new API Keys and verify all three protocols. Keep MailBridge AI on port 8322. After clients are switched, retire the old service manually. This has the least data-corruption risk.

## Preserve existing keys, accounts and prices (manual maintenance window)

1. Record current old and new `healthz` versions, and back up both apps including their `.env` and `data`. Do not upload the archives to the Internet.
2. Stop both gateway containers before copying state. Do not copy from an app that is actively changing `state.json` or JSONL logs.
3. On the Linux host, as root (verify paths before running):

```bash
sudo docker compose -f /opt/mailbridge-ai/native/compose.yml stop gateway
sudo docker compose -f /opt/novarelay/native/compose.yml stop gateway
sudo cp -a /opt/novarelay/native/data /opt/novarelay/native/data.before-migration
sudo cp /opt/novarelay/native/.env /opt/novarelay/native/.env.before-migration
sudo cp -a /opt/mailbridge-ai/native/data/. /opt/novarelay/native/data/
sudo cp /opt/mailbridge-ai/native/.env /opt/novarelay/native/.env
sudo sed -i 's/^PORT=.*/PORT=8323/' /opt/novarelay/native/.env
sudo chmod 600 /opt/novarelay/native/.env
sudo chown -R 10001:10001 /opt/novarelay/native/data
sudo docker compose -f /opt/novarelay/native/compose.yml up -d --no-deps gateway
curl -fsS http://127.0.0.1:8323/healthz
```

4. Verify account states, existing client API Keys, reference prices and model calls. **Do not remove the previous app** before recovery has been tested. The two services should not both continuously refresh a copied session without testing upstream rules; restart the old service only if you need to roll back to it.

**Why copy `.env`?** It contains `MASTER_KEY`; an old external upstream secret may be encrypted with this key. Copying only `data/` can make old secrets undecipherable. The `PORT` line must be changed to 8323 before launching the new service.

Migration from *other* old versions or modified schemas is not automatically supported. Check first and restore from your backups if necessary.
