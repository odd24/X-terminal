import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function dragNativeWindow(app, points, {executable=path.resolve('target/debug/shared-terminal-desktop.exe'), title, raise=false, placeAtWorkAreaStart=false}={}) {
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1','-TargetProcessId',String(app.pid),'-ExpectedExecutable',executable,
    '-Points',JSON.stringify(points),...(title?['-Title',title]:[]),...(raise?['-Raise']:[]),
    ...(placeAtWorkAreaStart?['-PlaceAtWorkAreaStart']:[])],{windowsHide:true,timeout:12000,stdio:'pipe',encoding:'utf8'});
}

export async function connectDesktopPage(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const reply = JSON.parse(event.data);
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    clearTimeout(item.timer);
    if (reply.error) item.reject(new Error(JSON.stringify(reply.error)));
    else item.resolve(reply.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const reply = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) {
      const {exception,text}=reply.exceptionDetails;
      throw new Error(exception?.description ?? exception?.value ?? text);
    }
    return reply.result.value;
  };
  const invoke = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`UI condition timed out: ${expression}`);
  };
  const screenshot = async name => {
    await mkdir('artifacts', { recursive: true });
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join('artifacts', name), Buffer.from(shot.data, 'base64'));
  };
  return {command,evaluate,invoke,waitFor,screenshot,close:()=>socket.close()};
}

