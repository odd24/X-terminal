import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Test-only loopback CDP. No bootstrap/token is queried or written by this test.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function launch(fixture, killDesktop = false) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const app = spawn(path.resolve('target/debug/shared-terminal-desktop.exe'), fixture ? ['--test-fixture'] : [], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  let startupError;
  app.on('error', error => { startupError = error; });
  let socket;
  let childPid;
  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      assert.equal(app.exitCode, null, 'desktop must stay alive');
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
        if (target) break;
      } catch { /* starting */ }
      await delay(200);
    }
    assert.ok(target, 'native WebView must start');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const reply = JSON.parse(event.data);
      const item = pending.get(reply.id);
      if (!item) return;
      pending.delete(reply.id); clearTimeout(item.timer);
      if (reply.error) item.reject(new Error(JSON.stringify(reply.error))); else item.resolve(reply.result);
    };
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const invoke = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
    const waitFor = async expression => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(`condition timeout: ${expression}; ${await evaluate('document.body.innerText')}`);
    };
    await waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
    const status = await invoke('service_status'); childPid = status.pid;
    assert.equal(status.fixture, fixture);
    assert.equal(status.exit_policy, 'stop_on_desktop_exit');
    assert.deepEqual(await invoke('service_list'), []);
    assert.equal(await evaluate(`window.__TAURI_INTERNALS__.invoke('service_request', {request: {op:'shutdown'}}).then(() => false, () => true)`), true, 'generic root RPC must not exist');
    if (killDesktop) {
      app.kill();
      for (let attempt = 0; attempt < 100 && alive(childPid); attempt++) await delay(20);
      assert.equal(alive(childPid), false, 'Job must stop service when outer process is killed');
      return 'outer desktop crash closes Job and stops owned service';
    }
    if (!fixture) {
      assert.equal(await evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(() => false, () => true)`), true);
      assert.equal(await evaluate(`document.body.innerText.includes('新建合成会话')`), false);
      // Actual native window close exercises RunEvent::Exit and orderly shutdown.
      await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '退出桌面').click()`);
      for (let attempt = 0; attempt < 100 && app.exitCode === null; attempt++) await delay(50);
      assert.notEqual(app.exitCode, null, 'normal window close must exit desktop');
      for (let attempt = 0; attempt < 100 && alive(childPid); attempt++) await delay(20);
      assert.equal(alive(childPid), false, 'normal close must stop service');
      return 'default fixture disabled; no generic RPC; native window close stops service';
    }
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '新建合成会话').click()`);
    await waitFor(`document.querySelector('[role=status]').textContent === '服务输出已同步'`);
    const sessions = await invoke('service_list'); assert.equal(sessions.length, 1);
    const connection = { connection_id: sessions[0].connection_id, generation: sessions[0].generation };
    const original = await invoke('service_read', {connection, cursor:1});
    assert.ok(Buffer.from(original.events.flatMap(event => event.bytes)).toString().includes('中文宽字'));
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '屏幕快照').click()`);
    await waitFor(`document.querySelector('pre')?.textContent.includes('中文宽字')`);
    assert.equal(await evaluate(`document.querySelector('pre').textContent.includes('替代屏幕')`), false);
    await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
    await command('Input.dispatchKeyEvent', {type:'char', text:'Z'});
    await waitFor(`document.querySelector('.input-status output').textContent === '"Z"'`);
    await delay(200);
    const withInput = await invoke('service_read', {connection, cursor:1});
    assert.ok(Buffer.from(withInput.events.flatMap(event => event.bytes)).toString().endsWith('Z'), 'keyboard must pass through service');
    // Exceed the service's 30-second client idle deadline with JS suspended.
    // The Rust heartbeat must preserve the native client independently of React.
    await command('Emulation.setScriptExecutionDisabled', {value:true});
    await delay(31_000);
    await command('Emulation.setScriptExecutionDisabled', {value:false});
    await command('Page.reload');
    await waitFor(`document.querySelector('[role=status]')?.textContent === '服务输出已同步'`);
    const reloaded = await invoke('service_status');
    assert.equal(reloaded.service_id, status.service_id); assert.equal(reloaded.pid, status.pid);
    assert.deepEqual(await invoke('service_list'), sessions);
    assert.deepEqual(await invoke('service_read', {connection, cursor:1}), withInput, 'reload must preserve bytes and cursor without replaying input');
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '屏幕快照').click()`);
    await waitFor(`document.querySelector('pre')?.textContent.includes('中文宽字')`);
    await mkdir('artifacts', {recursive:true});
    const screenshot = await command('Page.captureScreenshot', {format:'png'});
    await writeFile('artifacts/P07.3-desktop.png', Buffer.from(screenshot.data, 'base64'));
    process.kill(childPid);
    await waitFor(`document.querySelector('[role=status]').textContent.includes('会话服务不可用')`);
    await delay(300);
    assert.equal(await evaluate(`window.__TAURI_INTERNALS__.invoke('service_status').then(() => false, () => true)`), true, 'no silent service restart');
    return 'native keyboard/service path, 31s renderer suspension/reload preserves identity/output; service crash reported without replay';
  } finally {
    socket?.close();
    if (app.exitCode === null) app.kill();
    for (let attempt = 0; attempt < 100 && childPid && alive(childPid); attempt++) await delay(20);
    if (childPid) assert.equal(alive(childPid), false, 'desktop termination must leave no owned service');
  }
}
const results = [];
results.push(await launch(false));
results.push(await launch(true));
results.push(await launch(false, true));
await mkdir('artifacts', {recursive:true});
await writeFile('artifacts/P07.3-ui-result.json', JSON.stringify({result:'PASS', scenarios:results, note:'synthetic Windows desktop/IPC; no physical endpoint acceptance'}, null, 2));
console.log('PASS:', results.join('; '));
