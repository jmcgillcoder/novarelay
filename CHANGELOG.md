# Changelog

## 1.0.0 — NovaRelay（星桥）

- 发布独立品牌的 NovaRelay 自托管 AI API 网关：Docker Compose 服务，默认端口 8323，配置及数据位于 `/opt/novarelay/native/`。
- 实现 Anthropic Messages 流式 `tool_use`、`input_json_delta`、文本输出和 `messages/count_tokens` 估算接口。
- 实现 OpenAI Responses 的 `function`、`custom` 工具转换、工具结果回放和对应 SSE 事件，不支持的能力明确返回错误。
- 提供 `/healthz`、`/readyz`、客户端断连后取消上游请求、Docker 日志轮转、故障账号隔离和自动续期状态。
- 增加备份创建、归档验证、受控恢复，以及升级失败后的回滚检查。
- 提供 24 位随机初始管理员密码、API Key 用量统计、参考费用、模型名称显示和 Web 管理后台。
- 提供部署说明、Codex / Claude Code 接入指南、协议自检工具与自动化测试。
- 按照 MIT 许可保留上游协议引擎作者 **chaos-cl** 的署名与许可证。

> 流式工具协议测试为模拟上游测试；真实账号、Codex CLI、Claude Code 的端到端验收仍需在目标环境完成。
