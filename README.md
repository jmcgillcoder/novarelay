# NovaRelay（星桥）

**NovaRelay（星桥）** 是面向 139 邮箱 AI 工作台的非官方、自托管、多账号 API 网关。本项目以独立仓库维护，面向 Linux + Docker Compose；**不需要 1Panel**，也不需要同时部署原作者的旧网关。

> **版本：v1.0.0 代码候选。** 已通过本地模拟上游的协议测试，但**尚未在真实 139 账号、Codex CLI、Claude Code 和生产 VPS 上完成端到端验收**。不能把协议转换等同于 139 模型具有原生 Claude/OpenAI 工具或推理能力。请在测试环境验证后再切换业务。

## 主要功能

- **账号与会话**：管理自己的多个 139 邮箱账号；独立子进程/凭据/Token 缓存，支持手动续期、异常提醒、暂时隔离与恢复。
- **多种 API**：OpenAI Chat Completions、Responses（文本及部分 `function` / `custom` 客户端工具）和 Anthropic Messages（文本、基础工具及 SSE 工具调用）。
- **客户端管理**：API Key 只展示一次、哈希存储、可重新生成、限额与模型白名单；按 Key / 模型显示参考费用与未定价调用。
- **Web 控制台**：可读模型名与真实模型 ID 分离、账号健康、用量趋势、请求摘要、定价候选、版本信息和更新进度。
- **长期运行**：Docker 日志轮转、断开客户端时取消上游请求、故障账号隔离、分日日志和最长 90 天留存、可选 Telegram 续期通知。
- **更新与恢复**：固定仓库的受限 systemd 更新器；新镜像先构建再切换，升级前一致性备份、压缩包校验、旧镜像回滚与健康检查；提供手动备份和恢复脚本。

## 兼容范围（不要跳过）

| 协议 | 已实现的转换 | 当前限制 |
|---|---|---|
| `GET /v1/models` | 模型列表 | 依赖 139 上游可用 |
| `POST /v1/chat/completions` | 文本、SSE、上游模拟函数调用 | 工具能力取决于模型 |
| `POST /v1/responses` | 文本、SSE、`function`、`custom`、工具结果无状态回放 | 不支持托管 `web_search/file_search/apply_patch`、`previous_response_id`、原生推理 |
| `POST /v1/messages` | Claude 文本/基础图像转换、`tool_use` 与 `input_json_delta`、结果回放 | 不支持原生思考签名、完整 Claude Code 扩展协议 |
| `POST /v1/messages/count_tokens` | 文本与工具定义的**估算**输入 Token | 不是 Anthropic 官方精确分词器，响应头 `x-139-token-count: estimated` |

**重要**：Codex 的 `custom` 自由文本工具经 JSON-schema `{input:string}` 中转；语法约束不会由上游模型原生强制。`apply_patch` 等特殊内置工具未实现，将明确返回 400，不会假装执行成功。官方 Codex 当前使用 Responses；真实 CLI 的模型元数据和工具集可能随版本变化。

## 独立安装

要求：Linux（Debian / Ubuntu 等）、Git、Docker Engine、Docker Compose v2、OpenSSL、curl、tar。安装脚本需要 root。建议通过 Nginx / Caddy / OpenResty 等提供 HTTPS 反向代理。

```bash
curl -fsSL https://raw.githubusercontent.com/jmcgillcoder/novarelay/main/install.sh -o /tmp/novarelay-install.sh
sudo bash /tmp/novarelay-install.sh
curl -fsS http://127.0.0.1:8323/healthz
```

初次启动时，管理员账号为 `admin`，随机初始密码**仅显示一次**。请立即改成自己的长密码。

- 新项目目录：`/opt/novarelay`，数据：`native/data/`，密钥：`native/.env`。
- 本机端口：`127.0.0.1:8323`（与旧项目 8322 隔离）；控制台：`https://你的域名/console`。
- 安装脚本**不会**删除、修改或迁移 `/opt/mailbridge-ai` 以及旧项目账号、API Key。请先并行验收，再考虑切换反代和迁移数据。
- **新 GitHub 仓库必须先创建并上传源码，以上链接才有效。** 仓库 URL 不存在时不要执行安装命令。

