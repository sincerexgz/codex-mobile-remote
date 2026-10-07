import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createSession, json, readBody } from './relay-session.js';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/)) {
    const match=line.trim().replace(/^\uFEFF/,'').match(/^([^#=]+)=(.*)$/);
    if (match && process.env[match[1].trim()]===undefined) process.env[match[1].trim()]=match[2].trim().replace(/^(['"])(.*)\1$/,'$2');
  }
} catch {}
const stateFile = process.env.RELAY_STATE_FILE || path.join(root,'.relay-state.json');
const deviceDirectory = stateFile+'.devices';
const registryFile = path.join(deviceDirectory,'registry.json');
const host = process.env.RELAY_HOST || '127.0.0.1';
const port = Number(process.env.RELAY_PORT || 8787);
const digest = value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const secret = ()=>crypto.randomBytes(32).toString('hex');
const devices = new Map();
const agentIndex = new Map();
const phoneIndex = new Map();
const sessions = new Map();
const codes = new Map();
const limits = new Map();
const maxDevices=32;
const registrationKey=process.env.REGISTRATION_KEY || '';
if (registrationKey.length<32 || /^replace-with/i.test(registrationKey)) throw new Error('Set REGISTRATION_KEY to a random secret of at least 32 characters.');
const legacyAgent=process.env.AGENT_KEY || '';
const legacyToken=process.env.REMOTE_TOKEN || '';
fs.mkdirSync(deviceDirectory,{recursive:true,mode:0o700});
if (fs.existsSync(registryFile)) {
  // Registry errors must not silently reset persistent device identities.
  for (const device of JSON.parse(fs.readFileSync(registryFile,'utf8')).devices || []) {
    if (!/^[a-f0-9-]{36}$/.test(device.id) || !Array.isArray(device.phones)) throw new Error('Invalid device registry');
    devices.set(device.id,device); agentIndex.set(device.agentHash,device.id);
    for (const phone of device.phones) phoneIndex.set(phone.tokenHash,{deviceId:device.id,phoneId:phone.id});
  }
}
function persistRegistry() {
  fs.writeFileSync(registryFile+'.tmp',JSON.stringify({version:1,devices:[...devices.values()]}),{mode:0o600});
  fs.renameSync(registryFile+'.tmp',registryFile);
}
function publicDevice(device) { return {id:device.id,name:device.name}; }
function session(id) {
  if (!sessions.has(id)) {
    const file=id==='legacy' ? stateFile : path.join(deviceDirectory,id+'.json');
    sessions.set(id,createSession(file,()=>id==='legacy' ? {id:'legacy',name:'原有桌面 Codex'} : publicDevice(devices.get(id))));
  }
  return sessions.get(id);
}
function agentDevice(token) {
  if (!token) return null;
  if (legacyAgent.length>=32 && digest(token)===digest(legacyAgent)) return 'legacy';
  return agentIndex.get(digest(token)) || null;
}
function phoneDevice(token) {
  if (!token) return null;
  if (legacyToken.length>=32 && digest(token)===digest(legacyToken)) return {deviceId:'legacy',phoneId:'legacy'};
  return phoneIndex.get(digest(token)) || null;
}
function address(req) {
  const peer=req.socket.remoteAddress || '';
  // nginx overwrites this header. Other clients cannot spoof rate-limit keys.
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) ? String(req.headers['x-real-ip'] || peer).slice(0,80) : peer;
}
function permit(key,maximum,windowMs) {
  const now=Date.now();
  let item=limits.get(key);
  if (!item || item.reset<=now) { item={count:0,reset:now+windowMs}; limits.set(key,item); }
  if (limits.size>10000 && !key.endsWith(':global')) {limits.delete(key);return false;}
  return ++item.count<=maximum;
}
function revokePhone(device,phone) {
  const previous=device.phones;
  device.phones=device.phones.filter(item=>item.id!==phone.id);
  try { persistRegistry(); } catch(error) { device.phones=previous; throw error; }
  phoneIndex.delete(phone.tokenHash); sessions.get(device.id)?.revoke(phone.tokenHash);
}
const cleanup=setInterval(()=>{
  const now=Date.now();
  for (const [code,item] of codes) if (item.expiresAt<=now) codes.delete(code);
  for (const [key,item] of limits) if (item.reset<=now) limits.delete(key);
},60000); cleanup.unref();

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://relay.local');
    const bearer=String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    const token=bearer || url.searchParams.get('token') || '';
    if (url.pathname==='/api/health') return json(res,200,{ok:true,pairingVersion:2,codeLength:4,messageAcknowledgement:true});
    if (url.pathname==='/api/devices/register' && req.method==='POST') {
      if (!crypto.timingSafeEqual(Buffer.from(digest(req.headers['x-registration-key'] || '')),Buffer.from(digest(registrationKey)))) return json(res,403,{error:'首次登记需要服务器访问密钥，请向服务器维护者获取。'});
      if (!permit('register:'+address(req),5,3600000) || !permit('register:global',20,3600000)) return json(res,429,{error:'登记频繁，请稍后再试。'});
      if (devices.size>=maxDevices) return json(res,503,{error:'服务器的电脑数量已满，请联系服务器维护者。'});
      const body=await readBody(req);
      if (devices.size>=maxDevices) return json(res,503,{error:'服务器的电脑数量已满。'});
      const agentKey=secret();
      const device={id:crypto.randomUUID(),name:String(body.name || '我的电脑').replace(/[\x00-\x1f\x7f]/g,'').slice(0,60),agentHash:digest(agentKey),phones:[],createdAt:Date.now()};
      devices.set(device.id,device);
      try { persistRegistry(); } catch(error) {devices.delete(device.id);throw error;}
      agentIndex.set(device.agentHash,device.id);
      return json(res,201,{device:publicDevice(device),agentKey});
    }
    if (url.pathname==='/api/pair' && req.method==='POST') {
      if (!permit('pair:'+address(req),5,60000) || !permit('pair:global',30,60000)) return json(res,429,{error:'配对尝试过于频繁，请稍后再试。'});
      const body=await readBody(req);
      const code=String(body.code || '').toUpperCase().replace(/[\s-]/g,'');
      const invitation=codes.get(code);
      if (!invitation || invitation.expiresAt<=Date.now()) return json(res,400,{error:'配对码无效或已过期，请在电脑重新生成。'});
      const device=devices.get(invitation.deviceId);
      if (!session(device.id).online()) return json(res,409,{error:'电脑未连接，请保持电脑上的配对连接器运行。'});
      if (device.phones.length>=8) return json(res,409,{error:'这台电脑已配对 8 个手机，请先在电脑解除旧配对。'});
      const phoneToken=secret();
      const phone={id:crypto.randomUUID(),name:String(body.name || 'Android 手机').replace(/[\x00-\x1f\x7f]/g,'').slice(0,60),tokenHash:digest(phoneToken),pairedAt:Date.now()};
      device.phones.push(phone);
      try {persistRegistry();} catch(error) {device.phones.pop();throw error;}
      codes.delete(code); phoneIndex.set(phone.tokenHash,{deviceId:device.id,phoneId:phone.id});
      return json(res,200,{token:phoneToken,device:publicDevice(device),phoneId:phone.id});
    }
    if (url.pathname.startsWith('/api/devices/')) {
      const id=agentDevice(bearer);
      if (!id || id==='legacy') return json(res,401,{error:'电脑连接凭据无效。'});
      const device=devices.get(id);
      if (url.pathname==='/api/devices/pair-code' && req.method==='POST') {
        if (!permit('code:'+id,10,60000)) return json(res,429,{error:'请稍后再生成配对码。'});
        for (const [code,item] of codes) if (item.deviceId===id) codes.delete(code);
        let code;
        do {code=String(crypto.randomInt(10000)).padStart(4,'0');} while(codes.has(code));
        const expiresAt=Date.now()+10*60000;
        codes.set(code,{deviceId:id,expiresAt});
        return json(res,200,{code,expiresAt,device:publicDevice(device)});
      }
      if (url.pathname==='/api/devices/phones' && req.method==='GET') return json(res,200,{device:publicDevice(device),connected:session(id).online(),phones:device.phones.map(({id,name,pairedAt})=>({id,name,pairedAt}))});
      if (url.pathname==='/api/devices/revoke' && req.method==='POST') {
        const body=await readBody(req);
        const targets=body.all===true ? [...device.phones] : device.phones.filter(phone=>phone.id===body.phoneId);
        for (const phone of targets) revokePhone(device,phone);
        for (const [code,item] of codes) if (item.deviceId===id) codes.delete(code);
        return json(res,200,{revoked:targets.length});
      }
      return json(res,404,{error:'not found'});
    }
    if (url.pathname.startsWith('/api/')) {
      const permission=phoneDevice(token);
      if (!permission) return json(res,401,{error:'未配对或配对已解除，请重新输入电脑配对码。'});
      if (url.pathname==='/api/unpair' && req.method==='POST') {
        if (permission.deviceId!=='legacy') {
          const device=devices.get(permission.deviceId);
          revokePhone(device,device.phones.find(phone=>phone.id===permission.phoneId));
        }
        return json(res,200,{unpaired:true});
      }
      return await session(permission.deviceId).handle(req,res,url,digest(token),()=>phoneDevice(token)?.deviceId===permission.deviceId);
    }
    if (url.pathname==='/' && req.method==='GET') {res.writeHead(302,{location:'/chat'+url.search,'cache-control':'no-store'});return res.end();}
    return serveStatic(url.pathname,res);
  } catch(error) {
    console.error('Relay request failed:',error.code || error.name);
    if (!res.headersSent) json(res,400,{error:'请求未完成，请重试。'}); else res.destroy();
  }
});
const sockets=new WebSocketServer({noServer:true,maxPayload:1024*1024});
server.on('upgrade',(req,socket,head)=>{
  try {
    const url=new URL(req.url,'http://relay.local');
    if (url.pathname!=='/ws') return socket.destroy();
    const role=url.searchParams.get('role');
    const token=String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    const id=role==='agent' ? agentDevice(token) : role==='web' ? phoneDevice(token)?.deviceId : null;
    if (!id) return socket.destroy();
    if (role==='web' && [...sockets.clients].filter(ws=>ws.deviceId===id && ws.role==='web').length>=16) return socket.destroy();
    sockets.handleUpgrade(req,socket,head,ws=>{
      ws.isAlive=true; ws.deviceId=id; ws.role=role;
      ws.on('pong',()=>{ws.isAlive=true;}); ws.on('error',()=>{});
      if (role==='agent') session(id).attachAgent(ws); else session(id).attachWeb(ws,digest(token));
    });
  } catch {socket.destroy();}
});
const heartbeat=setInterval(()=>{for(const ws of sockets.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},25000);heartbeat.unref();
sockets.on('close',()=>clearInterval(heartbeat));
function serveStatic(route,res) {
  const publicDir=path.join(root,'public');
  const file=path.resolve(publicDir,'.'+(route==='/chat' ? '/chat.html' : route));
  if (!file.startsWith(publicDir+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res,404,{error:'not found'});
  const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  res.writeHead(200,{'content-type':types[path.extname(file)] || 'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});fs.createReadStream(file).pipe(res);
}
server.listen(port,host,()=>console.log(`Codex relay listening on http://${host}:${port} (device pairing enabled)`));
