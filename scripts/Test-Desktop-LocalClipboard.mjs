import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const reportPrefix=process.argv[3]??'windows-0.1.25';
const previous=path.resolve('artifacts/SharedTerminal-0.1.24-windows-x64/shared-terminal-desktop.exe');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-local-clipboard-中文-'));
const evidence={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),checks:[]};
const q=JSON.stringify;
const active='.pane-active .local-terminal:not([hidden])';
const output=active+' .local-terminal-output';
const query=css=>`document.querySelector(${q(css)})`;
const preview='dialog[aria-label="本地粘贴确认"]';
const menu='[role="menu"][aria-label="本地终端右键菜单"]';
const byLabel=label=>query(`[aria-label="${label}"]`);
const writeList=()=>ui.evaluate('window.clipFixture.writes');
const readCount=()=>ui.evaluate('window.clipFixture.reads');
const actionCount=kind=>ui.evaluate(`window.clipFixture.actions.filter(a=>a.kind===${q(kind)}).length`);
const inputs=()=>ui.evaluate("window.clipFixture.actions.filter(a=>a.kind==='input')");
let ui;

async function tool(name){
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click(name);
}
async function key(key,code,vk,modifiers=0){
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,modifiers,text:key==='Enter'?'\r':undefined});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});
}
async function hook(){
  await ui.evaluate(`(()=>{
    const test=window.clipFixture={text:'',writes:[],reads:0,actions:[],waiting:[],hold:false,failWrite:false,unexpectedClipboardEvents:0};
    for(const type of ['copy','paste'])document.addEventListener(type,event=>{
      test.unexpectedClipboardEvents++;
      event.preventDefault();event.stopImmediatePropagation();
    },true);
    Object.defineProperty(navigator.clipboard,'writeText',{value:async text=>{
      test.writes.push(text);
      if(test.failWrite)throw new Error('fixture clipboard failure');
    }});
    const original=window.fetch;
    window.fetch=async function(input,init){
      const command=new URL(String(input)).pathname;
      if(command==='/terminal_clipboard_read'){
        const value=test.text;test.reads++;
        if(test.hold)await new Promise(resolve=>test.waiting.push(resolve));
        return new Response(JSON.stringify(value),{headers:{'content-type':'application/json','Tauri-Response':'ok'}});
      }
      if(command==='/local_terminal'){
        try{
          const action=JSON.parse(init.body).action;
          if(['input','run','power_shell_paste'].includes(action.kind))test.actions.push(action);
        }catch{}
      }
      return original.call(this,input,init);
    };
  })()`);
}
async function setClipboard(text,hold=false){
  await ui.evaluate(`Object.assign(window.clipFixture,{text:${q(text)},hold:${hold}})`);
}
async function ready(name){
  await ui.waitFor(`document.querySelector('.pane-active [role="tab"][aria-selected=true]')?.textContent===${q(name)}
    &&document.activeElement?.matches(${q(active+' .xterm-helper-textarea')})`);
}
const insert=text=>ui.command('Input.insertText',{text});
const enter=()=>key('Enter','Enter',13);
const look=text=>ui.waitFor(`${query(output)}?.innerText.includes(${q(text)})`);
async function rightClick(){
  const point=await ui.evaluate(`(()=>{const r=${query(output+' .xterm-screen')}.getBoundingClientRect();return{x:r.x+r.width*.6,y:r.y+r.height*.3}})()`);
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...point});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...point});
}
const selected=()=>ui.evaluate(`!!${query(output+' .xterm-selection > div')}`);
async function selectVisible(text){
  const bounds=await ui.evaluate(`(()=>{
    const rows=${query(output+' .xterm-rows')};
    const walker=document.createTreeWalker(rows,NodeFilter.SHOW_TEXT);
    for(let node;node=walker.nextNode();){
      const at=node.textContent.indexOf(${q(text)});
      if(at<0)continue;
      const range=document.createRange();
      range.setStart(node,at);range.setEnd(node,at+${text.length});
      const r=range.getBoundingClientRect();
      return {from:{x:r.left+.2,y:r.top+r.height/2},to:{x:r.right+.2,y:r.top+r.height/2}};
    }
  })()`);
  assert.ok(bounds,'fixture text must be rendered in one visible xterm DOM run');
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...bounds.from});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...bounds.to});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...bounds.to});
  await ui.waitFor(`!!${query(output+' .xterm-selection > div')}`);
}
async function settings(expected){
  await tool('软件设置');
  await ui.waitFor(`!!${query('dialog:modal[aria-label="软件设置"]')}`);
  await ui.evaluate("[...document.querySelectorAll('dialog:modal button')].find(b=>b.textContent==='本地终端').click()");
  await ui.waitFor(`${byLabel('终端右键行为')}?.value===${q(expected)}&&!${byLabel('终端右键行为')}.disabled`);
}
async function mode(before,next){
  await settings(before);
  await ui.fill('终端右键行为',next);
  await ui.waitFor(`${byLabel('终端右键行为')}.value===${q(next)}&&!${byLabel('终端右键行为')}.disabled
     &&${query('[aria-label="本地终端右键"] [role=status]')}?.textContent==='已保存'`);
  await ui.screenshot(`${reportPrefix}-local-right-click-settings.png`);
  await ui.click('关闭软件设置');
}
async function exit(activeTabs){
  await tool('退出桌面');
  if(activeTabs){
    await ui.waitFor(`!!${query('dialog:modal[aria-label="退出桌面确认"]')}`);
    await ui.click('确认退出并停止服务');
  }
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();ui=undefined;
}
async function waitCount(read,n){
  for(let attempts=0;attempts<100;attempts++){if(await read()===n)return;await delay(40);}
  assert.equal(await read(),n);
}
async function waitInput(id,text,previous){
  await waitCount(()=>actionCount('input'),previous+1);
  const item=(await inputs()).at(-1);
  assert.equal(item.id,id);
  assert.equal(item.text,text);
  return item.request;
}
const activeId=()=>ui.evaluate("document.querySelector('.pane-active [role=tab][aria-selected=true]').dataset.connectionId");
const pastePreview=()=>ui.waitFor(`!!${query(preview)}`);

