# Security policy

The project is an unofficial gateway that handles high-value 139 web SID/Cookie credentials and API keys. It should be deployed behind HTTPS; additionally consider VPN, IP allow-list, or Zero Trust protection for `/console`.

- `native/.env`, `native/data/`, and update/backups archives **must never be committed or publicly shared**. `MASTER_KEY` is necessary for decrypting legacy external upstream secrets. Lost secrets cannot be reconstructed from key hashes.
- Built-in API Keys are stored as SHA-256 hashes, and only displayed at creation / rotation. Never ask users to submit their tokens or passwords to public issues.
- Backup archives include authentication sessions and service keys. They are root-only by default, **not encrypted**. Encrypt them before transferring to offsite storage.
- Bind gateway to `127.0.0.1`, publish externally only with TLS termination, and avoid exposing Docker socket or 139 child ports.
- The pinned upstream engine is not controlled by this repository; audit it before bumping the SHA.
- Offline integration tests use a mock 139 engine; malicious token/session edge cases need real-world acceptance testing.
- Never post a log that contains headers, Cookie, SID, API Key, or `native/data/accounts/` contents.

Report potentially exploitable issues through a private GitHub security advisory on the project repository when available, rather than posting sensitive PoCs publicly.
