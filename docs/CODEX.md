# Codex CLI compatibility

## Official transport

Codex custom providers use the OpenAI **Responses** wire protocol, not the legacy Chat Completions wire. The provider URL must point to `https://YOUR_DOMAIN/v1`; all configuration goes in the **user-level** `~/.codex/config.toml` (Windows `%USERPROFILE%\.codex\config.toml`), **not** a project-local config that changes credentials.

```toml
model = "blian_qwen38_max"
model_provider = "novarelay"
web_search = "disabled"

[model_providers.novarelay]
name = "NovaRelay"
base_url = "https://YOUR_DOMAIN/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "NOVARELAY_API_KEY"
request_max_retries = 1
stream_max_retries = 0

[model_providers.novarelay.capabilities]
external_web_access = false
remote_compaction = "unsupported"
```

Set `NOVARELAY_API_KEY` in your user environment. Do **not** embed a secret in config.toml or commit the file containing credentials. Use a model ID **exactly** as listed by the gateway. Some Codex builds also require a recognized model catalog for unknown custom IDs; see official Codex model catalog documentation. Model API ID and display name are separate.

## Implemented

- `POST /v1/responses` for text, streaming text and client-executed `type:function` tools.
- `type:custom` freeform text tool bridge: internally wrapped into a Chat function with an `input:string` argument, then unwrapped to `custom_tool_call` and `custom_tool_call_output`.
- Stateless function/custom tool replay when the client resends previous call and tool-result items in the **same `input` array**.
- SSE `response.output_item.added/done`, `response.function_call_arguments.delta/done`, `response.custom_tool_call_input.delta/done`, and `response.completed/failed`.
- `store:false` is honored as a stateless design: nothing in the gateway pretends to support persistent Responses history.

## Explicit limitations

- **No native `apply_patch`**, `web_search`, `file_search`, remote shell, or other hosted Responses tool execution. A tool has to be declared and executed by the **Codex client**; the gateway never runs arbitrary commands for it.
- No `previous_response_id` server state. Feed back complete prior output items and tool results, or use a client that supports stateless Responses.
- No real OpenAI encrypted reasoning or remote compaction. Opaque reasoning history may be ignored by the adapter; this can degrade multi-step performance.
- A 139 model may output malformed/nonexistent tool calls because the upstream engine extracts tool calls from generated text. API syntax compatibility does **not** establish full Codex Agent functionality.

Run `SMOKE_TOOL_TEST=1 node native/scripts/protocol-smoke.mjs` with your own credentials to distinguish protocol errors from a model choosing not to call a tool. This tool only requests inert `echo_answer` functions; it **does not execute shell commands**.

Official references: https://learn.chatgpt.com/docs/config-file/config-reference and https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway.
