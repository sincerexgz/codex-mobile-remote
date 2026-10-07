import fs from 'node:fs/promises';
import net from 'node:net';
import crypto from 'node:crypto';

// Use the running desktop's app tools. A second app-server cannot write a
// conversation owned by the desktop, and the CLI queue does not start a turn.
const MAX_FRAME = 8 * 1024 * 1024;
let cachedPipe = null;
let nextId = 0;

class PipeClient {
  constructor(pipe) {
    this.socket = net.createConnection(pipe);
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.socket.on('error', () => this.close());
    this.socket.on('close', () => this.close());
    this.socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > MAX_FRAME) return this.close();
        if (this.buffer.length < length + 4) return;
        let response;
        try { response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
        catch { return this.close(); }
        this.buffer = this.buffer.subarray(length + 4);
        const request = this.pending.get(response.id);
        if (!request) continue;
        this.pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error(response.error.message || '桌面接口拒绝了请求。'));
        else request.resolve(response.result);
      }
    });
  }
  request(method, params, timeoutMs) {
    if (this.socket.destroyed) return Promise.reject(new Error('桌面接口已断开。'));
    const id = ++nextId;
    const data = Buffer.from(JSON.stringify({ id, jsonrpc:'2.0', method, params }));
    if (data.length > MAX_FRAME) return Promise.reject(new Error('消息过长。'));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method === 'tools/call'
          ? '桌面未及时返回确认；请查看会话是否已开始执行，避免重复发送。'
          : '桌面接口未响应。'));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.write(Buffer.concat([header, data]));
    });
  }
  close() {
    this.socket.destroy();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(entry.method === 'tools/call'
        ? '桌面连接中断，发送结果未确认；请查看会话状态后再重试。'
        : '桌面接口已断开。'));
    }
    this.pending.clear();
  }
}

async function probe(pipe) {
  const client = new PipeClient(pipe);
  try {
    const result = await client.request('tools/list', { threadStartKind:'all' }, 1500);
    if (!result?.tools?.some(tool => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread')) {
      throw new Error('不是桌面消息接口。');
    }
    return client;
  } catch (error) { client.close(); throw error; }
}

async function desktopConnection() {
  if (process.platform !== 'win32') throw new Error('此连接器的桌面发送接口需要 Windows。');
  if (cachedPipe) {
    try { return await probe(cachedPipe); } catch { cachedPipe = null; }
  }
  const names = (await fs.readdir('\\\\.\\pipe\\')).filter(name => name.startsWith('codex-browser-use-')).slice(0, 64);
  // Discovery sends read-only requests. A message is sent once, only to a
  // confirmed app-tool pipe; an uncertain write is never automatically retried.
  const results = await Promise.allSettled(names.map(async name => {
    const pipe = '\\\\.\\pipe\\' + name;
    return { pipe, client:await probe(pipe) };
  }));
  const matches = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!matches.length) throw new Error('未找到桌面 Codex 消息接口，请打开并登录桌面 Codex 后再发送。');
  if (matches.length > 1) {
    for (const match of matches) match.client.close();
    throw new Error('检测到多个桌面 Codex 实例，请保留一个实例后再发送。');
  }
  cachedPipe = matches[0].pipe;
  return matches[0].client;
}

export async function callDesktopTool(tool, args, threadId) {
  const client = await desktopConnection();
  try {
    const response = await client.request('tools/call', {
      arguments:args, callerSource:'codex', callId:'mcp-call-' + crypto.randomUUID(),
      hostId:'local', namespace:'codex_app', threadId, tool,
      turnId:'mcp-turn-' + crypto.randomUUID(),
    }, 24000);
    const text = (response?.contentItems || []).filter(item => item.type === 'inputText').map(item => item.text).join('\n');
    if (response?.success !== true) throw new Error(text || '桌面 Codex 未接受指令。');
    try { return JSON.parse(text); }
    catch { throw new Error('桌面返回了无法识别的确认，请查看会话状态后再重试。'); }
  } finally { client.close(); }
}

export async function sendDesktopMessage(threadId, prompt) {
  const result = await callDesktopTool('send_message_to_thread', { threadId, hostId:'local', prompt }, threadId);
  if (result?.threadId !== threadId) throw new Error('桌面未确认目标会话，请检查会话状态。');
  return result;
}
