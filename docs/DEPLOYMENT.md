# 自建中继部署

建议 Ubuntu 22.04/24.04，2 核 2GB 以上。域名 A 记录指向自己的服务器，放行 80/443；SSH 仅允许维护者访问。不要开放 8787。脚本需 root，会安装 Node.js 22、Nginx、Certbot，创建独立服务与目录；请先检查已有网站和配置。

## 安装

在服务器下载此仓库，进入仓库目录：

```bash
npm ci --omit=dev
sudo bash deploy/install.sh prepare remote.example.com
sudo bash deploy/install.sh https remote.example.com
```

替换示例域名为自己的域名。https 阶段会接受 Let's Encrypt 服务协议并申请证书，请先阅读其服务协议；续期定时器每小时检查。公网 IP 证书取决于证书机构支持 shortlived 配置，推荐优先使用域名。

## 首次登记访问密钥

安装器生成 `/etc/codex-mobile-remote.env`，权限 0600，其中 REGISTRATION_KEY 是随机密钥。只在电脑首次登记时提供给连接器；配对完成后电脑使用独立 agentKey，手机使用独立手机令牌。

在私密终端执行 `sudo cat /etc/codex-mobile-remote.env` 查看密钥。不要将输出、截图或这个文件上传 GitHub。Windows 双击“启动配对.bat”填写地址和此密钥；手机填写同一地址和四位码即可。

如果更新已有服务器且 env 中没有 REGISTRATION_KEY，请生成至少 32 字符的随机值并添加，再重启服务。保留原有 AGENT_KEY、REMOTE_TOKEN 和服务器数据目录，原有配对无需重新登记。

## 运行与数据

- 服务：`sudo systemctl status codex-remote-relay nginx codex-cert-renew.timer`
- 日志：`sudo journalctl -u codex-remote-relay -n 50`
- 健康：`https://你的域名/api/health`
- 数据：`/var/lib/codex-mobile-remote`，含电脑/手机令牌摘要和聊天快照，私密备份且不要提交。
- 更改 env 后：`sudo systemctl restart codex-remote-relay`

中继监听 127.0.0.1:8787，由 Nginx 终止 HTTPS。四位配对码、首次登记、配对码生成已有速率限制；最多 32 台电脑、每台 8 个手机。服务器访问密钥防止外人直接登记电脑，但不等于防 DDoS 服务。只向可信使用者分发密钥，不开放匿名公共服务。

若不使用安装器，也可复制 .env.example 到 .env，填写随机 REGISTRATION_KEY，运行 npm start；仍须自行配置受信任 HTTPS、服务管理、数据权限及反向代理。代理必须覆盖 X-Real-IP，不要让外部客户端自定义该请求头。
