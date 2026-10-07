# Codex Mobile Remote

通过手机 Android App 或浏览器读取并继续自己的 Windows Codex 桌面对话。无需独立账户，配对自己的电脑即可使用。

这是第三方项目，与 OpenAI 无官方关联。默认自建中继，不提供公共服务器。

## 功能

- 手机查看近期对话与执行结果，历史快照约每 5 秒同步。
- 发送指令由桌面 Codex 自身处理；空闲时启动任务，忙碌时处理追加指令。
- 四位配对码，10 分钟有效，一次使用；手机凭据保存在 Android Keystore 保护的本地存储中。
- 关闭电脑管理窗口后后台保持连接；Windows 登录后自动恢复。手动停止会暂停后续自动连接。
- 每台电脑有独立的连接凭据、手机配对和会话缓存。

## 工作方式

手机 → HTTPS → 自建中继 ← WSS 出站连接 ← Windows 连接器 ↔ 桌面 Codex

中继能读取转发的聊天与指令，并存储近期聊天快照。它不接收 Codex API 登录凭据，但手机配对令牌能够控制相应桌面会话。

## 快速开始

1. 准备 Node.js 22+、自己的 Ubuntu 服务器与 HTTPS 域名，按 [部署说明](docs/DEPLOYMENT.md) 启动中继。
2. Windows 上安装并登录 Codex 桌面端，在仓库根目录运行 `npm.cmd ci`。
3. 双击 `启动配对.bat`，首次输入自己的服务器地址和服务器 REGISTRATION_KEY。此密钥只供电脑首次登记使用，手机只需服务器地址和四位配对码。
4. 按 [Android 构建说明](docs/BUILD.md) 生成并安装 APK，在 App 的“连接”页面填写相同的 HTTPS 服务器地址与配对码。
5. 电脑保持开机联网，桌面 Codex 保持运行。手机即可选择项目、查看结果和发送后续指令。

浏览器模式：配对后可使用自己的手机令牌打开 `https://你的域名/chat?token=你的手机令牌`。该完整链接等同于访问凭据，不能公开。Android App 的令牌不通过 JS 显示；常规使用推荐 APK。

## 项目结构

- `relay-pairing.js`：电脑登记、配对、令牌鉴权与中继。
- `relay-session.js`：每台电脑的聊天缓存和发送确认。
- `app-agent.js`、`desktop-client.mjs`：本地历史同步、桌面消息接口。
- `pair-agent.mjs`、`connector-service.mjs`：配对管理与后台连接。
- `public/`：手机聊天网页；`mobile/`：Capacitor Android App。
- `deploy/`：部署与连接器打包脚本。

## 兼容性与边界

Windows 连接器依赖桌面 Codex 的内部本机消息接口，不是 OpenAI 承诺稳定的公共 API。当前个人环境已确认手机发送可触发桌面回复；桌面版本更新可能需要适配。历史展示是近期快照，不是完整实时镜像。首次登记访问密钥需要妥善保管；此版本面向个人或可信小组，不面向匿名公共中继服务。

首次配对前无需把 Codex API Key 配置到中继，也不要上传自己的 Codex 配置目录。

## 文档

- [自建部署](docs/DEPLOYMENT.md)
- [构建 APK 与连接器](docs/BUILD.md)
- [上传 GitHub](docs/PUBLISHING.md)
- [安全说明](SECURITY.md)
- [更新记录](CHANGELOG.md)
- [第三方依赖声明](THIRD_PARTY_NOTICES.md)

## 许可证

项目原创代码采用 MIT 许可证，第三方库按各自许可证分发。
