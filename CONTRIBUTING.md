# Contributing

Please keep changes focused, use Chinese or English descriptive commit messages, and include protocol regression tests when changing OpenAI/Anthropic wire behavior. Run `cd native && npm test`, `node --check server.mjs`, `node --check public/app.js`, and `bash -n scripts/host-update.sh scripts/backup.sh install.sh` (from repository root use full paths).

Never include 139 SID/Cookie, real API Keys, personal emails, complete prompts, trace dumps, `.env`, or `native/data/` in commits or bug reports. Report upstream version changes with the pinned upstream commit and MIT attribution intact. Prefer incremental fixes; do not add Redis/Kubernetes/microservices without a demonstrated need.
