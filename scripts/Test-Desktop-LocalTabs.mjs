import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay,dragNativeWindow} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const title=process.argv[2]?'共享终端':'共享终端 · 开发预览';
const webviewOnly=process.argv.includes('--webview-only');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-local-tabs-中文-'));
const result={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),checks:[],screenshots:[]};
const q=JSON.stringify;
const query=css=>`document.querySelector(${q(css)})`;
const tab=name=>`[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent===${q(name)})`;
const active='[data-pane].pane-active';
const consoleView=active+' .local-terminal:not([hidden])';
const output=query(consoleView+' .local-terminal-output');
let ui;

async function tool(name) {
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function focused(name) {
  await ui.waitFor(`${tab(name)}?.ariaSelected==='true'&&document.activeElement?.matches(${q(consoleView+' .xterm-helper-textarea')})`);
}
const press=(point,count=1)=>ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:count});
const release=(point,count=1)=>ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:count});
const point=(element,x=.5,y=.5)=>ui.evaluate(`(()=>{const r=(${element}).getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`);
async function drag(source,to,preview,cancel=false) {
  const from=await point(tab(source));
  await press(from);
  try {
    await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    await ui.waitFor(preview);
    if(cancel)for(const type of ['keyDown','keyUp'])
      await ui.command('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  } finally {
    await release(to);
  }
  await ui.waitFor("!document.querySelector('[data-drag-source]')");
}
async function doubleClick(name) {
  const where=await point(tab(name));
  for(const count of [1,2]){await press(where,count);await release(where,count);}
}
async function copyTab(name,keyboard=false) {
  if(keyboard){
    await ui.evaluate(`${tab(name)}.focus()`);
    for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{
      type,key:'F10',code:'F10',windowsVirtualKeyCode:121,modifiers:8,
    });
  }else{
    const at=await point(tab(name));
    await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...at,button:'right',buttons:2,clickCount:1});
    await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...at,button:'right',buttons:0,clickCount:1});
  }
  await ui.click('复制会话');
}
async function enter() {
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
}
async function screenshot(name) {
  await ui.screenshot(name);
  result.screenshots.push(name);
}
const foreground=()=>ui.waitFor(`${query(consoleView)}.dataset.foreground==='true'`);
async function stopForeground(){
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
  await ui.waitFor(`${query(consoleView)}.dataset.foreground==='false'`);
}
const attempts=()=>ui.evaluate('({...window.localCopyProbe})');
async function noDoubleCopy(name) {
  const previous=await attempts(), tabs=await names();
  await doubleClick(name);await focused(name);
  assert.deepEqual(await attempts(),previous);
  assert.deepEqual(await names(),tabs);
}
const literal=value=>"'"+value.replaceAll("'","''")+"'";
async function powerShellDirectory(name) {
  const file=path.join(root,name+'.txt');
  await type(`Set-Content -LiteralPath ${literal(file)} -Value (Get-Location).Path -Encoding UTF8`);await enter();
  for(let n=0;n<120;n++){
    const actual=(await readFile(file,'utf8').catch(()=>'' )).replace(/^\uFEFF/,'').trim();
    if(actual)return realpath(actual);
    await delay(50);
  }
  assert.fail('PowerShell did not report its working directory');
}
async function adbShortcut() {
  const row=query('.pane-active .adb-shortcut-panel:not([hidden]) .adb-shortcut-run[aria-label="合成 ADB"]');
  if(!await ui.evaluate(`!!${row}?.getClientRects().length`))await ui.click('快捷指令');
  await ui.waitFor(`!!${row}`);
  await ui.evaluate(`${row}.click()`);
  await foreground();
  await ui.waitFor(`${output}?.innerText.includes('ADB_FIXTURE_FOREGROUND:')`);
}
const type=text=>ui.command('Input.insertText',{text});
const names=()=>ui.evaluate("[...document.querySelectorAll('[role=tab]')].map(tab=>tab.textContent)");
const count=expected=>ui.waitFor(`document.querySelectorAll('[data-pane]').length===${expected}`);

