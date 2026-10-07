import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

// All conversation state, commands, approvals and event subscribers live in
// this closure. A session never consults another computer's state.
export function createSession(stateFile, deviceInfo) {
  let agent = null;
  let status = { running:false, connected:false };
  let buffer = '';
  let threads = [];
  let thread = null;
  const cache = new Map();
  const approvals = new Map();
  const subscribers = new Map();
  const webSockets = new Map();
  const messageRequests = new Map();
  let persistTimer;
  try {
    if (fs.statSync(stateFile).size <= 6 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      threads = Array.isArray(saved.threads) ? saved.threads.slice(0,100) : [];
      thread = saved.thread || null;
      for (const [id, value] of Object.entries(saved.threadCache || {})) cache.set(id, value);
      if (thread?.id) cache.set(thread.id, thread);
      trimCache();
    }
  } catch {}

  function trimCache() {
    let bytes = 0;
    for (const value of cache.values()) bytes += Buffer.byteLength(JSON.stringify(value));
    while (cache.size > 20 || bytes > 4 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      bytes -= Buffer.byteLength(JSON.stringify(cache.get(oldest)));
      cache.delete(oldest);
    }
  }
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive:true, mode:0o700 });
        fs.writeFileSync(stateFile+'.tmp', JSON.stringify({ savedAt:new Date().toISOString(), threads, thread, threadCache:Object.fromEntries(cache) }), { mode:0o600 });
        fs.renameSync(stateFile+'.tmp', stateFile);
      } catch (error) { console.error('Unable to save device conversation cache:', error.message); }
    }, 100);
    persistTimer.unref();
  }
  function publish(type, data) {
    const packet = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers.keys()) {
      if (res.destroyed) { subscribers.delete(res); continue; }
      if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); subscribers.delete(res); continue; }
      res.write(packet);
    }
  }
  function online() { return agent?.readyState === WebSocket.OPEN; }
  function command(res, value) {
    if (!online()) return json(res,409,{ error:'电脑未连接，请在电脑运行配对连接器。' });
    agent.send(JSON.stringify(value));
    json(res,202,{ accepted:true });
  }
  async function handle(req, res, url, tokenHash, authorized) {
    const route = url.pathname;
    if (req.method === 'GET') {
      if (route === '/api/device') return json(res,200,{ device:deviceInfo(), connected:online() });
      if (route === '/api/state') return json(res,200,{ ...status, connected:online(), buffer, threads, thread });
      if (route === '/api/threads') return json(res,200,{ threads });
      if (route === '/api/thread') {
        const id = url.searchParams.get('threadId');
        return json(res,200,{ thread:id ? (cache.get(id) || (thread?.id === id ? thread : null)) : thread });
      }
      if (route === '/api/events') {
        if (subscribers.size >= 16) return json(res,429,{ error:'这台电脑的同步连接数量已满。' });
        res.writeHead(200,{ 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-store', connection:'keep-alive', 'x-accel-buffering':'no' });
        res.write(`event: snapshot\ndata: ${JSON.stringify({ text:buffer })}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify({ ...status, connected:online() })}\n\n`);
        subscribers.set(res,tokenHash);
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); },20000);
        req.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
        return;
      }
    }
    if (req.method !== 'POST') return json(res,404,{ error:'not found' });
    try {
      const body = await readBody(req);
      if (!authorized()) return json(res,401,{ error:'配对已解除。' });
      if (route === '/api/threads/refresh') return command(res,{ type:'refresh-threads' });
      if (route === '/api/select-thread' || route === '/api/message') {
        if (typeof body.threadId !== 'string' || !threads.some(item=>item.id===body.threadId)) return json(res,400,{ error:'请选择这台电脑上的会话。' });
        if (route === '/api/select-thread') return command(res,{ type:'select-thread', threadId:body.threadId });
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) return json(res,400,{ error:'请输入 1 到 20000 个字符。' });
        if (!online() || !status.running) return json(res,409,{error:'电脑执行服务未就绪，请启动连接器，稍后重试。'});
        const requestId=typeof body.requestId==='string' && /^[a-zA-Z0-9-]{16,80}$/.test(body.requestId) ? body.requestId : crypto.randomUUID();
        const key=tokenHash+':'+requestId;
        let entry=messageRequests.get(key);
        if (entry && (entry.threadId!==body.threadId || entry.text!==body.text)) return json(res,409,{error:'重复请求内容不一致。'});
        if (!entry) {
          if (messageRequests.size>=200) return json(res,429,{error:'发送请求过多，请稍后再试。'});
          entry={requestId,threadId:body.threadId,text:body.text};
          entry.promise=new Promise(resolve=>{entry.resolve=resolve;});
          entry.timer=setTimeout(()=>entry.resolve({ok:false,error:'电脑尚未确认接收，请检查电脑连接日志，确认任务状态后再重试。'}),35000);
          messageRequests.set(key,entry);
          agent.send(JSON.stringify({type:'send-message',threadId:body.threadId,text:body.text,requestId}));
          entry.promise.then(()=>{clearTimeout(entry.timer);setTimeout(()=>messageRequests.delete(key),120000).unref();});
        }
        const result=await entry.promise;
        if (!authorized()) return json(res,401,{error:'配对已解除。'});
        return json(res,result.ok ? 200 : 502,{accepted:result.ok,...result});
      }
      if (route === '/api/resolve') {
        const request = approvals.get(String(body.id));
        if (!request) return json(res,404,{ error:'request expired' });
        if (!['accept','decline','cancel'].includes(body.decision)) return json(res,400,{ error:'invalid decision' });
        if (!online()) return json(res,409,{ error:'电脑未连接。' });
        approvals.delete(String(body.id));
        return command(res,{ type:'resolve-request', id:request.id, result:{ decision:body.decision } });
      }
      if (route === '/api/input') {
        if (typeof body.input !== 'string' || !body.input || body.input.length > 20000) return json(res,400,{ error:'invalid input' });
        return command(res,{ type:'input', input:body.input });
      }
      if (route === '/api/resize') {
        const cols=Math.max(20,Math.min(240,Math.floor(Number(body.cols))));
        const rows=Math.max(8,Math.min(100,Math.floor(Number(body.rows))));
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return json(res,400,{ error:'invalid size' });
        return command(res,{ type:'resize',cols,rows });
      }
      if (route === '/api/control' && ['start','stop','restart'].includes(body.action)) return command(res,{ type:'control', action:body.action });
      json(res,404,{ error:'not found' });
    } catch { json(res,400,{ error:'请求格式不正确。' }); }
  }
  function attachAgent(ws) {
    const old = agent;
    agent = ws;
    old?.close(4001,'replaced by connector');
    approvals.clear();
    status = { ...status, connected:true, running:false };
    ws.send(JSON.stringify({ type:'welcome' }));
    publish('status',status);
    ws.on('message',raw=>{
      if (agent !== ws) return;
      let message;
      try { message=JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'status' && message.status && typeof message.status === 'object') {
        status={ ...message.status, connected:true }; publish('status',status);
      } else if (message.type === 'threads' && Array.isArray(message.threads)) {
        threads=message.threads.filter(item=>item && typeof item.id==='string').slice(0,100);
        const ids=new Set(threads.map(item=>item.id));
        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
        if (thread && !ids.has(thread.id)) thread=null;
        persist(); publish('threads',{ threads });
      } else if (['thread','thread-cache'].includes(message.type) && message.thread?.id && threads.some(item=>item.id===message.thread.id)) {
        cache.delete(message.thread.id); cache.set(message.thread.id,message.thread); trimCache();
        if (message.type==='thread') { thread=message.thread; publish('thread',{ thread, selectedThreadId:message.selectedThreadId }); }
        persist();
      } else if (message.type==='message-result') {
        for (const entry of messageRequests.values()) if (entry.requestId===message.requestId && entry.threadId===message.threadId) entry.resolve({ok:message.ok===true,error:message.error,turnId:message.turnId});
      } else if (message.type==='app-event' && message.event) publish('app-event',message.event);
      else if (message.type==='server-request' && message.request?.id !== undefined) {
        if (approvals.size>=100) approvals.delete(approvals.keys().next().value);
        approvals.set(String(message.request.id),message.request); publish('server-request',message.request);
      } else if (message.type==='app-error') publish('app-error',{ message:message.message || 'Codex error' });
      else if (message.type==='output' && typeof message.text==='string') { buffer=(buffer+message.text).slice(-120000); publish('output',{text:message.text,stream:'pty'}); }
    });
    ws.on('close',()=>{
      if (agent!==ws) return;
      agent=null; approvals.clear(); status={ ...status, connected:false, running:false }; publish('status',status);
      for(const entry of messageRequests.values()) entry.resolve({ok:false,error:'电脑连接中断，请确认任务状态后再重试。'});
    });
  }
  function attachWeb(ws,tokenHash) {
    webSockets.set(ws,tokenHash);
    ws.on('close',()=>webSockets.delete(ws));
    ws.on('message',raw=>{
      let value;
      try { value=JSON.parse(raw.toString()); } catch { return; }
      if (!online()) return;
      if (value.type==='input' && typeof value.input==='string' && value.input.length<=20000) agent.send(JSON.stringify(value));
      else if (value.type==='control' && ['start','stop','restart'].includes(value.action)) agent.send(JSON.stringify(value));
    });
  }
  function revoke(tokenHash) {
    for (const [res, hash] of subscribers) if (hash===tokenHash) {
      res.end(`event: connection\ndata: ${JSON.stringify({ message:'电脑已解除此手机配对。', unauthorized:true })}\n\n`); subscribers.delete(res);
    }
    for (const [ws, hash] of webSockets) if (hash===tokenHash) ws.close(4003,'pairing revoked');
  }
  return { handle,attachAgent,attachWeb,online,revoke };
}
export function json(res,status,value) {
  res.writeHead(status,{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(value));
}
export async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if (size>100000) throw new Error('body too large'); chunks.push(chunk); }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || Array.isArray(value) || typeof value!=='object') throw new Error('invalid body');
  return value;
}