完整部署与备份说明：[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)，从旧 MailBridge AI 迁移：[docs/MIGRATION.md](docs/MIGRATION.md)。

## Codex 和 Claude Code

Codex 用户级 `~/.codex/config.toml`（Windows 为 `%USERPROFILE%\.codex\config.toml`）：

```toml
model = "blian_qwen38_max"
model_provider = "novarelay"
web_search = "disabled"

[model_providers.novarelay]
name = "NovaRelay"
base_url = "https://你的域名/v1"
wire_api = "responses"
env_key = "NOVARELAY_API_KEY"
requires_openai_auth = false
```

将自己的 API Key 放在 `NOVARELAY_API_KEY` 环境变量中，**不要将密钥写入项目仓库**。自定义模型 ID 可能需要 Codex 版本支持或本地模型目录配置；参见 [Codex 接入与已知限制](docs/CODEX.md)。

Claude Code 使用**域名根地址**（不是 `/v1/messages`），例如：

```bash
export ANTHROPIC_BASE_URL="https://你的域名"
export ANTHROPIC_API_KEY="你的独立 API Key"
export ANTHROPIC_MODEL="blian_qwen38_max"
```

详细的模型映射、环境变量与工具限制见 [Claude Code 接入](docs/CLAUDE_CODE.md)。**这里只是协议兼容层，不会将 139 模型变成真正的 Claude 模型。**

## 升级、备份、恢复

- 控制台 **在线更新**：检查新仓库 `main`，显示目标版本、进度和错误状态。标准安装目录及 systemd 支持时可用；不挂载 Docker Socket 到 Web 容器。
- 主机手动升级：再次执行上述 `install.sh`，由受限更新器进行构建、备份、短暂重启和健康检查。
- 创建备份（root）：`sudo bash /opt/novarelay/native/scripts/backup.sh create`。
- 校验备份：`bash native/scripts/backup.sh verify /path/to/backup.tar.gz`。
- 恢复前**先确认时间点与账号数据**：`sudo bash native/scripts/backup.sh restore /path/to/backup.tar.gz --confirm`。
- 备份包含 SID、Cookie、服务器密钥和 Key 哈希，只允许 root 读取；请使用加密方式保存异地副本。脚本的结构验证不等于恢复演练。

## 真正的接口验收

源码目录执行：

```bash
cd native
npm test
node --check server.mjs
```

部署后（不输出密钥或对话正文）：

```bash
export GATEWAY_BASE="https://你的域名"
export GATEWAY_API_KEY="你的客户端 Key"
export MODEL_ID="blian_qwen38_max"
node native/scripts/protocol-smoke.mjs
# 如要额外验证模型是否真正产生工具调用（会多发请求）
SMOKE_TOOL_TEST=1 node native/scripts/protocol-smoke.mjs
```

测试工具只做小规模的 API 请求；未出现工具调用时报告模型能力未验证，不会虚构成功。**上线前还需要真实 139 账号、长时间续期、Docker 运行和回滚演练。**

## 定价与数据处理

LiteLLM 目录价格按模型 ID 精确/唯一匹配，也允许管理员选择明确的供应商映射；139 专用 ID 不应随便猜价。费用为美元参考价，**不是运营商实际扣费**。Token 通常为估算，不可直接用于结算。网关不记录完整对话，保留调用元数据和必要登录会话；日志保留 90 天。

## 开源、原项目与声明

此仓库为独立维护的 **NovaRelay（星桥）**，由此前的 `jmcgillcoder/lingxi-gateway`（MailBridge AI 管理层）演进而来。139 协议引擎源自 **[chaos-cl/lingxi-gateway](https://github.com/chaos-cl/lingxi-gateway)**，遵循 MIT License，构建时拉取固定的上游提交并保留其原始许可证；**原作者权益与许可证声明保留**。另参考 [zyycn/codex-proxy-rs](https://github.com/zyycn/codex-proxy-rs) 的更新器组织思路，但未复制其代码。

详见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)、[CHANGELOG.md](CHANGELOG.md) 和 [SECURITY.md](SECURITY.md)。本项目不是中国移动、139 邮箱、OpenAI 或 Anthropic 的官方项目，不提供绕过登录验证的方法。Cookie/SID 失效后仍需在官方网站重新授权。
