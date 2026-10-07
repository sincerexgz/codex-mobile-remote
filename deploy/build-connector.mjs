import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts=path.join(root,'deploy','artifacts');
const stage=path.join(artifacts,'connector-package');
fs.rmSync(stage,{recursive:true,force:true});
fs.mkdirSync(path.join(stage,'runtime'),{recursive:true});
for(const name of ['启动配对.bat','start-pairing.ps1','pair-agent.mjs','app-agent.js','desktop-client.mjs','connector-service.mjs','停止连接.bat','connector-startup.vbs','connector-autostart.ps1','开启自动启动.bat','关闭自动启动.bat']) {
  fs.copyFileSync(path.join(root,name),path.join(stage,name));
}
// Public packages require a separately installed Node.js 22+ runtime.
fs.cpSync(path.join(root,'node_modules','ws'),path.join(stage,'node_modules','ws'),{recursive:true});
fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'codex-desktop-connector',private:true,type:'module',engines:{node:'>=22'},dependencies:{ws:'8.22.0'}},null,2)+'\n');
fs.writeFileSync(path.join(stage,'使用说明.txt'),`Codex 远程电脑连接器（Windows）

1. 将压缩包完整解压到自己的电脑。
2. 安装 Node.js 22+，并安装、登录桌面 Codex。
3. 双击“启动配对.bat”，首次填写自己的服务器地址及 REGISTRATION_KEY，然后获取手机配对码。
4. 在手机 App 顶部“连接”中填写同一个服务器地址，然后输入配对码。
5. 电脑保持开机联网，连接器在后台运行，窗口可以关闭。

无需注册账号，四位数字配对码 10 分钟有效且只能使用一次。
每台电脑单独解压一份干净的压缩包。请勿分享运行后生成的 .device-connection.json，它包含这台电脑的连接密钥。

关闭窗口不会断开连接。下次启动自动恢复配对，无需重新输入。
如需暂时断开，请双击“停止连接.bat”；配对仍会保留。电脑重启并登录 Windows 后会自动在后台启动，无需再打开窗口。
更新连接器时请覆盖原文件夹，保留 .device-connection.json。

“停止连接.bat”会暂停后台，并暂停之后的自动连接；重新运行“启动配对.bat”即可恢复。
运行“关闭自动启动.bat”可取消登录自启。
手机指令通过桌面 Codex 自身的消息接口提交并启动任务；桌面正在工作时由桌面处理追加指令。桌面 Codex 需要运行并登录。

窗口操作：1 生成新码；2 查看手机；d1 或 d2 解除对应手机；3 解除全部手机；s 停止后台；q 关闭窗口。

若提示云端仍是旧版中继，需要服务器维护者更新配对服务。
若提示电脑连接凭据被拒绝，请检查服务器配对记录，保留现有 .device-connection.json 以便恢复。
如果提示找不到 Codex，请先安装并登录桌面 Codex，再重新打开连接器。
`,'utf8');
const zip=path.join(artifacts,'Codex-电脑连接器-Windows.zip');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',`$ErrorActionPreference='Stop'; Compress-Archive -Path ${quote(path.join(stage,'*'))} -DestinationPath ${quote(zip)} -CompressionLevel Optimal -Force`],{stdio:'inherit'});
fs.rmSync(stage,{recursive:true,force:true});
console.log('Connector saved: '+zip);
console.log('SHA256: '+crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'));
