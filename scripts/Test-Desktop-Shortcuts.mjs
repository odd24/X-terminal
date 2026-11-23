import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-local-directory-中文-'));
const result={result:'IN_PROGRESS',executable,checks:[],nativeChords:[]};
const q=JSON.stringify,query=css=>`document.querySelector(${q(css)})`;
const pane='.pane-active',activeTab=pane+' [role=tab][aria-selected=true]';
const local=pane+' .local-terminal:not([hidden])',localOut=query(local+' .local-terminal-output');
const find='[aria-label="终端查找文字"]',sidebar=pane+' .adb-shortcut-panel:not([hidden])';
const consoleInput=pane+' .xterm-helper-textarea';
const control=2,shift=8,alt=1;
let ui,server,peerLines;
const inFocus=css=>`document.activeElement?.matches(${q(css)})`;
const select=name=>ui.waitFor(`${query(activeTab)}?.textContent===${q(name)}&&${inFocus(consoleInput)}`);
const activeId=()=>ui.evaluate(`${query(activeTab)}?.dataset.connectionId`);
const order=()=>ui.evaluate(`[...document.querySelectorAll(${q(pane+' [role=tab][data-connection-id]')})].map(x=>x.dataset.connectionId)`);
const visible=text=>ui.waitFor(`${localOut}?.innerText.includes(${q(text)})`);
const shell=()=>ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${localOut}?.innerText??'')`);
const quoted=text=>'"'+text+'"';
const literal=text=>"'"+text.replaceAll("'","''")+"'";

async function tool(name){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function native(chord){
  await ui.command('Page.bringToFront');
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),
    '-ExpectedExecutable',executable,'-Title','共享终端','-Points','[]','-Raise','-KeyboardChord',chord],
    {encoding:'utf8',windowsHide:true,timeout:12000});
  result.nativeChords.push(chord);
}
async function key(key,code,vk,modifiers=0,repeat=false){
  for(const type of ['keyDown','keyUp'])
    await ui.command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk,modifiers,autoRepeat:type==='keyDown'&&repeat});
}
const ctrlShift=(name,repeat=false)=>key(name,'Key'+name,name.charCodeAt(0),control|shift,repeat);
const digit=n=>key(String(n),'Digit'+n,48+n,alt);
const enter=(repeat=false)=>key('Enter','Enter',13,0,repeat);
const type=text=>ui.command('Input.insertText',{text});
async function line(text){await type(text);await enter();}
async function current(id){
  await ui.waitFor(`${query(activeTab)}?.dataset.connectionId===${q(id)}&&${inFocus(consoleInput)}`);
}
async function fileContains(file,text){
  for(let n=0;n<140;n++){
    if((await readFile(file,'utf8').catch(()=>null))?.replace(/^\uFEFF/,'').includes(text))return;
    await delay(30);
  }
  assert.fail('Missing owned test output: '+path.basename(file));
}
async function localFind(marker,fromNative=false){
  assert.doesNotMatch(await ui.evaluate(`${localOut}?.innerText`),new RegExp(marker));
  if(fromNative)await native('CtrlShiftF');
  else await ctrlShift('F');
  await ui.waitFor(inFocus(find));
  await type(marker);await enter();
  await ui.waitFor(`${query('[aria-label="终端查找状态"]')}?.textContent.startsWith('1 / 1')`);
  await key('Escape','Escape',27);
  await ui.waitFor(`!${query(find)}&&${inFocus(local+' .xterm-helper-textarea')}`);
}
const rowName=id=>`${sidebar} .adb-shortcut-run[aria-label="${id}"]`;
async function sidebarOn(){
  await ui.waitFor(`!!${query(sidebar)}`);
  await ui.waitFor(inFocus(rowName('模拟设备')));
}
async function sidebarOff(){
  await ui.waitFor(`!${query(sidebar)}&&${inFocus(local+' .xterm-helper-textarea')}`);
}
async function coordinates(element,x=.5,y=.5){
  return ui.evaluate(`(()=>{const r=(${element}).getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`);
}
const tab=id=>query(`[role=tab][data-connection-id="${id}"]`);
async function drag(id,to,preview){
  const from=await coordinates(tab(id));
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
  await ui.waitFor(preview);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
}
async function connectSsh(directory){
  await mkdir(directory);
  server=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  peerLines=createInterface({input:server.stdout})[Symbol.asyncIterator]();
  const next=async()=>{
    let timer;
    try{
      const line=await Promise.race([peerLines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSH fixture timed out')),8000);})]);
      return JSON.parse(line.value);
    }finally{clearTimeout(timer);}
  };
  const peer=await next();
  const command=async op=>{server.stdin.write(JSON.stringify({op})+'\n');return next();};
  await command('keyboard_echo');
  const request=request=>ui.invoke('ssh_request',{request});
  const {connection}=await request({op:'quick_start',request_id:crypto.randomUUID(),cols:80,rows:24,
    settings:{protocol:'ssh2',host:'127.0.0.1',port:peer.port,username:'synthetic',auth:'password',encoding:'utf8'}});
  const ref={connection_id:connection.connection_id,generation:connection.generation};
  const answered=new Set();
  for(let n=0;n<160;n++){
    const status=await request({op:'status',connection:ref});
    assert.notEqual(status.connection.state,'FAILED');
    if(status.connection.state==='CONNECTED')return {ref,command};
    const c=status.challenge;
    if(c&&!answered.has(c.id)){
      answered.add(c.id);
      if(c.kind==='host_key'){
        assert.equal(c.review.candidate.fingerprint,peer.pin);
        await request({op:'answer_host',connection:ref,challenge_id:c.id,approve:true});
      }else await request({op:'authenticate',connection:ref,challenge_id:c.id,use_saved:false,password:peer.password});
    }
    await delay(30);
  }
  assert.fail('Synthetic SSH did not connect');
}

try{
  const profileCheck=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-Command','$PROFILE.CurrentUserCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.AllUsersAllHosts | ForEach-Object {Test-Path -LiteralPath $_}'],
    {windowsHide:true,encoding:'utf8'});
  assert.deepEqual(profileCheck.trim().split(/\s+/),Array(4).fill('False'),'avoid running existing profile scripts');
  const directory=path.join(root,'默认目录 中文');await mkdir(directory);
  const owned=await realpath(root),expectedDirectory=await realpath(directory);
  const adb=path.join(owned,'adb.exe'),script=path.join(owned,'样例脚本.cmd');
  const cwd=path.join(owned,'实际目录.txt'),scriptCalls=path.join(owned,'script-runs.txt'),adbCalls=path.join(owned,'adb-calls.txt');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:12000});
  await writeFile(path.join(owned,'fixture-root.txt'),owned);
  await writeFile(path.join(owned,'inventory.txt'),'mock  device product:synthetic\n');
  await writeFile(script,'@echo off\r\necho run>>"%~dp0script-runs.txt"\r\necho SIDE_SCRIPT_SCROLL\r\nfor /l %%i in (1,1,96) do echo script-line-%%i\r\n');
  ui=await launchDesktop(root,{executable});
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts:[
    {id:crypto.randomUUID(),name:'模拟设备',command:'adb devices -l'},
    {id:crypto.randomUUID(),name:'脚本样本',script_path:script},
  ]}});
  await tool('软件设置');await ui.waitFor("!!document.querySelector('dialog:modal[aria-label=软件设置]')");
  await ui.evaluate("[...document.querySelectorAll('dialog:modal[aria-label=软件设置] button')].find(button=>button.textContent==='本地终端').click()");
  await ui.waitFor("document.querySelector('.local-directory-settings button')?.disabled===false");
  await ui.click('选择文件夹');
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/NativeImportDialog.ps1','-TargetProcessId',String(ui.app.pid),
    '-Root',root,'-Purpose','LocalDirectory','-Action','select','-TargetPath',directory],{windowsHide:true,timeout:18000});
  await ui.waitFor(`${query('.local-directory-settings [aria-label="默认目录"]')}?.textContent===${q(expectedDirectory)}`);
  await native('CtrlShiftT');
  assert.equal((await order()).length,0,'modal consumes the launch shortcut without opening');
  await ui.click('关闭软件设置');
  await native('CtrlShiftT');await select('本地 1');await shell();
  await ctrlShift('T',true);assert.equal((await order()).length,1);
  await line(`Set-Content -LiteralPath ${literal(cwd)} -Value (Get-Location).Path -Encoding UTF8; 'PS_SCROLL_'+'FIRST'; 1..96 | ForEach-Object { 'ps-line-'+$_ }`);
  await fileContains(cwd,expectedDirectory);
  await visible('ps-line-96');await shell();
  await localFind('PS_SCROLL_FIRST',true);
  result.checks.push('native PowerShell and find shortcuts, directory choice, modal exclusion, repeated key suppression, and exact off-screen PowerShell buffer');

  await native('CtrlShiftB');await sidebarOn();
  await key('ArrowDown','ArrowDown',40);await ui.waitFor(inFocus(rowName('脚本样本')));
  await key('ArrowUp','ArrowUp',38);await ui.waitFor(inFocus(rowName('模拟设备')));
  await key('ArrowDown','ArrowDown',40);await ui.waitFor(inFocus(rowName('脚本样本')));
  await enter(true);
  assert.equal(await readFile(scriptCalls,'utf8').catch(()=>null),null);
  await enter();
  await select('脚本样本');
  await visible('script-line-96');
  assert.equal((await readFile(scriptCalls,'utf8')).trim(),'run');
  await native('CtrlShiftB');await sidebarOff();
  await localFind('SIDE_SCRIPT_SCROLL');
  await ui.waitFor(`${query(local)}?.dataset.foreground==='false'`);
  await ctrlShift('B');await sidebarOn();
  await ui.click('管理');
  await ui.evaluate(`${query(sidebar+' input[aria-label="选择 脚本样本"]')}.focus()`);
  await enter();
  assert.equal((await readFile(scriptCalls,'utf8')).trim(),'run');
  await ui.click('完成管理');await ui.click('ADB 设置');
  await ui.waitFor(inFocus('[aria-label="ADB 程序路径"]'));
  const before=await activeId();
  await digit(1);await ctrlShift('T');
  assert.equal(await activeId(),before);assert.equal((await order()).length,2);
  await ui.waitFor(inFocus('[aria-label="ADB 程序路径"]'));
  await ui.click('取消编辑');
  await ctrlShift('B');await sidebarOff();
  await ctrlShift('B');await sidebarOn();
  await enter();await visible('List of devices attached');
  await ui.waitFor(inFocus(local+' .xterm-helper-textarea'));
  assert.equal((await readFile(adbCalls,'utf8')).trim().split(/\r?\n/).length,1);
  await ctrlShift('B');await sidebarOff();
  const scriptId=await activeId();
  result.checks.push('shortcut list receives focus; arrows and Enter execute one BAT and one ADB; editing and management do not launch or switch; script scrollback is searchable');

  await tool('轻量命令行');await select('本地 2');
  const lightId=await activeId(),raw=path.join(owned,'raw-keys.txt'),child=path.join(owned,'受控前台.cjs');
  await writeFile(child,`const fs=require('node:fs');
process.stdin.setRawMode(true);
process.stdin.on('data',bytes=>fs.appendFileSync(process.argv[2],bytes));
console.log('LIGHT_SCROLL_FIRST');
for(let i=1;i<=96;i++)console.log('light-line-'+i);
console.log('CHILD_RAW_READY');
`);
  await line([quoted(process.execPath),quoted(child),quoted(raw)].join(' '));
  await visible('CHILD_RAW_READY');
  await localFind('LIGHT_SCROLL_FIRST');
  await type('BEFORE_SWITCH');await fileContains(raw,'BEFORE_SWITCH');
  await native('CtrlShiftTab');await current(scriptId);
  await native('CtrlTab');await current(lightId);
  await native('Alt0');await current(lightId);
  await ctrlShift('B');await sidebarOn();
  await native('CtrlShiftB');await sidebarOff();
  await type('AFTER_SWITCH');await fileContains(raw,'AFTER_SWITCH');
  assert.equal(await readFile(raw,'utf8'),'BEFORE_SWITCHAFTER_SWITCH','bound chords did not leak to the running process');
  result.checks.push('lightweight scrollback, native cycle in both directions, missing Alt+0, and exact running child input after focus restoration');

  const ssh=await connectSsh(path.join(owned,'ssh'));
  await ui.waitFor(`!!${tab(ssh.ref.connection_id)}`);
  for(let n=3;n<=8;n++){await tool('轻量命令行');await select('本地 '+n);}
  let mixed=await order();
  assert.equal(mixed.length,10);
  assert.equal(mixed[0],ssh.ref.connection_id);
  await native('Alt0');await current(mixed[9]);
  await native('Alt1');await current(mixed[0]);
  await ui.waitFor(`${query(pane)}?.dataset.renderedId===${q(ssh.ref.connection_id)}`);
  await type('SSH_ONLY_AFTER_ALT');
  await ui.waitFor(`${query(pane+' > .terminal')}?.textContent.includes('SSH_ONLY_AFTER_ALT')`);
  await ctrlShift('F');await ui.waitFor(inFocus(find));
  await type('SSH_ONLY_AFTER_ALT');await enter();
  await ui.waitFor(`${query('[aria-label="终端查找状态"]')}?.textContent.startsWith('1 / 1')`);
  await key('Escape','Escape',27);
  await ui.waitFor(inFocus('.tools-menu > summary'));
  await digit(2);await current(mixed[1]);
  await native('AltNumpad1');await current(mixed[0]);
  await digit(2);await current(mixed[1]);
  const received=Buffer.from((await ssh.command('metrics')).received.flat()).toString();
  assert.equal(received,'SSH_ONLY_AFTER_ALT');
  await drag(mixed[1],await coordinates(tab(mixed[0]),.2),"!!document.querySelector('[data-insertion=before]')");
  await ui.waitFor(`document.querySelector('.pane-active [role=tab]')?.dataset.connectionId===${q(mixed[1])}`);
  mixed=await order();
  await digit(2);await current(mixed[1]);
  await native('Alt1');await current(mixed[0]);
  const originalPane=await ui.evaluate(`${query(pane)}.dataset.pane`);
  await drag(mixed[0],await coordinates(query(pane+' .local-pane-body'),.86,.5),"!!document.querySelector('.tab-split-preview[data-edge=right]')");
  await ui.waitFor(`document.querySelectorAll('[data-pane]').length===2&&${query(pane)}.dataset.pane!==${q(originalPane)}`);
  assert.deepEqual(await order(),[mixed[0]]);
  await ctrlShift('T');await select('本地 9');await shell();
  const newId=await activeId();
  await digit(0);await current(newId);
  await key('Tab','Tab',9,control);await current(mixed[0]);
  assert.equal(await ui.evaluate(`document.querySelector('[data-pane="${originalPane}"]').querySelectorAll('[role=tab]').length`),9);
  assert.equal(await readFile(raw,'utf8'),'BEFORE_SWITCHAFTER_SWITCH');
  result.checks.push('10 mixed tabs, native Alt+1/0 and keypad, exact SSH echo and search, drag-updated order, split-local cycling and launch');

  await tool('键盘快捷键');
  await ui.waitFor(`!!${query('dialog:modal[aria-label="键盘快捷键"]')}`);
  await ui.screenshot('windows-0.1.21-keyboard-shortcuts.png');
  await ui.click('关闭');
  await tool('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  result.result='PASS';
  console.log('PASS native desktop shortcuts, mixed pane focus and real local search buffers');
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)await ui.screenshot('windows-0.1.21-keyboard-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(server?.exitCode===null){const ended=once(server,'exit');server.kill();await ended;}
  await writeFile('artifacts/desktop-shortcuts-software-result.json',JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