try {
  const directory=path.join(root,'工作 路径');
  await mkdir(directory);
  const adb=path.join(root,'adb.exe');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:15000});
  await writeFile(path.join(root,'fixture-root.txt'),root);
  await writeFile(path.join(root,'inventory.txt'),'synthetic device product:mock\n');
  ui=await launchDesktop(root,{executable});
  await ui.command('Page.enable');
  const {identifier}=await ui.command('Page.addScriptToEvaluateOnNewDocument',{source:`
    (() => {
      const originalSnapshotFetch=window.fetch;
      const snapshotReady=new Promise(resolve=>{window.releaseTestSnapshot=resolve;});
      window.fetch=async function(request,init){
        const response=await originalSnapshotFetch.call(this,request,init);
        if(new URL(String(request)).pathname==='/desktop_session_snapshot')await snapshotReady;
        return response;
      };
    })();
  `});
  const reload=ui.command('Page.reload').then(()=>undefined,error=>error);
  await ui.waitFor('!!window.releaseTestSnapshot&&!!document.querySelector(".tools-menu")');
  await ui.command('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts:[{id:randomUUID(),name:'合成 ADB',command:'adb shell'}]}});
  await ui.evaluate(`(()=>{
    const original=window.fetch;
    const counts=window.localCopyProbe={open:0,run:0,input:0,run_adb:0,prepare:0};
    window.fetch=function(request,init){
      const command=new URL(String(request)).pathname;
      if(command==='/prepare_local_adb')counts.prepare++;
      if(command==='/local_terminal'){
        const kind=JSON.parse(init.body).action.kind;
        if(kind in counts)counts[kind]++;
      }
      return original.call(this,request,init);
    };
  })()`);
  await tool('轻量命令行');await focused('本地 1');
  await type(`cd "${directory}"`);await enter();
  await ui.waitFor(`${output}?.title===${q(directory)}`);
  await type('retained-draft');
  await ui.waitFor(`${output}?.innerText.includes('retained-draft')`);
  await ui.evaluate(`window.originalLocal=${output}.querySelector('.xterm')`);
  const originalCalls=await attempts();
  await noDoubleCopy('本地 1');
  await copyTab('本地 1');await focused('本地 2');
  assert.equal(await ui.evaluate(`${output}.title`),directory);
  assert.ok(!(await ui.evaluate(`${output}.innerText`)).includes('retained-draft'));
  assert.deepEqual(await names(),['本地 1','本地 2']);
  assert.deepEqual(await attempts(),{...originalCalls,open:originalCalls.open+1});
  await ui.evaluate(`${tab('本地 1')}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))`);
  assert.deepEqual(await attempts(),{...originalCalls,open:originalCalls.open+1});
  result.checks.push('lightweight double-click makes no request; an explicit menu copy opens one adjacent tab at the tracked cwd without draft or input');

  assert.equal(await ui.evaluate("document.querySelector('footer').dataset.serviceId"),undefined);
  const startupDrop=await point(`${tab('本地 2')}.closest('.connection-tab')`,.88);
  await press(await point(tab('本地 1')));
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...startupDrop,button:'left',buttons:1});
  await ui.waitFor(`!!${query('[data-insertion="after"]')}`);
  await ui.evaluate('window.releaseTestSnapshot()');
  const reloadError=await reload;if(reloadError)throw reloadError;
  await ui.waitFor(`!!${query('[data-insertion="after"]')}`);
  await release(startupDrop);
  await focused('本地 1');
  assert.deepEqual(await names(),['本地 2','本地 1']);
  await drag('本地 1',await point(tab('本地 2'),.1),`!!${query('[data-insertion="before"]')}`);
  assert.deepEqual(await names(),['本地 1','本地 2']);
  result.checks.push('local drag completes across arrival of the first native service snapshot');

  await ui.evaluate(`window.nativeTabDrags=0;window.tabPointerTrace=[];
    document.addEventListener('dragstart',event=>{
      if(event.isTrusted&&event.target.closest('.connection-tab'))window.nativeTabDrags++;
    },true);
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']){
      document.addEventListener(type,event=>{
      if(type==='pointermove'&&!event.buttons)return;
      if(window.tabPointerTrace.length>=40)window.tabPointerTrace.shift();
      window.tabPointerTrace.push([type,event.clientX,event.clientY,event.buttons,event.target.closest('[role=tab]')?.textContent]);
      },true);
    }`);
  const to=await point(`${tab('本地 2')}.closest('.connection-tab')`,.88);
  await drag('本地 1',to,`!!${query('[data-insertion="after"]')}`);
  assert.deepEqual(await names(),['本地 2','本地 1']);
  assert.equal(await ui.evaluate('window.nativeTabDrags'),0);
  await focused('本地 1');
  assert.equal(await ui.evaluate(`${output}.querySelector('.xterm')===window.originalLocal`),true);
  await ui.waitFor(`${output}?.innerText.includes('retained-draft')`);
  await drag('本地 1',await point(query(active+' .local-pane-body'),.85),`!!${query('.tab-split-preview')}`,true);
  await count(1);
  assert.deepEqual(await names(),['本地 2','本地 1']);
  const afterCancel=await attempts(), at=await point(tab('本地 1'));
  await press(at,2);await release(at,2);
  assert.deepEqual(await attempts(),afterCancel);
  await drag('本地 1',await point(query(active+' .local-pane-body'),.85),`!!${query('.tab-split-preview[data-edge="right"]')}`);
  await count(2);await focused('本地 1');
  assert.equal(await ui.evaluate(`${output}.querySelector('.xterm')===window.originalLocal`),true);
  await ui.waitFor(`${output}?.innerText.includes('retained-draft')`);
  await drag('本地 1',await point(tab('本地 2'),.1),`!!${query('[data-insertion="before"]')}`);
  await count(1);await focused('本地 1');
  assert.deepEqual(await names(),['本地 1','本地 2']);
  assert.equal(await ui.evaluate(`${output}.querySelector('.xterm')===window.originalLocal`),true);
  result.checks.push('rail drop reorders, Escape cancels, terminal edge splits, and cross-pane rail drop merges with the same renderer and draft');

  await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");
  await focused('本地 3');
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${output}?.innerText??'')`);
  const powerShellStart=await powerShellDirectory('original-start');
  await type(`Set-Location -LiteralPath ${literal(directory)}`);await enter();
  const shellLocation=await powerShellDirectory('original-after-cd');
  assert.equal(shellLocation,await realpath(directory));
  assert.notEqual(shellLocation,powerShellStart);
  await type("Read-Host 'PRESERVE_FOREGROUND'");await enter();
  await ui.waitFor(`/PRESERVE_FOREGROUND:\\s*$/.test(${output}?.innerText??'')`);
  const shellCalls=await attempts();
  await noDoubleCopy('本地 3');
  await copyTab('本地 3');await focused('本地 4');
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${output}?.innerText??'')`);
  assert.ok(!(await ui.evaluate(`${output}.innerText`)).includes('PRESERVE_FOREGROUND'));
  assert.deepEqual(await attempts(),{...shellCalls,open:shellCalls.open+1});
  assert.equal(await powerShellDirectory('duplicate-start'),powerShellStart);
  await screenshot('windows-local-tabs-context-copy.png');
  await ui.click('本地 3');await focused('本地 3');
  await type('RESPONSE_TO_ORIGINAL');await enter();
  await ui.waitFor(`${output}?.innerText.includes('RESPONSE_TO_ORIGINAL')`);
  await copyTab('本地 3',true);await focused('本地 5');
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${output}?.innerText??'')`);
  assert.equal(await powerShellDirectory('menu-copy-start'),powerShellStart);
  assert.deepEqual(await names(),['本地 1','本地 2','本地 3','本地 5','本地 4']);
  result.copyDirectory={lightweight:'tracked directory after cd',powershell:'recorded launch directory',livePowerShellCdInherited:false};
  result.checks.push('PowerShell double-click makes no request while Read-Host is active; explicit mouse and keyboard menus open independent shells at the launch directory');

  await ui.click('本地 2');await focused('本地 2');
  await adbShortcut();await focused('本地 2');
  await noDoubleCopy('本地 2');
  await type('ONLY_ORIGINAL_ADB');await enter();
  await ui.waitFor(`${output}?.innerText.includes('ADB_FIXTURE_ECHO:ONLY_ORIGINAL_ADB')`);
  await stopForeground();
  await noDoubleCopy('本地 2');
  await copyTab('本地 2');await focused('本地 6');
  assert.equal(await ui.evaluate(`${output}.title`),directory);
  assert.ok(!(await ui.evaluate(`${output}.innerText`)).includes('ONLY_ORIGINAL_ADB'));
  await ui.click('本地 3');await focused('本地 3');
  await adbShortcut();await focused('本地 7');
  await noDoubleCopy('本地 7');
  await stopForeground();
  await noDoubleCopy('本地 7');
  const calls=await readFile(path.join(root,'adb-calls.txt'),'utf8');
  assert.equal(calls.split(/\r?\n/).filter(line=>line.startsWith('shell|')).length,2);
  result.checks.push('double-click makes no additional request before or after ADB finishes in reused ordinary and dedicated result tabs; only two explicit synthetic launches are recorded');
  if(!webviewOnly){
    const from=await point(tab('本地 1'));
    const nativeTarget=await point(`${tab('本地 2')}.closest('.connection-tab')`,.86);
    const beforeNative=await attempts();
    dragNativeWindow(ui.app,[from,{x:(from.x+nativeTarget.x)/2,y:from.y},{...nativeTarget,holdMs:190}],
      {executable,title,raise:true,placeAtWorkAreaStart:true});
    await ui.waitFor(`${tab('本地 2')}.closest('.connection-tab').nextElementSibling?.querySelector('[role="tab"]')===${tab('本地 1')}`);
    assert.equal(await ui.evaluate('window.nativeTabDrags'),0);
    assert.deepEqual(await attempts(),beforeNative);
    result.checks.push('native Windows mouse reorders an existing local tab without a browser drag or terminal open/input');
  }
  result.nativeMouse=!webviewOnly;
  await tool('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  result.result='PASS';
  console.log('PASS local tab pointer drag, split, merge, cancellation and independent copies');
}catch(error){
  result.result='FAIL';
  result.error=String(error.stack);
  if(ui)result.pointerTrace=await ui.evaluate('window.tabPointerTrace').catch(()=>undefined);
  if(ui)await ui.screenshot('local-tabs-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  await writeFile('artifacts/local-tabs-software-result.json',JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
