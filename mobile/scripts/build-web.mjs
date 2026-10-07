import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.dirname(mobile);
const output = path.join(mobile, 'www');
fs.mkdirSync(output, { recursive: true });
let html = fs.readFileSync(path.join(project, 'public', 'chat.html'), 'utf8');
const module = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!module) throw new Error('Chat module was not found.');
let controller = module[1];
controller = controller.replaceAll("'/vendor/", "'./vendor/");
const start = controller.indexOf('    const params = new URLSearchParams(location.search);');
const end = controller.indexOf("    const threadsEl = document.getElementById('threads');");
if (start < 0 || end < 0) throw new Error('Chat connection boundary changed.');
controller = controller.slice(0, start) + `
    import { RemoteAccess, mobileApi, prepareConnection, connectionProblem } from './shell.js';
    await prepareConnection();
    const token = 'native-keystore';
    const api = mobileApi;
` + controller.slice(end);
const eventsStart = controller.indexOf('    async function connectEvents() {');
const eventsEnd = controller.indexOf('    if (!token) statusEl.textContent', eventsStart);
if (eventsStart < 0 || eventsEnd < 0) throw new Error('Chat event boundary changed.');
controller = controller.slice(0, eventsStart) + `
    async function connectEvents() {
      await RemoteAccess.addListener('relayEvent', ({ type, data }) => {
        if (type === 'status') {
          connectorMode = data.mode || '';
          if (!sending) statusEl.textContent = !data.connected ? '桌面连接器未连接' : data.running ? '桌面对话同步已连接' : '电脑执行服务正在启动';
          if (data.connected) refreshThreads().catch((e) => statusEl.textContent = e.message);
        } else if (type === 'threads') refreshThreads().catch((e) => statusEl.textContent = e.message);
        else if (type === 'thread' && data.thread?.id === selectedId) showThread(data.thread);
        else if (type === 'app-event') handleAppEvent(data);
        else if (type === 'server-request') showApproval(data);
        else if (type === 'app-error') {
          if (!/^\\s*\\{/.test(data.message || '')) statusEl.textContent = data.message;
        } else if (type === 'connection') {
          statusEl.textContent = data.message;
          if (data.unauthorized) connectionProblem(new Error('401 unauthorized'));
        }
      });
      await RemoteAccess.addListener('appStateChange', ({ isActive }) => {
        if (isActive) refreshThreads().catch((e) => statusEl.textContent = e.message);
      });
      window.addEventListener('remote-connection-changed', async () => {
        sessionStorage.removeItem('codex-selected-thread'); selectedId = ''; selectedThread = null; approvalEl.replaceChildren(); messagesEl.replaceChildren();
        await refreshThreads(false).catch((e) => statusEl.textContent = e.message);
        await RemoteAccess.startEvents();
      });
      await RemoteAccess.startEvents();
    }
` + controller.slice(eventsEnd);
controller = controller.replace("refreshThreads().catch(() => {}); connectEvents();", "refreshThreads().catch((e) => { statusEl.textContent = e.message; connectionProblem(e); }); connectEvents().catch((e) => statusEl.textContent = e.message);");
controller = controller.replace('双击项目里的“一键启动.bat”', '双击项目里的“远程启动.bat”');
controller = controller.replace("if (next && next !== selectedId) await chooseThread(next);", "if (next && next !== selectedId) await chooseThread(next);");
controller = controller.replace("threadsEl.addEventListener('change', () => chooseThread(threadsEl.value));", "threadsEl.addEventListener('change', () => chooseThread(threadsEl.value).catch((e) => statusEl.textContent = e.message));");
// Event refreshes keep a reader's position when a different device selects a
// conversation; preserve the independent selection in the native client.
controller = controller.replace('      selectedThread = thread;', `      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
      const previousScroll = messagesEl.scrollTop;
      const sameThread = selectedThread?.id === thread?.id;
      if (sameThread && JSON.stringify(selectedThread) === JSON.stringify(thread)) { return; }
      selectedThread = thread;`);
controller = controller.replace('      messagesEl.scrollTop = messagesEl.scrollHeight;', '      messagesEl.scrollTop = sameThread && !nearBottom ? previousScroll : messagesEl.scrollHeight;');

html = html.replace(module[0], '<script type="module" src="/app.js"></script>');
html = html.replace('<title>Codex 对话同步</title>', '<title>Codex 远程</title>');
html = html.replace('</head>', '<link rel="stylesheet" href="/shell.css"></head>');
html = html.replace('<header><h1><a href="/" style="color:inherit;text-decoration:none">Codex 对话</a></h1>', '<header><div class="app-title"><h1>Codex 对话</h1><span id="connection-origin"></span></div><button type="button" id="connection-settings">连接</button>');
html = html.replace('<body>', `<body>
  <dialog id="connection-dialog" aria-labelledby="connection-title">
    <div class="app-emblem" aria-hidden="true">⌘</div>
    <h2 id="connection-title">连接桌面 Codex</h2>
    <p>在自己的电脑运行配对连接器，将窗口中的配对码填在下面。</p>
    <form id="connect-form">
      <label for="pair-code">电脑配对码</label>
      <input id="pair-code" placeholder="四位数字，例如 1234" inputmode="numeric" maxlength="4" spellcheck="false" autocomplete="off" aria-describedby="pair-hint">
      <p id="pair-hint">不需要账号。配对码有效期 10 分钟，仅可使用一次。</p>
      <button type="submit" id="connect-device">配对这台电脑</button>
      <details id="connection-options" open><summary>其他连接方式 / 更换服务器</summary>
        <label for="pair-server">服务器地址</label>
        <input id="pair-server" type="url" placeholder="https://remote.example.com" required spellcheck="false" autocapitalize="off" autocomplete="off">
        <label for="connection-link">已有远程链接</label>
        <textarea id="connection-link" placeholder="也可以粘贴原来的完整 HTTPS 链接" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
        <div class="connection-actions"><button type="button" id="scan-link">扫描二维码</button><button type="button" id="connect-link">用链接连接</button></div>
      </details>
      <p id="connection-feedback" role="status" aria-live="polite"></p>
      <div class="settings-footer"><button type="button" id="forget-connection" hidden>解除本机配对</button><button type="button" id="cancel-settings" hidden>返回对话</button></div>
    </form>
  </dialog>`);
fs.copyFileSync(path.join(mobile, 'src', 'shell.js'), path.join(output, 'shell.js'));
fs.writeFileSync(path.join(output, 'controller.js'), controller);
await build({ absWorkingDir: mobile, entryPoints: ['./www/controller.js'], outfile: 'www/app.js', bundle: true, format: 'esm', target: 'chrome110', minify: true, external: ['./vendor/*'], nodePaths: ['node_modules'] });
// Intermediate JS sources are unnecessary in the installed app.
fs.unlinkSync(path.join(output, 'controller.js'));
fs.unlinkSync(path.join(output, 'shell.js'));
fs.copyFileSync(path.join(mobile, 'src', 'shell.css'), path.join(output, 'shell.css'));
fs.cpSync(path.join(project, 'public', 'vendor'), path.join(output, 'vendor'), { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html);
console.log('Native client web assets built without desktop credentials.');
