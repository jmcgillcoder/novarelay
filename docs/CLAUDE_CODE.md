# Claude Code compatibility

Claude Code normally calls Anthropic's **Messages** protocol. This repository translates its messages and tool events to the upstream 139 Chat Completions engine. It is an adapter, **not** native Claude inference.

## Configuration

Use the **host root URL** for `ANTHROPIC_BASE_URL`, not a URL ending in `/v1/messages`:

```bash
export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN"
export ANTHROPIC_API_KEY="YOUR_139_GATEWAY_CLIENT_KEY"
export ANTHROPIC_MODEL="blian_qwen38_max"
# Optional: point all Claude Code model tiers at the model IDs actually offered by 139.
export ANTHROPIC_DEFAULT_SONNET_MODEL="blian_qwen38_max"
export ANTHROPIC_DEFAULT_OPUS_MODEL="blian_qwen38_max"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="blian_qwen38_flash"
```

The chosen names are 139 *model IDs*. They do not make those models Claude Sonnet/Opus/Haiku. The CLI may have additional provider requirements depending on its release; do not assume every Claude Code feature is available through a custom gateway.

## Implemented

- `POST /v1/messages`: messages with text, user image URLs/base64 (if upstream supports them), non-streaming client tool definitions, tool-result replay.
- SSE `message_start`, `content_block_start`, `content_block_delta` with `text_delta` and `input_json_delta`, `content_block_stop`, `message_delta`, and `message_stop`.
- Tool-call finish reports `stop_reason: "tool_use"`, otherwise `"end_turn"`/`"max_tokens"`.
- `POST /v1/messages/count_tokens` returns a documented **estimate**, with `x-139-token-count: estimated` header. It does not call the model or charge the API Key's daily usage quota.
- Anthropic-shaped authentication, validation, and rate-limit errors for these endpoints.

## Explicit limitations

- No Anthropic-native thinking signatures (`signature_delta`), extended thinking context, or server-side Claude-native caching. Turning on unsupported thinking features may fail or provide degraded behavior.
- No server-executed tools or permission bypass. Tool use is performed by Claude Code, under *its own* permission settings.
- No real Anthropic token metering; the model and tool schema length are estimated. Reference prices from LiteLLM are not 139 billing rates.
- If SID/Cookie expires, Claude Code cannot fix the 139 session. Reauthorize the 139 account in the gateway.

Verify `SMOKE_TOOL_TEST=1 node native/scripts/protocol-smoke.mjs`; protocol compatibility tests do not establish that a specific 139 model reliably follows Claude Code's tool-use protocol.

Official event reference: https://platform.claude.com/docs/en/build-with-claude/streaming.
