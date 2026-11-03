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
const terminalMode = process.argv.includes('--terminal');
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
  if (terminalMode) {
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
    const waitFor = async expression => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      console.error(await evaluate('document.body.innerText'));
      const failureImage = await command('Page.captureScreenshot', { format: 'png' });
      await mkdir('artifacts', { recursive: true });
      await writeFile('artifacts/P02-failure.png', Buffer.from(failureImage.data, 'base64'));
      throw new Error(`UI condition timeout: ${expression}`);
    };
    await waitFor(`document.querySelector('[role=status]').textContent === '合成回放完成'`);
    await click('逐字节回放');
    await waitFor(`document.querySelector('[role=status]').textContent === '逐字节合成回放中'`);
    await waitFor(`document.querySelector('[role=status]').textContent === '合成回放完成'`);
    await click('屏幕快照');
    await waitFor(`document.querySelector('pre')?.textContent.includes('中文宽字')`);
    assert.equal(await evaluate(`document.querySelector('pre').textContent.includes('替代屏幕')`), false, 'alternate screen must restore');
    await click('高输出回放');
    await waitFor(`document.querySelector('[role=status]').textContent === '高输出合成回放中'`);
    await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
    const latency = [];
    let duringOutput = 0;
    for (let index = 0; index < 20; index++) {
      const key = index % 2 ? 'b' : 'a';
      if (await evaluate(`document.querySelector('[role=status]').textContent.includes('回放中')`)) duringOutput++;
      const start = performance.now();
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      await waitFor(`document.querySelector('.input-status output').textContent === ${JSON.stringify(JSON.stringify(key))}`);
      latency.push(performance.now() - start);
    }
    assert.ok(duringOutput > 0, 'keyboard must be exercised while output is active');
    await click('停止');
    await waitFor(`document.querySelector('[role=status]').textContent.includes('已停止')`);
    await evaluate(`const size = document.querySelector('input[aria-label="字号"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(size, '18'); size.dispatchEvent(new Event('input', { bubbles: true }));`);
    await waitFor(`document.querySelector('input[aria-label="字号"]').value === '18'`);
    latency.sort((a, b) => a - b);
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/P02-ui-result.json', JSON.stringify({ result: 'PASS', keyboardEvents: 20, duringOutput, localInputP95Ms: latency[18], note: 'single synthetic desktop; not P22 performance acceptance' }, null, 2));
    console.log(`PASS: bytewise replay, alternate screen restore, keyboard during output (${duringOutput}/20), stop and font control; observed P95 ${latency[18].toFixed(1)} ms`);
  }
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await mkdir('artifacts', { recursive: true });
  const screenshotPath = terminalMode ? 'artifacts/P02-desktop.png' : 'artifacts/P01-desktop.png';
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log(`PASS: native desktop WebView loaded Chinese React content; screenshot ${screenshotPath}`);
} finally {
  socket?.close();
  app.kill();
}