try{
  const adb=path.join(root,'adb.exe'), script=path.join(root,'本地脚本测试.cmd');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:15000});
  await writeFile(path.join(root,'fixture-root.txt'),root);
  await writeFile(path.join(root,'inventory.txt'),'fixture device product:mock\n');
  await writeFile(script,'@echo off\r\nset /p answer=SCRIPT_INPUT:\r\necho SCRIPT_RESULT_%answer%\r\n');
  const shortcuts=[{id:randomUUID(),name:'模拟 ADB',command:'adb shell'},{id:randomUUID(),name:'测试脚本',command:'',script_path:script}];
  ui=await launchDesktop(root,{executable:previous});
  const seed=await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts}});
  await exit(false);
  ui=await launchDesktop(root,{executable});
  assert.equal((await ui.invoke('service_status')).fixture,false);
  assert.deepEqual(await ui.invoke('local_adb_settings',{settings:null}),seed);
  await hook();
  await settings('smart');await ui.click('关闭软件设置');
  await tool('轻量命令行');await ready('本地 1');
  await insert('COPY_EXACT_123');await look('COPY_EXACT_123');
  await selectVisible('COPY_EXACT_123');
  await rightClick();await waitCount(async()=>(await writeList()).length,1);
  assert.deepEqual(await writeList(),['COPY_EXACT_123']);
  assert.equal(await readCount(),0);
  await ui.waitFor(`!${query(output+' .xterm-selection > div')}`);
  await selectVisible('COPY_EXACT_123');
  await ui.evaluate('window.clipFixture.failWrite=true');
  await rightClick();await ui.waitFor("document.body.innerText.includes('复制失败，选区已保留')");
  assert.equal(await selected(),true);assert.equal(await readCount(),0);
  await ui.evaluate('window.clipFixture.failWrite=false');
  await rightClick();await waitCount(async()=>(await writeList()).length,3);
  await ui.waitFor(`!${query(output+' .xterm-selection > div')}`);
  await key('c','KeyC',67,2);await insert('AB');
  await key('ArrowLeft','ArrowLeft',37);
  await setClipboard('中文 X');await rightClick();await look('A中文 XB');
  assert.equal(await actionCount('run'),0);
  await setClipboard('pwd\r\n');await rightClick();await pastePreview();
  await ui.click('取消粘贴');assert.equal(await actionCount('run'),0);
  await key('c','KeyC',67,2);
  await rightClick();await pastePreview();
  await ui.click('确认粘贴');await look('pwd');
  assert.equal(await actionCount('run'),0);
  await enter();await waitCount(()=>actionCount('run'),1);
  assert.equal(await ui.evaluate("window.clipFixture.actions.find(a=>a.kind==='run').line"),'pwd');
  await ui.waitFor(`${query(output)}.innerText.includes('> pwd')`);
  await setClipboard('pwd\ncd\n');await rightClick();await pastePreview();
  assert.equal(await ui.evaluate(`[...${query(preview)}.querySelectorAll('button')].find(b=>b.textContent==='确认粘贴').disabled`),true);
  await ui.click('取消粘贴');
  evidence.checks.push('existing database, default smart, selected exact copy, write failure keeps selection, insertion at cursor, idle trailing line becomes a draft until explicit Enter');

  await mode('smart','menu');
  await setClipboard('MENU_TEXT');const readerBefore=await readCount();
  await rightClick();await ui.waitFor(`!!${query(menu)}`);
  assert.equal(await readCount(),readerBefore);
  await ui.screenshot(`${reportPrefix}-local-right-click-menu.png`);
  await ui.evaluate(`[...${query(menu)}.querySelectorAll('button')].find(b=>b.textContent==='粘贴').click()`);
  await look('MENU_TEXT');
  await selectVisible('MENU_TEXT');
  await rightClick();await ui.waitFor(`!!${query(menu)}`);
  await ui.evaluate(`[...${query(menu)}.querySelectorAll('button')].find(b=>b.textContent==='复制').click()`);
  await waitCount(async()=>(await writeList()).length,4);
  assert.equal((await writeList()).at(-1),'MENU_TEXT');
  await ui.waitFor(`!${query(output+' .xterm-selection > div')}`);
  await selectVisible('MENU_TEXT');
  await key('C','KeyC',67,10);
  await waitCount(async()=>(await writeList()).length,5);
  assert.equal((await writeList()).at(-1),'MENU_TEXT');
  assert.equal(await selected(),true);
  assert.equal(await ui.evaluate('window.clipFixture.unexpectedClipboardEvents'),0);
  await exit(true);
  ui=await launchDesktop(root,{executable,isolatedPowerShell:true});
  await hook();await settings('menu');await ui.click('关闭软件设置');
  await mode('menu','smart');
  await ui.click('本地终端（PowerShell）');await ready('本地 1');
  await look('PS ');
  const ps=await activeId();
  const rawBefore=await actionCount('input');
  await setClipboard('PS_SINGLE_中文');await rightClick();await waitInput(ps,'PS_SINGLE_中文',rawBefore);
  const multiline="; Write-Output 'LOCAL_PASTE_FIXTURE'\r\n#文\n";
  const before=await actionCount('input');
  await setClipboard(multiline);await rightClick();await pastePreview();
  assert.equal(await actionCount('input'),before);
  assert.match(await ui.evaluate(`${byLabel('本地粘贴内容预览')}.textContent`),/\\r\\n.*文\\n/);
  await ui.screenshot(`${reportPrefix}-local-paste-confirmation.png`);
  await ui.click('取消粘贴');assert.equal(await actionCount('input'),before);
  await rightClick();await pastePreview();await ui.click('确认粘贴');
  await waitCount(()=>actionCount('power_shell_paste'),1);
  assert.equal(await actionCount('input'),before);
  const pasted=await ui.evaluate("window.clipFixture.actions.find(a=>a.kind==='power_shell_paste')");
  assert.equal(pasted.id,ps);
  assert.ok(pasted.generation>0);
  assert.equal(pasted.text,multiline.replaceAll('\r\n','\n'));

  const reads=await readCount();await setClipboard('LATE_READ',true);await rightClick();
  await waitCount(readCount,reads+1);
  await tool('轻量命令行');await ready('本地 2');
  await ui.click('本地 1');await ready('本地 1');
  await ui.evaluate('window.clipFixture.waiting.splice(0).forEach(resolve=>resolve())');
  await delay(180);
  assert.equal(await actionCount('input'),before);
  await setClipboard('KEYBOARD_PASTE');await key('V','KeyV',86,10);
  await waitInput(ps,'KEYBOARD_PASTE',before);
  assert.equal(await ui.evaluate('window.clipFixture.unexpectedClipboardEvents'),0,'shortcut must suppress the browser default paste event');
  const beforeClose=await readCount();
  await setClipboard('CLOSED_TAB',true);await rightClick();await waitCount(readCount,beforeClose+1);
  await ui.click('关闭 本地 1');await ready('本地 2');
  await ui.evaluate('window.clipFixture.waiting.splice(0).forEach(resolve=>resolve())');
  await delay(180);
  assert.equal(await actionCount('input'),before+1);
  evidence.checks.push('menu explicit copy/paste, live setting, restart, PowerShell editable LF normalization and confirmation, switch-away/back and close invalidate delayed paste, Ctrl+Shift+V');

  await ui.click('本地 2');await ready('本地 2');
  if(!await ui.evaluate(`!!${query('.adb-shortcut-panel:not([hidden])')}`))await ui.click('快捷指令');
  await ui.waitFor(`!!${byLabel('模拟 ADB')}`);
  await ui.click('模拟 ADB');await look('ADB_FIXTURE_FOREGROUND');
  const adbId=await activeId(),count=await actionCount('input');
  await setClipboard('ADB_TEST');await rightClick();await waitInput(adbId,'ADB_TEST',count);
  await enter();await look('ADB_FIXTURE_ECHO:ADB_TEST');
  const runScript=()=>ui.evaluate(`${query('.adb-shortcut-panel:not([hidden]) .adb-shortcut-run[aria-label="测试脚本"]')}.click()`);
  await runScript();await ready('测试脚本');await look('SCRIPT_INPUT:');
  const scriptId=await activeId(),scriptCount=await actionCount('input');
  await setClipboard('SCRIPT_BYTES\r');await rightClick();await pastePreview();
  await ui.click('确认粘贴');await waitInput(scriptId,'SCRIPT_BYTES\r',scriptCount);
  await look('SCRIPT_RESULT_SCRIPT_BYTES');
  await runScript();
  await ui.waitFor(`document.querySelector('.pane-active [role=tab][aria-selected=true]')?.dataset.connectionId!==${q(scriptId)}`);
  await ready('测试脚本');await look('SCRIPT_INPUT:');
  const readsBeforeExit=await readCount();
  await setClipboard('STALE_TASK',true);await rightClick();
  await waitCount(readCount,readsBeforeExit+1);
  await enter();
  await ui.waitFor(`${query(active)}.dataset.foreground==='false'`);
  const finishedInputs=await actionCount('input');
  await ui.evaluate('window.clipFixture.waiting.splice(0).forEach(resolve=>resolve())');
  await delay(180);
  assert.equal(await actionCount('input'),finishedInputs);
  evidence.checks.push('simulated ADB interactive input without implicit Enter and owned CMD exact trailing CR after approval');
  await exit(true);
  evidence.result='PASS';
  console.log('PASS Windows local right-click modes, exact data, approval, routing and persistence');
}catch(error){
  evidence.result='FAIL';evidence.error=String(error.stack);
  await ui?.screenshot(`${reportPrefix}-local-clipboard-failure.png`).catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  await writeFile(`artifacts/${reportPrefix}-local-clipboard-result.json`,JSON.stringify(evidence,null,2)+'\n');
  assert.equal(path.dirname(root),await realpath(tmpdir()));
  assert.ok(path.basename(root).startsWith('shared-terminal-local-clipboard-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
