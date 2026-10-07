import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const parameter=name=>{const index=args.indexOf(name);return index<0 ? null : args[index+1];};
let connectorConfig={};
try { connectorConfig=JSON.parse(fs.readFileSync(path.join(root,'connector-config.json'),'utf8')); } catch {}
let savedIdentity={};
try { savedIdentity=JSON.parse(fs.readFileSync(path.join(root,'.device-connection.json'),'utf8')); } catch {}
const chosenServer=parameter('--server') || process.env.PAIR_SERVER || connectorConfig.server || savedIdentity.origin;
if (!chosenServer) throw new Error('请先运行启动配对.bat，填写自己部署的 HTTPS 服务器地址。');
const registrationKey=process.env.REGISTRATION_KEY || connectorConfig.registrationKey || '';
const server=new URL(chosenServer);
if (server.protocol!=='https:' || server.username || server.password || server.search || server.hash || (server.pathname!=='/' && server.pathname!=='')) throw new Error('请使用 HTTPS 服务器地址。');
const origin=server.origin;
const identityFile=path.join(root,'.device-connection.json');
const pausedFile=path.join(root,'.connector-paused');
let identity;
let input;
let renewing;
let exiting=false;
let busy=false;
let revokedSelection=null;

async function request(route,method='GET',body,authenticated=true) {
  const response=await fetch(origin+route,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',...(route==='/api/devices/register' ? {'x-registration-key':registrationKey} : {}),...(authenticated ? {Authorization:`Bearer ${identity.agentKey}`} : {})},body:body===undefined ? undefined : JSON.stringify(body)});
  const data=await response.json();
  if (!response.ok) {
    const message=response.status===401
      ? (authenticated ? '电脑连接凭据被服务器拒绝，请确认服务器配对记录仍在。' : '服务器拒绝了首次登记，请联系维护者检查配对服务。')
      : data.error || `服务器返回 ${response.status}`;
    const error=new Error(message);
    error.status=response.status;
    throw error;
  }
  return data;
}
async function newCode() {
  let invitation;
  let lastError;
  for (let attempt=0; attempt<15; attempt++) {
    try { invitation=await request('/api/devices/pair-code','POST',{}); break; }
    catch (error) {
      if (error.status && error.status!==409 && error.status<500) throw error;
      lastError=error;
      if (attempt<14) await new Promise(resolve=>setTimeout(resolve,2000));
    }
  }
  if (!invitation) throw lastError || new Error('电脑连接器尚未连上服务器。');
  console.log(`\n电脑：${invitation.device.name}\n手机配对码： ${invitation.code}\n有效期 10 分钟，使用一次后失效。\n在手机 App 输入此配对码，无需登录账号。`);
  console.log('操作：1 生成新码；2 查看手机；3 解除全部配对；s 停止后台；q 关闭窗口。\n');
  fs.writeFileSync(path.join(root,'手机配对码.txt'),`电脑：${invitation.device.name}\n服务器：${origin}\n配对码：${invitation.code}\n过期时间：${new Date(invitation.expiresAt).toLocaleString()}\n此码只能使用一次。\n`,{mode:0o600});
  clearTimeout(renewing);
  renewing=setTimeout(()=>newCode().catch(error=>console.error('配对码续期失败，请输入 1 重试：'+error.message)),9*60000);
}
async function showPhones() {
  const result=await request('/api/devices/phones');
  console.log(`\n电脑${result.connected ? '在线' : '离线'}，已配对 ${result.phones.length} 个手机。`);
  result.phones.forEach((phone,index)=>console.log(`${index+1}. ${phone.name}（${new Date(phone.pairedAt).toLocaleString()}）`));
  if (result.phones.length) { revokedSelection=result.phones; console.log('输入 d1 解除第 1 个手机，d2 解除第 2 个，以此类推。'); }
}
async function onInput(line) {
  const value=line.trim().toLowerCase();
  if (value==='q') return shutdown();
  if (busy || !value) return;
  busy=true;
  try {
    if (value==='s') {await stopService();return shutdown();}
    else if (value==='1') await newCode();
    else if (value==='2') await showPhones();
    else if (value==='3') {await request('/api/devices/revoke','POST',{all:true});console.log('所有手机配对已解除。');await newCode();}
    else if (/^d[1-8]$/.test(value) && revokedSelection?.[Number(value.slice(1))-1]) {
      await request('/api/devices/revoke','POST',{phoneId:revokedSelection[Number(value.slice(1))-1].id});await showPhones();
    } else console.log('请输入 1、2、3、s 或 q。');
  } catch(error) {console.error('操作失败：'+error.message);}
  finally {busy=false;}
}
function shutdown() {
  if (exiting) return;
  exiting=true; clearTimeout(renewing); input?.close();
  try { fs.unlinkSync(path.join(root,'手机配对码.txt')); } catch {}
  setTimeout(()=>process.exit(0),300);
}
const runtimeFile=path.join(root,'.connector-runtime.json');
const lockFile=path.join(root,'.connector-service.lock');
async function localService(route='/status',method='GET') {
  const runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
  if(!Number.isInteger(runtime.port)||runtime.port<1||runtime.port>65535||!runtime.secret) throw new Error('后台信息无效。');
  const response=await fetch(`http://127.0.0.1:${runtime.port}${route}`,{method,signal:AbortSignal.timeout(2000),headers:{Authorization:'Bearer '+runtime.secret}});
  if(!response.ok) throw new Error('后台连接器未响应。');
  return response.json();
}
async function ensureService() {
  try {await localService();return;} catch {}
  if(fs.existsSync(lockFile)) {
    const pid=Number(fs.readFileSync(lockFile,'utf8'));
    let alive=false;
    const fromPreviousBoot=fs.statSync(lockFile).mtimeMs < Date.now()-os.uptime()*1000-5000;
    if(!fromPreviousBoot && Number.isInteger(pid)&&pid>0) {try{process.kill(pid,0);alive=true;}catch{}}
    if(!alive) {fs.unlinkSync(lockFile);try{fs.unlinkSync(runtimeFile);}catch{}}
  }
  const background=spawn(process.execPath,[path.join(root,'connector-service.mjs')],{cwd:root,detached:true,stdio:'ignore',windowsHide:true});
  background.unref();
  for(let attempt=0;attempt<30;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,300));
    try{await localService();return;}catch{}
  }
  throw new Error('后台连接器启动失败，请查看 connector.log。');
}
async function stopService() {
  fs.writeFileSync(pausedFile,'paused');
  try {await localService('/stop','POST');console.log('后台连接已停止，配对记录已保留。下次启动会自动恢复。');}
  catch {console.log('后台连接器已停止。');}
}
if(args.includes('--stop')) {await stopService();process.exit(0);}
if(args.includes('--background')) {
  if(!fs.existsSync(identityFile) || fs.existsSync(pausedFile)) process.exit(0);
  await ensureService();process.exit(0);
}
try {
  try {fs.unlinkSync(pausedFile);} catch {}
  const health=await request('/api/health','GET',undefined,false);
  if (!health.ok || !(health.pairingVersion>=2)) throw new Error('云端仍是旧版中继，请先更新服务器的四位配对与发送确认服务。');
  if (fs.existsSync(identityFile)) {
    identity=JSON.parse(fs.readFileSync(identityFile,'utf8'));
    if (identity.origin!==origin) throw new Error('这份连接器已绑定另一台服务器。请使用新的连接器文件夹。');
    if (!identity.agentKey || identity.agentKey.length<32) throw new Error('电脑连接信息损坏，请恢复备份或使用新文件夹。');
  } else {
    const registration=await request('/api/devices/register','POST',{name:parameter('--name') || os.hostname()},false);
    identity={origin,deviceId:registration.device.id,agentKey:registration.agentKey};
    fs.writeFileSync(identityFile,JSON.stringify(identity),{mode:0o600,flag:'wx'});
  }
  await ensureService();
  const phones=await request('/api/devices/phones');
  if(phones.phones.length) {
    await showPhones();
    console.log('已恢复原有配对，手机无需重新输入配对码。输入 1 可添加新手机。');
  } else await newCode();
  input=readline.createInterface({input:process.stdin,output:process.stdout});input.on('line',onInput);input.on('close',shutdown);
  console.log('后台连接已开启。可以关闭此窗口；电脑需保持开机联网。');
  console.log('1 生成新码；2 查看手机；3 解除全部配对；s 停止后台；q 关闭窗口。');
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
} catch(error) {console.error('无法连接：'+error.message);process.exitCode=1;}
