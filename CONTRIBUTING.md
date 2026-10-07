# 贡献指南

感谢参与 Codex Mobile Remote。

## 提交前

- 先阅读 `README.md`、`SECURITY.md` 和相关部署文档。
- 不要提交服务器密钥、手机令牌、配对记录、聊天快照、日志、签名文件或完整远程链接。
- 涉及服务器协议、配对鉴权或 Android 原生桥接的改动，请在 Pull Request 中说明兼容性影响。

## Pull Request

请在描述中包含：

- 改动目的和用户场景
- 影响的组件：中继、Windows 连接器、网页或 Android App
- 手动验证步骤
- 是否需要迁移配置或重新配对
- 是否可能受 Codex 桌面版本变化影响

小范围修复请保持提交集中。不要把构建生成的 `node_modules`、APK、压缩包、Android build 目录或服务器状态文件加入提交。

## 兼容性

Windows 连接器调用桌面 Codex 的内部本机接口。修改 `desktop-client.mjs` 或 `app-agent.js` 时，请说明使用的 Codex 桌面版本和接口响应变化。不要新增公网调试端口来绕过接口限制。

## 安全问题

不要在 Issue 或 Pull Request 中公开报告可利用细节。请按 `SECURITY.md` 的方式提交私密安全报告。

