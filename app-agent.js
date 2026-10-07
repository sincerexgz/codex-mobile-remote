import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProcess, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { sendDesktopMessage } from './desktop-client.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
function loadDotEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const item = line.trim().replace(/^\uFEFF/, "");
    if (!item || item.startsWith("#")) continue;
    const split = item.indexOf("=");
    if (split < 1) continue;
    const key = item.slice(0, split).trim();
    let value = item.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function resolveCodex() {
  const explicit = process.env.CODEX_CLI_PATH || process.env.CODEX_COMMAND;
  if (explicit && path.isAbsolute(explicit) && fs.existsSync(explicit)) return explicit;
  try {
    const located = execFileSync(process.platform === "win32" ? "where.exe" : "which", [explicit || "codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (located) return located;
  } catch {}
  if (process.platform === "win32") {
    const binRoot = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
    try {
      return fs.readdirSync(binRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(binRoot, entry.name, "codex.exe"))
        .filter((file) => fs.existsSync(file))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    } catch {}
  }
  return explicit || "codex";
}

const executable = resolveCodex();
const relayUrl = process.env.RELAY_URL;
const agentKey = process.env.AGENT_KEY;
if (!relayUrl || !agentKey || agentKey.length < 32) {
  console.error("Set RELAY_URL and AGENT_KEY in .env");
  process.exit(1);
}
const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
const env = { ...process.env, HOME: home, CODEX_HOME: process.env.CODEX_HOME || path.join(home, ".codex") };
const sessionsRoot = path.join(env.CODEX_HOME, "sessions");
const sessionIndexPath = path.join(env.CODEX_HOME, "session_index.jsonl");
let child = null;
let socket = null;
let reconnectTimer;
let stopping = false;
let ready = false;
let localMode = false;
let currentThreadId = null;
let rpcId = 0;
let lineBuffer = "";
let threadList = [];
const pending = new Map();
const resumedThreads = new Set();
const activeThreads = new Set();
let localThreadFiles = new Map();
let localThreadMtimes = new Map();
const localTitleCache = new Map();
const localMetadataCache = new Map();
let localRefreshTimer = null;

function sendRelay(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
function rpc(method, params = {}, timeoutMs = 30000) {
  if (!child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running"));
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
function notify(method, params = {}) {
  if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
function textFromContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return textFromContent(value.text ?? value.value ?? value.content ?? value.parts ?? value.input ?? value.output ?? "");
}
function displayUserText(text) {
  // The desktop app tool records follow-ups in its delegation envelope. Show
  // the user's input, using the same entity decoding as the desktop UI.
  if (!text.startsWith('<codex_delegation>') || !text.endsWith('</codex_delegation>')) return text;
  const input = /<input>\s*([\s\S]*?)\s*<\/input>/i.exec(text)?.[1];
  return input == null ? text : input.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
function cleanDisplayTitle(value) {
  let title = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const requestMarker = title.indexOf("My request:");
  if (/^#?\s*Files mentioned by the user:/i.test(title) && requestMarker >= 0) title = title.slice(requestMarker + "My request:".length).trim();
  return title.length > 100 ? `${title.slice(0, 99).trimEnd()}…` : title;
}
function isGenericThreadTitle(value) {
  const title = String(value || "").trim();
  return !title || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(title);
}
function isInternalThreadTitle(value) {
  const title = String(value || "").trim();
  return /^guardian\s+review\b/i.test(title) || /^<environment_context\b/i.test(title);
}
function projectNameForCwd(cwd) {
  if (!cwd) return "";
  const resolved = path.resolve(cwd);
  if (resolved.toLowerCase() === path.resolve(home).toLowerCase()) return "";
  return path.basename(resolved);
}
function walkJsonlFiles(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(full, result);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(full);
  }
  return result;
}
function readLocalSessionIndex() {
  const indexed = new Map();
  const filesById = new Map();
  try {
    for (const line of fs.readFileSync(sessionIndexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id) indexed.set(item.id, item);
      } catch {}
    }
  } catch {}
  for (const file of walkJsonlFiles(sessionsRoot)) {
    const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (!match) continue;
    try {
      const stat = fs.statSync(file);
      let metadata = localMetadataCache.get(file);
      if (!metadata || metadata.mtime !== stat.mtimeMs) {
        // The session index contains titles but often omits the project path.
        // Read only the header, even when a conversation has a large history.
        const fd = fs.openSync(file, "r");
        let header;
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
          header = JSON.parse(buffer.toString("utf8", 0, bytes).split(/\r?\n/, 1)[0]);
        } finally { fs.closeSync(fd); }
        metadata = { mtime: stat.mtimeMs,
          id: header.type === 'session_meta' ? header.payload?.id : null,
          cwd: header.type === "session_meta" ? (header.payload?.cwd || "") : "" };
        localMetadataCache.set(file, metadata);
      }
      // A resumed rollout filename can contain a second UUID. Only the
      // session metadata identifies the conversation owned by the desktop.
      const id = metadata.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) continue;
      const previousFile = filesById.get(id);
      if (!previousFile || stat.mtimeMs > previousFile.mtime) filesById.set(id, { file, mtime:stat.mtimeMs });
      const existing = indexed.get(id) || { id };
      const indexedTime = Date.parse(existing.updated_at || existing.updatedAt || "") || 0;
      indexed.set(id, {
        ...existing,
        cwd: metadata.cwd || existing.cwd || "",
        updated_at: new Date(Math.max(indexedTime, stat.mtimeMs)).toISOString(),
      });
    } catch {}
  }
  localThreadFiles = new Map([...filesById].map(([id, value]) => [id, value.file]));
  return indexed;
}
function localDisplayTitle(id, metadata = {}) {
  const indexedTitle = metadata.thread_name || metadata.title || "";
  if (!isGenericThreadTitle(indexedTitle)) return cleanDisplayTitle(indexedTitle);
  const file = localThreadFiles.get(id);
  if (!file) return "";
  localThreadFiles.set(id, file);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return ""; }
  const cached = localTitleCache.get(id);
  if (cached?.mtime === mtime) return cached.title;
  let title = "";
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(512 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    for (const line of buffer.toString("utf8", 0, bytesRead).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload || {};
      if (record.type !== "response_item" || payload.type !== "message" || payload.role !== "user") continue;
      title = cleanDisplayTitle(textFromContent(payload.content));
      if (title) break;
    }
  } catch {}
  localTitleCache.set(id, { mtime, title });
  if (localTitleCache.size > 500) localTitleCache.delete(localTitleCache.keys().next().value);
  return title;
}
function readLocalThread(id, metadata = {}) {
  const file = localThreadFiles.get(id);
  if (!file) return null;
  localThreadFiles.set(id, file);
  const turns = [];
  let cwd = metadata.cwd || "";
  let title = metadata.thread_name || metadata.title || "";
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload || {};
      if (record.type === "session_meta") {
        cwd = payload.cwd || cwd;
        title = payload.thread_name || title;
      }
      if (record.type !== "response_item" || payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;
      const rawText = textFromContent(payload.content).trim();
      const text = payload.role === 'user' ? displayUserText(rawText) : rawText;
      if (!text) continue;
      const turnId = record.turn_id || `local-${turns.length}`;
      let turn = turns.at(-1);
      if (!turn || turn.id !== turnId) { turn = { id: turnId, items: [] }; turns.push(turn); }
      turn.items.push({ id: payload.id || `${turnId}-${turn.items.length}`, type: payload.role === "user" ? "userMessage" : "agentMessage", text: text.slice(-6000) });
      while (turns.reduce((total, item) => total + item.items.length, 0) > 30) {
        const first = turns[0];
        first.items.shift();
        if (!first.items.length) turns.shift();
      }
    }
  } catch (error) {
    console.error(`Unable to read local session ${id}: ${error.message}`);
    return null;
  }
  const displayTitle = isGenericThreadTitle(title) ? (localDisplayTitle(id, metadata) || turns.flatMap((turn) => turn.items).find((item) => item.type === "userMessage")?.text || id) : title;
  return { id, title: cleanDisplayTitle(displayTitle) || id, cwd, projectName: projectNameForCwd(cwd), sourceKind: "local-session", turns };
}
function publishLocalSnapshots() {
  for (const metadata of localThreads().slice(0, 20)) {
    if(activeThreads.has(metadata.id)) continue;
    const file = localThreadFiles.get(metadata.id);
    if (!file) continue;
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (localThreadMtimes.get(metadata.id) === mtime) continue;
    localThreadMtimes.set(metadata.id, mtime);
    const thread = readLocalThread(metadata.id, metadata);
    if (thread) sendRelay({ type: "thread-cache", thread });
  }
}
function localThreads() {
  const indexed = readLocalSessionIndex();
  return [...indexed.values()]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .map((item) => {
      const title = localDisplayTitle(item.id, item);
      return { id: item.id, title, cwd: item.cwd || "", projectName: projectNameForCwd(item.cwd), updatedAt: item.updated_at || item.updatedAt || null, sourceKind: "local-session" };
    })
    .filter((item) => item.title && !isInternalThreadTitle(item.title))
    .slice(0, 50);
}
function isVisibleThread(item) {
  const title = item.title || item.name || "";
  return Boolean(item.id && title && !isGenericThreadTitle(title) && !isInternalThreadTitle(title));
}
function startAppServer() {
  if (child) return;
  ready = false;
  const args = ["app-server", "--listen", "stdio://"];
  console.log(`Starting ${executable} ${args.join(" ")}`);
  child = spawnProcess(executable, args, { cwd: process.env.CODEX_CWD || process.cwd(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", onStdout);
  child.stderr.on("data", (text) => { console.error(text.trimEnd()); sendRelay({ type: "app-error", message: text.trim() }); });
  child.on("error", (error) => sendRelay({ type: "app-error", message: error.message }));
  child.on("exit", (code) => {
    child = null;
    resumedThreads.clear();activeThreads.clear();
    ready = false;
    localMode = true;
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error("Codex app-server exited")); }
    pending.clear();
    if (!stopping) setTimeout(() => process.exit(1), 500);
    sendRelay({ type: "status", status: { connected: true, running: false, mode: "local-session", code } });
  });
}
function onStdout(chunk) {
  lineBuffer += chunk;
  let newline;
  while ((newline = lineBuffer.indexOf("\n")) >= 0) {
    const line = lineBuffer.slice(0, newline).trim();
    lineBuffer = lineBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { console.error(`Non-JSON app-server output: ${line.slice(0, 500)}`); continue; }
    handleAppMessage(message);
  }
}
async function handleAppMessage(message) {
  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    const task = pending.get(message.id);
    if (task) {
      pending.delete(message.id);
      clearTimeout(task.timeout);
      if (message.error) task.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else task.resolve(message.result);
    }
    return;
  }
  if (Object.hasOwn(message, "id") && message.method) {
    sendRelay({ type: "server-request", request: message });
    return;
  }
  if (!message.method) return;
  if(message.method === "turn/started") activeThreads.add(message.params?.threadId);
  if(message.method === "turn/completed") {activeThreads.delete(message.params?.threadId);localThreadMtimes.delete(message.params?.threadId);}
  sendRelay({ type: "app-event", event: message });
  if (message.method === "thread/started" || message.method === "thread/updated") refreshThreads();
}
async function initialize() {
  const result = await rpc("initialize", { clientInfo: { name: "codex-mobile-remote", title: "Codex Mobile Remote", version: "0.2.0" } });
  notify("initialized");
  ready = true;
  localMode = false;
  sendRelay({ type: "status", status: { connected: true, running: true, mode: "app-server", userAgent: result?.userAgent || null } });
  await refreshThreads();
}
function startLocalMode(reason) {
  if (localMode) return;
  localMode = true;
  ready = true;
  threadList = localThreads();
  sendRelay({ type: "status", status: { connected: true, running: true, mode: "local-session", detail: reason?.message || "读取本地历史" } });
  sendRelay({ type: "threads", threads: threadList });
  publishLocalSnapshots();
  console.log(`Using local session history (${threadList.length} thread(s))`);
}
async function refreshThreads() {
  if (!ready) return;
  if (localMode) {
    threadList = localThreads();
    sendRelay({ type: "threads", threads: threadList });
    publishLocalSnapshots();
    return;
  }
  try {
    const result = await rpc("thread/list", {
      limit: 50, sortKey: "updated_at", sortDirection: "desc", archived: false,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    });
    const remoteThreads = result.data || result.threads || [];
    const known = new Map(remoteThreads.map((item) => [item.id, { ...item, projectName: item.projectName || projectNameForCwd(item.cwd) }]));
    for (const item of localThreads()) {
      const remote = known.get(item.id);
      if (!remote) known.set(item.id, item);
      else known.set(item.id, {
        ...remote,
        title: isGenericThreadTitle(remote.title || remote.name) ? item.title : (remote.title || remote.name),
        cwd: remote.cwd || item.cwd,
        projectName: remote.projectName || item.projectName || projectNameForCwd(remote.cwd || item.cwd),
      });
    }
    threadList = [...known.values()].filter(isVisibleThread).sort((a, b) => String(b.updatedAt || b.updated_at || "").localeCompare(String(a.updatedAt || a.updated_at || ""))).slice(0, 50);
    console.log(`Loaded ${threadList.length} Codex thread(s)`);
    sendRelay({ type: "threads", threads: threadList });
  } catch (error) { sendRelay({ type: "app-error", message: error.message }); }
}
async function selectThread(threadId) {
  if (!ready || typeof threadId !== "string") return;
  try {
    currentThreadId = threadId;
    if (threadList.some((item) => item.id === threadId && item.sourceKind === "local-session")) {
      const local = readLocalThread(threadId, threadList.find((item) => item.id === threadId));
      if (local) return sendRelay({ type: "thread", thread: local, selectedThreadId: threadId });
    }
    try {
      const result = await rpc("thread/read", { threadId, includeTurns: true });
      sendRelay({ type: "thread", thread: result.thread || result, selectedThreadId: threadId });
    } catch (error) {
      const local = readLocalThread(threadId, threadList.find((item) => item.id === threadId));
      if (local) return sendRelay({ type: "thread", thread: local, selectedThreadId: threadId });
      throw error;
    }
  } catch (error) { sendRelay({ type: "app-error", message: error.message }); }
}
async function sendMessage(threadId, text, requestId) {
  try {
    if (!ready) throw new Error('电脑连接器尚未就绪，请稍后重试。');
    if (!threadId || typeof text !== 'string' || !text.trim() || text.length>20000) throw new Error('消息内容无效。');
    if (!threadList.some(item=>item.id===threadId)) throw new Error('请选择这台电脑上的会话。');
    await sendDesktopMessage(threadId, text);
    sendRelay({type:'message-result',requestId,ok:true,threadId});
    console.log(`Desktop accepted message for ${threadId}`);
    setTimeout(()=>selectThread(threadId),1200).unref();
  } catch (error) {
    console.error(`Desktop send failed for ${threadId}: ${error.message}`);
    sendRelay({ type: 'message-result', requestId, ok:false, threadId, error:error.message });
    sendRelay({ type: "app-error", threadId, message: error.message });
  }
}
function connect() {
  if (stopping) return;
  const endpoint = new URL(relayUrl);
  endpoint.searchParams.set("role", "agent");
  socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${agentKey}` }, maxPayload: 1024 * 1024 });
  socket.on("open", () => {
    // A restarted cloud relay needs fresh snapshots, even if the files on the
    // desktop have not changed since the preceding connection.
    localThreadMtimes.clear();
    console.log(`Connected to relay ${relayUrl}`);
    sendRelay({ type: "status", status: { connected: true, running: ready, mode: "app-server" } });
    if (!ready) startLocalMode({message:'通过桌面 Codex 消息接口执行指令'});
    sendRelay({ type: "status", status: { connected: true, running: true, mode: 'desktop-app-tools' } });
    if (threadList.length) sendRelay({ type: "threads", threads: threadList });
    publishLocalSnapshots();
  });
  socket.on("message", async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "welcome") {
      if (child && !ready) {
        try { await initialize(); } catch (error) { sendRelay({ type: "app-error", message: error.message }); startLocalMode(error); child?.kill(); }
      }
    } else if (message.type === "select-thread") await selectThread(message.threadId);
    else if (message.type === "send-message") await sendMessage(message.threadId, message.text, message.requestId);
    else if (message.type === "refresh-threads") await refreshThreads();
    else if (message.type === "resolve-request" && message.id !== undefined) {
      child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.result || {} })}\n`);
    }
  });
  socket.on("close", (code) => {
    if (code === 4001) {
      console.error("Another connector has connected. Closing this instance to avoid reconnect conflicts.");
      return shutdown();
    }
    console.log("Relay connection closed; retrying in 3 seconds");
    if (!stopping) reconnectTimer = setTimeout(connect, 3000);
  });
  socket.on("error", (error) => console.error(`Relay connection error: ${error.message}`));
}
function shutdown() {
  stopping = true;
  clearTimeout(reconnectTimer);
  child?.kill();
  socket?.close();
  setTimeout(() => process.exit(0), 250).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", message => { if (message?.type === "stop") shutdown(); });
connect();
localRefreshTimer = setInterval(() => {
  if (!ready) return;
  const before = JSON.stringify(threadList);
  const merged = new Map((localMode ? [] : threadList).map((item) => [item.id, item]));
  for (const item of localThreads()) merged.set(item.id, item);
  threadList = [...merged.values()].filter(isVisibleThread).sort((a, b) => String(b.updatedAt || b.updated_at || "").localeCompare(String(a.updatedAt || a.updated_at || ""))).slice(0, 50);
  if (JSON.stringify(threadList) !== before) sendRelay({ type: "threads", threads: threadList });
  publishLocalSnapshots();
  if (currentThreadId && threadList.some((item) => item.id === currentThreadId && item.sourceKind === "local-session") && !activeThreads.has(currentThreadId)) selectThread(currentThreadId);
}, 5000);
localRefreshTimer.unref();
