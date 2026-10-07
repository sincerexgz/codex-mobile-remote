# GitHub 发布文案

以下内容可以直接粘贴到 GitHub 的仓库设置、首个 Release 和项目页面。

## 仓库名称

`codex-mobile-remote`

## 仓库描述

`Self-hosted mobile access to your paired Windows Codex desktop through an Android app or browser.`

## Topics

`codex` `android` `capacitor` `self-hosted` `remote-desktop` `mobile-web` `windows` `websocket` `nodejs` `typescript`

## About / 网站

如果已经有项目主页或文档站点，填写自己的地址；没有时留空，不要填写个人服务器访问链接。

## 首屏简介

```text
用手机 Android App 或浏览器访问自己配对的 Windows Codex 桌面会话。

项目采用自建中继模式，不提供公共服务器。电脑通过出站 WSS 连接中继，手机通过 HTTPS 读取会话快照并发送后续指令。无需独立账户，使用四位配对码连接自己的电脑。
```

## 首个 Release

### 标题

`v1.2.2 · 首个自建开源版本`

### Tag

`v1.2.2`

### Release 正文

```markdown
## Codex Mobile Remote v1.2.2

这是 Codex Mobile Remote 的首个自建开源版本。它允许你通过 Android App 或手机浏览器访问自己配对的 Windows Codex 桌面端。

> 这是第三方项目，与 OpenAI 无官方关联。项目不提供公共中继服务器；使用前请部署自己的 HTTPS 中继。

### 功能

- 查看近期 Codex 对话和任务结果，历史快照约每 5 秒同步。
- 从手机发送后续指令，由桌面 Codex 自身接口启动或继续任务。
- 使用四位、一次性的电脑配对码，无需创建独立账户。
- 关闭连接器管理窗口后继续后台运行，Windows 登录后自动恢复。
- 每台电脑拥有独立的电脑凭据、手机配对和会话缓存。
- 支持 Android App 和浏览器访问。

### 下载

- `Codex-Remote-debug.apk`：源码构建的调试 APK，仅供个人测试。
- `Codex-Remote-release.apk`：使用发布者自己的签名构建时再提供。
- `Codex-电脑连接器-Windows.zip`：Windows 连接器源码打包文件。

当前 Release 不附带作者个人服务器地址、手机令牌、电脑配对记录或发布签名密钥。使用者需要部署自己的中继并在 App 中填写自己的 HTTPS 地址。

### 快速开始

1. 按仓库 `docs/DEPLOYMENT.md` 部署自己的 Ubuntu 中继和 HTTPS 域名。
2. 在 Windows 安装 Node.js 22+，安装并登录 Codex 桌面端。
3. 运行 `启动配对.bat`，填写自己的服务器地址和 `REGISTRATION_KEY`。
4. 在手机 App 的“连接”页面填写相同的服务器地址和电脑配对码。
5. 保持电脑联网并运行桌面 Codex，即可查看对话和发送指令。

完整构建步骤见 `docs/BUILD.md`。公开发布前请阅读 `SECURITY.md`。

### 已知限制

- Windows 连接器使用桌面 Codex 的内部本机消息接口，不是稳定的公共 API。桌面 Codex 更新后可能需要适配。
- 历史内容是延迟同步的快照，不承诺完整实时镜像。
- 中继可以读取并缓存转发的聊天和指令，只适合自建服务器或可信小组。
- 四位配对码和速率限制不能替代防火墙、WAF 或 DDoS 防护。
- Android App 需要使用者自行构建或安装与自己服务器匹配的版本。

### 校验

发布者应在此处填写上传附件的 SHA-256：

```text
Codex-Remote-debug.apk: <SHA256>
Codex-电脑连接器-Windows.zip: <SHA256>
```

### 许可证

原创代码采用 MIT 许可证。第三方依赖按各自许可证使用，详见 `THIRD_PARTY_NOTICES.md`。
```

## Release 附件说明

上传附件时建议使用这些文件名：

```text
Codex-Remote-debug.apk
Codex-电脑连接器-Windows.zip
codex-mobile-remote-source-v1.2.2.zip
```

不要上传：

- 个人服务器配置或访问链接
- `.env`、`server.env`、`connector-config.json`
- `.device-connection.json`、手机配对码和服务器状态目录
- APK 签名文件、keystore、签名密码
- 运行日志、聊天缓存和个人截图
- 当前个人服务器正在使用的旧 APK

## GitHub Discussions 欢迎帖

### 标题

`欢迎使用 Codex Mobile Remote：先看这里`

### 正文

```markdown
欢迎使用 Codex Mobile Remote。

这是一个面向自建服务器的第三方工具，用 Android App 或手机浏览器访问自己配对的 Windows Codex 桌面端。项目不提供公共中继，也不要求使用者把 Codex 登录凭据交给服务器。

开始前请依次阅读：

1. `README.md`：功能、架构和限制
2. `docs/DEPLOYMENT.md`：部署自己的中继
3. `docs/BUILD.md`：构建 APK 和 Windows 连接器
4. `SECURITY.md`：令牌、配对和服务器安全

提问时请提供：

- Windows、Node.js、Android 和 Codex 桌面版本
- 使用的是源码构建还是 Release 附件
- 脱敏后的错误信息和复现步骤

请不要公开完整手机链接、配对码、REGISTRATION_KEY、访问令牌、Codex 配置或原始日志。
```

## Issue 模板文字

### Bug 标题前缀

`[Bug] `

### Bug 提交说明

```markdown
请先确认：

- [ ] 我使用的是自己的 HTTPS 中继，而不是公共服务器。
- [ ] 我已经阅读了 README 和 SECURITY.md。
- [ ] 我已删除令牌、配对码、服务器地址中的敏感参数和原始日志。

环境：

- 项目版本或 commit：
- Windows 版本：
- Codex 桌面版本：
- Node.js 版本：
- Android 版本（如适用）：

复现步骤：

预期行为：

实际行为：

脱敏后的错误信息：
```

### Feature Request 标题前缀

`[Feature] `

### Feature Request 提交说明

```markdown
功能需求：

使用场景：

当前的替代方案：

是否愿意协助实现：
```

## GitHub 仓库设置文字

### Security policy 摘要

```text
请不要在公开 Issue 中提交访问令牌、配对码、REGISTRATION_KEY、完整远程链接、Codex 配置或原始日志。安全问题请使用 GitHub Security Advisory 私密报告。
```

### 自动回复文字

```text
感谢报告问题。请先确认问题可以在最新 commit 或最新 Release 中复现，并删除所有凭据、完整链接和个人聊天内容。连接器依赖桌面 Codex 内部接口，桌面版本信息是诊断所必需的。
```

## 仓库首页短句

```text
自建中继，配对自己的电脑，手机访问 Windows Codex 桌面会话。
```

## 社交分享文字

### 标题

`Codex Mobile Remote · 手机访问自己的 Windows Codex 桌面`

### 描述

`一个面向自建服务器的第三方 Android/Web 客户端，通过安全配对连接自己的 Windows Codex 桌面。`

### 说明

公开分享时不要附带个人服务器地址、手机访问链接或截图中的令牌。建议分享仓库地址和部署文档地址。

