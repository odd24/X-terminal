import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Debugging is enabled only for this disposable smoke-test process, on loopback.
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const app = spawn(path.resolve('target/debug/shared-terminal-desktop.exe'), [], {
  windowsHide: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
    `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  stdio: 'ignore',
});
let startupError;
app.on('error', error => { startupError = error; });
let socket;
try {
  let target;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (app.exitCode !== null) throw new Error(`Desktop exited: ${app.exitCode}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* WebView is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(target, 'WebView debugging target did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const reply = JSON.parse(event.data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
    else request.resolve(reply.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let text = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await command('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    text = result.result.value ?? '';
    if (text.includes('尚无活动连接')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(text, /你的连接，同一个会话/);
  assert.match(text, /尚无活动连接/);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/P01-desktop.png', Buffer.from(screenshot.data, 'base64'));
  console.log('PASS: native desktop WebView loaded Chinese React content; screenshot artifacts/P01-desktop.png');
} finally {
  socket?.close();
  app.kill();
}
