import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const runtimeFile=path.join(root,'.connector-runtime.json');
const lockFile=path.join(root,'.connector-service.lock');
let lock;
try { lock=fs.openSync(lockFile,'wx',0o600); fs.writeFileSync(lock,String(process.pid)); }
catch { process.exit(0); }
const secret=crypto.randomBytes(32).toString('hex');
let agent=null, retry=null, stopping=false, connected=false, failures=0;
const log=fs.createWriteStream(path.join(root,'connector.log'),{flags:'a'});
function record(message) { log.write(new Date().toISOString()+' '+message+'\n'); }
function startAgent() {
  if(stopping) return;
  try {
    const identity=JSON.parse(fs.readFileSync(path.join(root,'.device-connection.json'),'utf8'));
    const endpoint=new URL('/ws',identity.origin); endpoint.protocol='wss:';
    const environment={...process.env,RELAY_URL:endpoint.href,AGENT_KEY:identity.agentKey};
    delete environment.REMOTE_TOKEN;
    agent=spawn(process.execPath,[path.join(root,'app-agent.js')],{cwd:root,env:environment,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    agent.stdout.on('data',chunk=>{
      const text=chunk.toString(); log.write(text);
      if(text.includes('Connected to relay')) { connected=true; failures=0; }
      if(text.includes('Relay connection closed')) connected=false;
    });
    agent.stderr.on('data',chunk=>log.write(chunk));
    agent.on('error',error=>record('启动失败：'+error.message));
    agent.on('exit',code=>{
      agent=null; connected=false;
      record('执行服务退出：'+code);
      if(!stopping) retry=setTimeout(startAgent,Math.min(30000,3000*++failures));
    });
  } catch(error) { record(error.message); retry=setTimeout(startAgent,10000); }
}
const server=http.createServer((req,res)=>{
  const supplied=String(req.headers.authorization||'');
  if(supplied.length!==secret.length+7 || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret))) { res.writeHead(401);return res.end(); }
  if(req.method==='GET' && req.url==='/status') {
    res.writeHead(200,{'content-type':'application/json'});
    return res.end(JSON.stringify({running:!!agent,connected,pid:process.pid}));
  }
  if(req.method==='POST' && req.url==='/stop') { res.end('{"ok":true}'); setImmediate(stop);return; }
  res.writeHead(404);res.end();
});
function stop() {
  if(stopping)return;
  stopping=true;clearTimeout(retry);if(agent?.connected) agent.send({type:"stop"}); else agent?.kill();server.close();
  try { fs.unlinkSync(runtimeFile);fs.closeSync(lock);fs.unlinkSync(lockFile); } catch {}
  record('已手动停止后台连接。');log.end();
  setTimeout(()=>process.exit(0),500);
}
server.on('error',error=>{record(error.message);stop();});
server.listen(0,'127.0.0.1',()=>{
  fs.writeFileSync(runtimeFile,JSON.stringify({pid:process.pid,port:server.address().port,secret}),{mode:0o600});
  record('后台连接器已启动。');startAgent();
});
process.on('SIGTERM',stop);process.on('SIGINT',stop);
