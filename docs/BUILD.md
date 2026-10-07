# 构建安装包

## Windows 连接器

安装 Node.js 22+，在仓库根目录运行：

```powershell
npm.cmd ci
npm.cmd run build:connector
```

输出 deploy/artifacts/Codex-电脑连接器-Windows.zip。公开包不附带 Node 可执行文件，使用者需要自行安装 Node.js。仅打包源码和 ws 依赖，不复制运行后的配对记录、服务器访问密钥、日志和聊天。

## Android APK

安装 Node.js 22+、JDK 21+、Android Studio。通过 SDK Manager 安装 Android SDK Platform 36、Build Tools 35.0.0，并自行接受 Google SDK 协议。设置 JAVA_HOME 与 ANDROID_HOME（脚本默认查找当前用户的 Android/Sdk）。

```powershell
cd mobile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File build-apk.ps1
```

输出 mobile/artifacts/Codex-Remote-debug.apk，使用 Android 调试签名，仅供个人试用。也可以直接用 Android Studio 打开 mobile/android。首次构建会下载 Gradle 和依赖。中国网络可添加 -UseMirror，使用脚本指定的 HTTPS Maven 镜像。

## 发布签名

创建自己的 mobile/.signing/codex-remote.jks（使用 keytool 或 Android Studio），将 mobile/.signing/signing.properties 写为：

```properties
storePassword=YOUR_STORE_PASSWORD
keyAlias=YOUR_KEY_ALIAS
keyPassword=YOUR_KEY_PASSWORD
```

再运行 build-apk.ps1 -Release，生成 release APK。密码和 keystore 均不能提交仓库；安全备份签名密钥，后续升级必须使用同一签名。公开源码不包含原个人 APK 的签名密钥，因此自行构建的 APK 通常不能直接覆盖原个人 APK。

不要发布当前个人目录中的旧 APK：它默认连接个人服务器。请在这份干净源码中重新构建公开安装包。手机必须手动填写自己的 HTTPS 中继地址；构建产物默认没有服务器地址。
