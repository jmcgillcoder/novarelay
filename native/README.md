# NovaRelay / Node backend

Node.js 22 原生实现，无额外 npm 运行依赖。部署说明请见根目录 [README](../README.md) 与 [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)。

- `server.mjs`：用户 API、会话认证、权限、管理后台。
- `lib/embedded.mjs` + `child.mjs`：每个 139 账号独立上游进程。
- `lib/responses.mjs`：OpenAI Responses function/custom 工具转换。
- `lib/anthropic.mjs` / `lib/anthropic-stream.mjs`：Anthropic Messages 与工具 SSE。
- `lib/storage.mjs`：原子化配置、按日调用日志及 API Key 统计。
- `scripts/host-update.sh`：systemd 限定更新和尽力回滚。
- `scripts/backup.sh`：一致性备份、结构校验和受保护的恢复。
- `scripts/protocol-smoke.mjs`：真实上游协议验收（不会泄露 API Key）。

```bash
npm test
node --check server.mjs
node --check lib/anthropic-stream.mjs
```

**注意：** CI 通过只说明模拟协议通过，不证明真实 139 网关原生支持 Codex/Claude Code 的特殊工具与推理。Docker 镜像构建需要从 chaos-cl 原仓库拉取固定提交；离线环境不可构建。
