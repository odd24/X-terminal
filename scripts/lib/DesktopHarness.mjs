import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import path from 'node:path';
import assert from 'node:assert/strict';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function createSshFixtureScope(prefix, {maxRetries=15,
  executable=path.resolve('target/debug/examples/gui_ssh_fixture.exe')}={}) {
  const parent=path.resolve(tmpdir());
  const root=await mkdtemp(path.join(parent,prefix));
  const fixtures=[];
  async function start(name, port) {
    assert.equal(path.basename(name),name);
    const directory=path.join(root,name);
    assert.equal(path.dirname(directory),root);
    await mkdir(directory);
    const child=spawn(executable,[directory,...(port===undefined?[]:[String(port)])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let processError;
    child.on('error',error=>{processError=error;});
    child.stdin.on('error',error=>{processError=error;});
    child.stderr.resume();
    const closed=new Promise(resolve=>child.once('close',resolve));
    fixtures.push({child,closed});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    async function next() {
      let timer;
      try {
        const line=await Promise.race([lines.next(),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Owned SSH fixture did not respond')),8000);
        })]);
        if(line.done)throw processError??new Error('Owned SSH fixture closed before replying');
        return JSON.parse(line.value);
      }finally{clearTimeout(timer);}
    }
    return {...await next(),control:async message=>{
      child.stdin.write(JSON.stringify(message)+'\n');
      return next();
    }};
  }
  async function close() {
    await Promise.all(fixtures.map(async ({child,closed})=>{
      if(!child.stdin.destroyed)child.stdin.end();
      const watchdog=setTimeout(()=>child.kill(),8000);
      try{await closed;}finally{clearTimeout(watchdog);}
    }));
    assert.equal(path.dirname(root),parent);
    assert.ok(path.basename(root).startsWith(prefix));
    await rm(root,{recursive:true,force:true,maxRetries,retryDelay:100});
  }
  return {root,start,close};
}

export async function desktopEvidence(executable) {
  return {executable,desktopSha256:createHash('sha256').update(await readFile(executable)).digest('hex')};
}

export function dragNativeWindow(app, points, {executable=path.resolve('target/debug/shared-terminal-desktop.exe'), title, raise=false, placeAtWorkAreaStart=false, click, atomicDrag=false}={}) {
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1','-TargetProcessId',String(app.pid),'-ExpectedExecutable',executable,
    '-Points',JSON.stringify(points),...(title?['-Title',title]:[]),...(raise?['-Raise']:[]),
    ...(placeAtWorkAreaStart?['-PlaceAtWorkAreaStart']:[]),...(click?['-Click',click]:[]),...(atomicDrag?['-AtomicDrag']:[])],
  {windowsHide:true,timeout:12000,stdio:'pipe',encoding:'utf8'});
}

export async function detachOwnedSession(ui,{executable,serviceId,connection,title='共享终端'}) {
  const pointer=spawn('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1',
    '-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',executable,'-Title',title,
    '-Points',JSON.stringify([{x:-35,y:150,outside:true}]),'-PlaceAtWorkAreaStart','-HoldOutside'],
    {windowsHide:true,stdio:['ignore','pipe','pipe']});
  let error='';
  pointer.stderr.setEncoding('utf8').on('data',chunk=>{error+=chunk;});
  const closed=new Promise(resolve=>pointer.once('close',resolve));
  const lines=createInterface({input:pointer.stdout});
  try{
    const first=await Promise.race([
      new Promise((resolve,reject)=>{
        lines.once('line',resolve);
        pointer.once('error',reject);
      }),
      closed.then(()=>error),
    ]);
    assert.equal(first,'OWNED_POINTER_OUTSIDE');
    await ui.invoke('detach_session',{serviceId,connection});
  }finally{
    lines.close();
    const code=await closed;
    assert.equal(code,0,error);
  }
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

export async function launchDesktop(directory, {fixture = false, executable = path.resolve('target/debug/shared-terminal-desktop.exe'), webviewDirectory = path.join(directory,'webview-ui'), windowsHide = true, extraArgs = [], isolatedPowerShell = false} = {}) {
  assert.ok(path.isAbsolute(directory));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const app = spawn(executable, ['--data-dir', directory, ...(fixture ? ['--test-fixture'] : []), ...extraArgs], {
    windowsHide, stdio: ['ignore','ignore','pipe'], env: { ...process.env,
      ...(isolatedPowerShell ? {SHARED_TERMINAL_ISOLATED_POWERSHELL:'1'} : {}),
      WEBVIEW2_USER_DATA_FOLDER: webviewDirectory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  let nativeErrors='';app.stderr.on('data',chunk=>{nativeErrors=(nativeErrors+chunk.toString()).slice(-8192);});
  let startupError; app.on('error', error => { startupError = error; });
  let page; let pid;
  const stopped=()=>app.exitCode!==null || app.signalCode!==null || (!app.pid&&!!startupError);
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
          let operation,connection;try{const body=JSON.parse(init?.body);operation=body.request?.op??body.action?.kind;connection=(body.request?.connection??body.connection)?.connection_id;}catch{}
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
