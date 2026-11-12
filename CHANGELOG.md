# Changelog

## 1.0.0 (NovaRelay / 星桥, independent repository candidate)

- New brand: **NovaRelay（星桥）**; independent source tree / runtime name: `novarelay`, port 8323, data `/opt/novarelay/native/data`; no mutation of legacy MailBridge AI.
- Anthropic Messages streamed tool_use with `input_json_delta`, text streaming and estimated `messages/count_tokens`.
- OpenAI Responses: function tools and Codex-style custom freeform tool mapping, tool result replay and matching SSE events. Non-native capabilities return explicit errors.
- Separate liveness (`/healthz`) and approximate readiness (`/readyz`), cancel orphaned upstream requests, 45s container stop grace, rotating Docker logs.
- New guarded backup creation, archive validation and restore script; updater now validates backups and checks rollback health.
- 24-character random initial admin password, Anthropic error response envelopes, API-Key usage and reference-cost dashboard retained.
- Full docs, standalone protocol smoke test and release checks; original upstream MIT attribution retained.

## 0.6.0 (previous MailBridge AI codebase)

- Responses function tool adaptation, model display names, per-Key reference fees, general Docker UI.

This changelog does not claim completion of live production validation.
