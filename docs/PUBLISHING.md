# 上传 GitHub

只上传本目录 codex-mobile-remote 的内容。不要上传它的父目录，也不要使用原工程的 .git；这份副本没有旧提交历史。

推荐仓库名 codex-mobile-remote，描述：Self-hosted mobile access to your paired Windows Codex desktop. 项目许可证已经选择 MIT。

## 网页上传

1. GitHub 新建 Public 仓库，不自动生成 README 或许可证。
2. 解压源码包，进入 codex-mobile-remote 文件夹。
3. 用网页 Upload files 上传里面的文件与目录；需要保留 .gitignore 等隐藏文件。本副本超过 100 个文件，网页上传可分两批提交；或使用下方 Git 命令一次上传。不要把 ZIP 本身作为唯一的仓库文件。

## Git 上传

在本目录打开 PowerShell，将下方 YOUR_USER 替换为你的 GitHub 用户名：

```powershell
git init
git add .
git status --short
git commit -m "Initial open source release"
git branch -M main
git remote add origin https://github.com/YOUR_USER/codex-mobile-remote.git
git push -u origin main
```

发布前查看 git status，确认没有个人配置、运行数据、安装包或密钥文件。公开仓库后，在 Settings → Security 中启用私密漏洞报告与可用的 secret scanning。

## GitHub Release

先发布源码即可。以后在这份源码中重新构建 APK 和连接器，再作为 Release 附件上传。不要上传个人版本旧 APK、已运行的连接器文件夹或云端数据备份。公开版本需自建服务器，不提供作者个人中继地址；发布说明应包含内部桌面接口的兼容性限制。