export async function launchDesktop(directory, {fixture = false, executable = path.resolve('target/debug/shared-terminal-desktop.exe'), webviewDirectory = path.join(directory,'webview-ui'), windowsHide = true, extraArgs = []} = {}) {
  assert.ok(path.isAbsolute(directory));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const app = spawn(executable, ['--data-dir', directory, ...(fixture ? ['--test-fixture'] : []), ...extraArgs], {
    windowsHide, stdio: ['ignore','ignore','pipe'], env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDirectory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  let nativeErrors='';app.stderr.on('data',chunk=>{nativeErrors=(nativeErrors+chunk.toString()).slice(-8192);});
  let startupError; app.on('error', error => { startupError = error; });
  let page; let pid;
  const stopped=()=>app.exitCode!==null || app.signalCode!==null;
  const cleanup = async () => {
    page?.close(); if (!stopped()) app.kill();
    for (let attempt = 0; attempt < 100 && (!stopped() || (pid && alive(pid))); attempt++) await delay(50);
    assert.equal(stopped(),true,'desktop must exit'); if (pid) assert.equal(alive(pid), false, 'owned service must exit');
  };
  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      assert.equal(app.exitCode, null, `desktop must stay alive: ${nativeErrors}`);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); if (target) break; } catch { /* starting */ }
      await delay(200);
    }
    assert.ok(target, 'native WebView must start');
    page = await connectDesktopPage(target);
    const {command,evaluate,waitFor,invoke,screenshot}=page;
    const click = label => evaluate(`(() => {
      const label=${JSON.stringify(label)};
      const matches=Array.from(document.querySelectorAll('button')).filter(button=>button.textContent===label||button.getAttribute('aria-label')===label);
      const button=matches.find(button=>button.getClientRects().length)||matches[0];
      const menu=button?.closest('.new-menu');
      if(menu) { menu.open=true; button.focus(); }
      button?.click();
    })()`);
    const fill = (label, value) => evaluate(`(() => { const control = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(control, ${JSON.stringify(String(value))}); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', {bubbles:true})); })()`);
    const selectTab = async connectionId => {
      const selector = `[role="tab"][data-connection-id="${connectionId}"]`;
      const tab = `document.querySelector(${JSON.stringify(selector)})`;
      await waitFor(`!!${tab}`);
      await evaluate(`${tab}.click()`);
    };
    const searchTerminal = async () => {
      await waitFor(`!!document.querySelector('[data-active="true"] .xterm-helper-textarea')`);
      await evaluate(`document.querySelector('[data-active="true"] .xterm-helper-textarea').focus()`);
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'F',code:'KeyF',windowsVirtualKeyCode:70,modifiers:10});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'F',code:'KeyF',windowsVirtualKeyCode:70,modifiers:10});
      await waitFor(`!!document.querySelector('[aria-label="终端查找文字"]')`);
    };
    const splitTab = async (connectionId, direction = 'horizontal') => {
      const source = `document.querySelector('[role="tab"][data-connection-id="${connectionId}"]')`;
      const edge = direction === 'horizontal' ? 'right' : 'bottom';
      await waitFor(`!!${source} && !!document.querySelector('.pane-active .terminal')`);
      await command('Page.bringToFront');
      const points = await evaluate(`(() => {
        ${source}.scrollIntoView({block:'nearest',inline:'nearest'});
        const from=${source}.getBoundingClientRect();
        const to=document.querySelector('.pane-active .terminal').getBoundingClientRect();
        return {start:{x:from.left+from.width/2,y:from.top+from.height/2},
          end:{x:to.left+to.width*${edge==='right'?.82:.5},y:to.top+to.height*${edge==='bottom'?.82:.5}}};
      })()`);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.start});
      try{
        await command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...points.end});
        await waitFor(`!!document.querySelector('.tab-split-preview[data-edge="${edge}"]')`);
      }finally{
        await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...points.end});
      }
    };
    await waitFor(`document.querySelector('footer')?.dataset.serviceId`);
    const nativeStatus = await invoke('service_status'); pid = nativeStatus.pid;
    // Static exit-policy prose also contains '服务 '; wait for this exact owner.
    await waitFor(`document.querySelector('footer')?.dataset.serviceId===${JSON.stringify(nativeStatus.service_id)}`);
    // Tauri invoke is immutable. Intercept its real custom-protocol fetch
    // response instead; never replace service data with a fabricated success.
    // Assert interception counts in callers so an inactive hook cannot pass.
    const interceptIpc = async ({ op, mode = 'delay', delayMs = 200, command: interceptedCommand = 'logging_request', connectionId }) => {
      assert.ok(['delay', 'error', 'hold', 'hold_error'].includes(mode));
      await evaluate(`(() => {
        if(window.__desktopIpcResponseTest)throw new Error('IPC hook already installed');
        const original=window.fetch;
        const hook={original,count:0,releases:[]};window.__desktopIpcResponseTest=hook;
        window.fetch=async function(input,init){
          const response=await original.call(this,input,init);
          let operation,connection;try{const body=JSON.parse(init?.body);operation=body.request?.op;connection=(body.request?.connection??body.connection)?.connection_id;}catch{}
          if(new URL(String(input)).pathname===${JSON.stringify('/' + interceptedCommand)}&&operation===${JSON.stringify(op)}&&(${JSON.stringify(connectionId)}===undefined||connection===${JSON.stringify(connectionId)})){
            hook.count++;
            if(${JSON.stringify(mode)}==='hold_error')await new Promise(resolve=>hook.releases.push(resolve));
            if(${JSON.stringify(mode)}==='error'||${JSON.stringify(mode)}==='hold_error'){
              const headers=new Headers(response.headers);headers.set('Tauri-Response','error');headers.set('content-type','application/json');headers.delete('content-length');
              return new Response(JSON.stringify('synthetic lost IPC reply after service response'),{status:response.status,headers});
            }
            if(${JSON.stringify(mode)}==='hold')await new Promise(resolve=>hook.releases.push(resolve));
            else await new Promise(resolve=>setTimeout(resolve,${JSON.stringify(delayMs)}));
          }
          return response;
        };
        if(window.fetch===original)throw new Error('IPC response hook is not writable');
      })()`);
      return {
        count: () => evaluate('window.__desktopIpcResponseTest?.count'),
        release: () => evaluate('window.__desktopIpcResponseTest.releases.splice(0).forEach(release=>release())'),
        restore: () => evaluate('window.__desktopIpcResponseTest.releases.splice(0).forEach(release=>release());window.fetch=window.__desktopIpcResponseTest.original;delete window.__desktopIpcResponseTest'),
      };
    };
    const publicCommand = async (method, params = {}) => {
      if (method !== 'Page.reload') return command(method, params);
      await evaluate('window.__desktopHarnessBeforeReload=true');
      const reply = await command(method, params);
      await waitFor(`!window.__desktopHarnessBeforeReload && document.querySelector('footer')?.dataset.serviceId===${JSON.stringify(nativeStatus.service_id)}`);
      return reply;
    };
    const otherPages=async()=> (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(item=>item.type==='page'&&item.id!==target.id);
    return { app, invoke, evaluate, command: publicCommand, waitFor, click, fill, selectTab, searchTerminal, splitTab, screenshot, interceptIpc, otherPages, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
