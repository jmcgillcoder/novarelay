# NovaRelay 实例间数据迁移

本文仅适用于 **NovaRelay 实例之间**的账号、API Key 和定价数据转移，不代表兼容任意其他产品的数据格式。

NovaRelay 将登录凭据、令牌缓存、API Key 哈希和统计数据保存在 `native/data`，并在 `native/.env` 中保留服务器 `MASTER_KEY`。必须一起保护和转移它们，否则部分加密凭据可能无法解密。

## 推荐步骤：使用内置备份与恢复工具

1. 在来源服务器上停止写入，并创建一致性快照：

```bash
sudo bash /opt/novarelay/native/scripts/backup.sh create
```

2. 将生成的 `.tar.gz` 备份包通过加密通道转移到目标服务器；**不要上传至公开仓库、网盘分享链接或聊天消息**。
3. 在目标服务器先安装相同版本的 NovaRelay，并对现有数据制作备份（即使是空实例也需要备份）。
4. 在目标服务器验证并恢复来源备份（请换成实际备份文件路径）：

```bash
sudo bash /opt/novarelay/native/scripts/backup.sh create
bash /opt/novarelay/native/scripts/backup.sh verify /secure/path/source-backup.tar.gz
sudo bash /opt/novarelay/native/scripts/backup.sh restore /secure/path/source-backup.tar.gz --confirm
```

5. 验证 `http://127.0.0.1:8323/healthz`、后台管理员登录、139 账号连接状态和 API Key 的模型访问权限。**不要在确认迁移成功前删除来源数据**。

## 注意事项

- 恢复包含整个配置和账号数据库，会覆盖目标实例的管理员密码、API Key、模型设置和相关记录。需要保留目标配置时，不要使用整包恢复。
- 恢复来源的 `.env` 后，核对 `PORT=8323`、`HOST=127.0.0.1` 和反向代理设置。
- 同一账号的登录会话不保证适合在两个服务器长期同时续期，建议迁移确认后停止来源实例的账号自动刷新。
- 备份结构验证不证明 Cookie 或 SID 仍然有效。凭据失效时需要重新在官方网站完成授权。
