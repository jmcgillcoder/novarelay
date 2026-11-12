# v1.0.0 Release acceptance checklist

## Completed locally

- [x] NovaRelay（星桥）independent source tree and MIT copyright notice
- [x] OpenAI Responses function/custom tool adapter and SSE regression tests
- [x] Claude Messages streamed tool blocks and estimated count_tokens
- [x] API Key quotas, per-Key reference fees and usage-cost labeling regression tests
- [x] Standalone Linux/Docker installer (port 8323), updated URLs, no old service mutation
- [x] Update backup validator, guarded restore, rollback health verification
- [x] 35 local Node tests, syntax checks, YAML parse and source scan

## Must still be accepted before announcing production-ready

- [ ] Create independent `jmcgillcoder/novarelay` repository and push code
- [ ] GitHub Actions Node tests and **real Docker image build** on that repository
- [ ] Deploy isolated container and check `/healthz` + `/readyz`
- [ ] Verify account login and token renewal on *your own* real 139 account
- [ ] Run `scripts/protocol-smoke.mjs` with a real key and each intended model
- [ ] Verify real Codex CLI `function/custom` tool cycle, distinguish unsupported hosted tools
- [ ] Verify real Claude Code text stream and `tool_use`/`tool_result` cycle
- [ ] Rehearse backup restore and deliberately failed update in nonproduction
- [ ] Validate HTTPS proxy, error handling and account cooldown/renewal alerts
- [ ] Inspect data permissions and backup encryption/offsite retention

Do not check the last items merely because mocked protocol tests pass. `1.0.0` is a candidate code version, not a claim of production certification.
