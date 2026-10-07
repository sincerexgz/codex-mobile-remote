import { registerPlugin } from '@capacitor/core';

export const RemoteAccess = registerPlugin('RemoteAccess');
const dialog = document.getElementById('connection-dialog');
const linkInput = document.getElementById('connection-link');
const codeInput = document.getElementById('pair-code');
const serverInput = document.getElementById('pair-server');
const feedback = document.getElementById('connection-feedback');
const connectButton = document.getElementById('connect-device');
const cancelButton = document.getElementById('cancel-settings');
let configuration = { configured: false };
let pendingConnection;

function readableError(error) {
  const text = String(error?.message || error || '');
  if (/401|unauthorized/i.test(text)) return '连接已失效或配对已解除，请输入新的电脑配对码。';
  return text || '连接失败，请检查手机网络和桌面连接器。';
}

export async function mobileApi(path, options = {}) {
  const result = await RemoteAccess.request({
    path,
    method: options.method || 'GET',
    body: typeof options.body === 'string' ? options.body : '',
  });
  return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
}

function openConnectionSettings() {
  feedback.textContent = configuration.configured ? `当前电脑：${configuration.deviceName || configuration.origin}` : '先在电脑双击“启动配对.bat”，再输入窗口中显示的配对码。';
  linkInput.value = '';
  codeInput.value = '';
  serverInput.value = configuration.origin || '';
  cancelButton.hidden = !configuration.configured;
  document.getElementById('forget-connection').hidden = !configuration.configured;
  if (!dialog.open) dialog.showModal();
}

document.getElementById('connection-settings').addEventListener('click', openConnectionSettings);
cancelButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', (event) => {
  if (!configuration.configured) event.preventDefault();
});

document.getElementById('scan-link').addEventListener('click', async () => {
  feedback.textContent = '';
  try {
    const scan = await RemoteAccess.scanLink();
    if (!scan.cancelled) {
      const text = scan.text || '';
      if (/^codex-remote:\/\/pair\?/i.test(text)) {
        const data = new URL(text); codeInput.value = data.searchParams.get('code') || ''; serverInput.value = data.searchParams.get('server') || serverInput.value;
        feedback.textContent = '已扫描，请点击“配对这台电脑”。';
      } else { linkInput.value = text; feedback.textContent = '已扫描，请点击“用链接连接”。'; }
    }
  } catch (error) { feedback.textContent = readableError(error); }
});

async function connect(mode) {
  const link = linkInput.value.trim();
  const code = codeInput.value.trim();
  if (mode === 'link' && !link) { feedback.textContent = '请先粘贴完整访问链接或扫描二维码。'; return; }
  if (mode === 'pair' && !code) { feedback.textContent = '请输入电脑窗口上的配对码。'; return; }
  connectButton.disabled = true;
  document.getElementById('connect-link').disabled = true;
  feedback.textContent = '正在连接…';
  try {
    // Native code validates the link, authenticates with the server, and then
    // encrypts it with Android Keystore. The token never enters the JS bridge.
    configuration = mode === 'pair' ? await RemoteAccess.pairDevice({ code, server:serverInput.value.trim() }) : await RemoteAccess.saveConnection({ link });
    document.getElementById('connection-origin').textContent = configuration.deviceName || configuration.origin;
    linkInput.value = '';
    codeInput.value = '';
    dialog.close();
    pendingConnection?.();
    pendingConnection = null;
    window.dispatchEvent(new Event('remote-connection-changed'));
  } catch (error) { feedback.textContent = readableError(error); }
  finally { connectButton.disabled = false; document.getElementById('connect-link').disabled = false; }
}
document.getElementById('connect-form').addEventListener('submit', (event) => {
  event.preventDefault(); connect('pair');
});
document.getElementById('connect-link').addEventListener('click', () => connect('link'));

document.getElementById('forget-connection').addEventListener('click', async () => {
  if (!confirm('解除本机配对并清除手机保存的连接信息？电脑上的 Codex 对话会保留。')) return;
  const result = await RemoteAccess.clearConnection();
  if (!result.remoteRevoked && configuration.deviceId) alert('本机连接已清除。服务器暂时无法确认解除，可在电脑连接器中解除这台手机的配对。');
  location.reload();
});

export async function prepareConnection() {
  configuration = await RemoteAccess.getConnection();
  if (configuration.configured) {
    document.getElementById('connection-origin').textContent = configuration.deviceName || configuration.origin;
    return;
  }
  openConnectionSettings();
  await new Promise((resolve) => { pendingConnection = resolve; });
}

export function connectionProblem(error) {
  feedback.textContent = readableError(error);
  if (/401|unauthorized|未设置连接/i.test(String(error?.message || error))) openConnectionSettings();
}

RemoteAccess.addListener('backPressed', async () => {
  if (dialog.open && configuration.configured) { dialog.close(); return; }
  if (confirm('退出 Codex 远程？')) await RemoteAccess.closeApp();
});

// Chat links use the phone's browser; local files from the desktop are not
// downloadable assets and should not replace the application screen.
document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href]');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href');
  if (/^https?:\/\//i.test(href)) RemoteAccess.openLink({ url: href }).catch(() => {});
  else document.getElementById('status').textContent = '此链接指向电脑上的本地文件，请在桌面端查看。';
});
