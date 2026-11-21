import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {connectDesktopPage, delay, dragNativeWindow, launchDesktop} from './lib/DesktopHarness.mjs';

const desktop=path.resolve(process.argv[2]);
const uartMode=process.argv.includes('--uart');
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-session-copy-ui-中文-'));
const processes=[];
const title='共享终端';
const childTitle='共享终端 · 独立会话';
let ui, detached, service, evidence;
const ref=({connection_id,generation})=>({connection_id,generation});
const q=css=>`document.querySelector(${JSON.stringify(css)})`;
const tab=c=>q(`[role="tab"][data-connection-id="${c.connection_id}"]`);
const pane=q('[data-pane][data-active="true"]');
const ssh=request=>ui.invoke('ssh_request',{request});
const serial=request=>ui.invoke('serial_request',{request});
const logs=(c,request)=>ui.invoke('logging_request',{request:{connection:ref(c),...request}});
const sessions=()=>ui.invoke('service_list');
const native=(file,args)=>execFileSync('pwsh',['-NoProfile','-File',file,...args],
  {encoding:'utf8',windowsHide:true,timeout:18000}).trim();
const metric=(peer)=>peer.control({op:'metrics'});

async function wait(read,label){
  for(let i=0;i<150;i++){const value=await read();if(value)return value;await delay(70);}
  throw new Error(`Timed out: ${label}`);
}
async function source(name){
  const dir=path.join(root,name);
  await mkdir(dir);
  const process=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[dir],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  processes.push(process);
  const lines=createInterface({input:process.stdout})[Symbol.asyncIterator]();
  async function read(){
    let timer;
    try{return JSON.parse((await Promise.race([lines.next(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Owned SSH fixture did not respond')),8000);
    })])).value);}
    finally{clearTimeout(timer);}
  }
  return {...await read(),control:async message=>{process.stdin.write(JSON.stringify(message)+'\n');return read();}};
}
async function connect(peer,saved){
  const settings={protocol:'ssh2',host:'localhost',port:peer.port,username:'synthetic',auth:'password',encoding:'utf8'};
  const profileId=crypto.randomUUID();
  if(saved){
    const reply=await ui.invoke('config_request',{request:{op:'save_profile',profile:{id:profileId,folder_id:null,name:'保存在此隔离库的验证会话',settings},
      credential:{action:'replace',value:{password:peer.password,private_key:null,passphrase:null}}}});
    assert.equal(reply.result,'saved_profile');
  }
  const args={request_id:requestId(),cols:80,rows:24};
  const {connection}=await ssh(saved?{op:'start',profile_id:profileId,...args}:{op:'quick_start',settings,...args});
  const answered=new Set();
  await wait(async()=>{
    const status=await ssh({op:'status',connection:ref(connection)});
    assert.notEqual(status.connection.state,'FAILED');
    const challenge=status.challenge;
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,peer.pin);
        await ssh({op:'answer_host',connection:ref(connection),challenge_id:challenge.id,approve:true});
      }else{
        assert.equal(challenge.kind,'credentials');
        await ssh({op:'authenticate',connection:ref(connection),challenge_id:challenge.id,use_saved:saved,password:saved?null:peer.password});
      }
    }
    return status.connection.state==='CONNECTED';
  },'original SSH connected');
  await peer.control({op:'keyboard_echo'});
  return connection;
}
async function click(page,expression,kind='Left',caption=title){
  await page.command('Page.bringToFront');
  const point=await page.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  native('scripts/lib/Drag-TestWindow.ps1',['-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',desktop,'-Title',caption,
    '-Points',JSON.stringify([point]),'-Click',kind,'-Raise']);
}
async function activate(connection){
  await ui.selectTab(connection.connection_id);
  await ready(connection);
}
function ready(connection){
  return ui.waitFor(`${pane}?.dataset.renderedId===${JSON.stringify(connection.connection_id)}&&
    document.querySelector('footer')?.textContent.includes('输入就绪')`);
}
const copyMenu=q('[role="menu"][aria-label="会话标签菜单"]');
async function openCopy(page,connection,caption=title){
  await page.waitFor(`!!${tab(connection)}`);
  await click(page,tab(connection),'Right',caption);
  await page.waitFor(`${copyMenu}?.querySelector('[role="menuitem"]')?.getAttribute('aria-disabled')==='false'`);
  return `${copyMenu}.querySelector('[role="menuitem"]')`;
}
async function childOf(previous,protocol){
  return wait(async()=> (await sessions()).find(item=>!previous.has(item.connection_id)&&item.protocol===protocol&&item.state==='CONNECTED'),'independent copy connected');
}
async function verifyAdjacent(source,copy){
  await ui.waitFor(`(${tab(source)}.closest('.connection-tab').nextElementSibling?.querySelector('[role="tab"]'))?.dataset.connectionId===${JSON.stringify(copy.connection_id)}`);
}
async function splitRight(connection){
  const points=await ui.evaluate(`(()=>{
    const a=${tab(connection)}.getBoundingClientRect(),b=${pane}.querySelector('.terminal').getBoundingClientRect();
    return [{x:a.x+a.width/2,y:a.y+a.height/2},{x:a.x+a.width/2,y:a.bottom+32},{x:b.x+b.width*.84,y:b.y+b.height*.5,holdMs:260}];
  })()`);
  dragNativeWindow(ui.app,points,{executable:desktop,title,raise:true});
  await ui.waitFor(`document.querySelectorAll('[data-pane]').length===2&&${tab(connection)}?.closest('[data-pane]')?.dataset.pane!==${pane}.dataset.pane`);
}
async function readOutput(c){
  const reply=await ui.invoke('service_read',{connection:ref(c),cursor:1});
  return Buffer.from(reply.events.flatMap(event=>event.bytes)).toString();
}
async function keyGoesTo(connection,value,others){
  await ready(connection);
  await ui.evaluate(`${pane}.querySelector('.xterm-helper-textarea').focus()`);
  await ui.command('Input.insertText',{text:value});
  await wait(async()=> (await readOutput(connection)).includes(value),'echo on exact new SSH connection');
  for(const other of others)assert.ok(!(await readOutput(other)).includes(value),'original and other endpoint did not echo copy input');
}
async function seam(page){
  return page.evaluate(`(()=>{
    const bar=document.querySelector('.window-chrome'),active=bar.querySelector('.connection-tab:has([aria-selected="true"])');
    const terminal=document.querySelector('[data-pane][data-active="true"] .terminal');
    const rules=getComputedStyle(active),inactive=bar.querySelector('.connection-tab:has([aria-selected="false"])');
    return {gap:terminal.getBoundingClientRect().top-active.getBoundingClientRect().bottom,
      left:active.getBoundingClientRect().left,terminalLeft:terminal.getBoundingClientRect().left,
      active:getComputedStyle(active).backgroundColor,terminal:getComputedStyle(terminal).backgroundColor,
      inactive:inactive?getComputedStyle(inactive).backgroundColor:null,
      toolbar:getComputedStyle(bar).backgroundColor,topRadius:rules.borderTopLeftRadius,bottomRadius:rules.borderBottomLeftRadius,
      overshoot:bar.scrollWidth-bar.clientWidth,width:innerWidth};
  })()`);
}
function verifySeam(visual){
  assert.ok(Math.abs(visual.gap)<1,JSON.stringify(visual));
  assert.equal(visual.active,visual.terminal);
  assert.notEqual(visual.toolbar,visual.terminal);
  assert.ok(!visual.inactive||visual.inactive===visual.toolbar||visual.inactive==='rgba(0, 0, 0, 0)');
  assert.ok(parseFloat(visual.topRadius)>0);
  assert.equal(visual.bottomRadius,'0px');
  assert.ok(visual.overshoot<=1,JSON.stringify(visual));
}
function fit(width,height){
  native('scripts/lib/Resize-TestWindow.ps1',['-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',desktop,
    '-Width',String(width),'-Height',String(height)]);
}
const windowQuery=(page,operation,label='main')=>page.invoke(`plugin:window|${operation}`,{label});
async function verifyWindow(page,caption,label='main'){
  const chrome=q('.window-title');
  const start=await page.evaluate(`(()=>{const b=${chrome}.getBoundingClientRect();return{x:b.left+40,y:b.top+b.height/2};})()`);
  const before=await windowQuery(page,'outer_position',label);
  dragNativeWindow(ui.app,[start,{x:start.x+32,y:start.y+24},{x:start.x+62,y:start.y+40}],{executable:desktop,title:caption,raise:true});
  const moved=await windowQuery(page,'outer_position',label);
  assert.ok(Math.abs(moved.x-before.x)>20||Math.abs(moved.y-before.y)>20,JSON.stringify({before,moved}));
  await click(page,chrome,'Double',caption);
  await wait(()=>windowQuery(page,'is_maximized',label),'native title double click maximized');
  await click(page,q('button[aria-label="还原窗口"]'),'Left',caption);
  await wait(async()=>!(await windowQuery(page,'is_maximized',label)),'native window restored');
  return {moved:true,maximized:true,restored:true};
}
async function close(){
  await click(ui,q('.window-close'));
  await ui.waitFor(`!!document.querySelector('dialog[aria-label="退出桌面确认"]')`);
  await ui.click('确认退出并停止服务');
  await wait(()=>ui.app.exitCode===0,'owned desktop exited');
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',service.service_id+'.json'),'utf8'));
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');
  assert.equal(receipt.exited,true);
  await ui.close();
  ui=undefined;
}

try{
  ui=await launchDesktop(root,{executable:desktop,fixture:uartMode});
  service=await ui.invoke('service_status');
  assert.equal(service.fixture,uartMode);
  if(uartMode){
    const inventory=await serial({op:'inventory'});
    assert.deepEqual(inventory.devices.map(item=>item.port),['COM7']);
    const settings={protocol:'serial',port:'COM7',baud_rate:57600,data_bits:8,stop_bits:1,parity:'none',flow:'none',
      dtr_on_open:false,rts_on_open:false,encoding:'gbk'};
    const {connection}=await serial({op:'quick_start',settings,request_id:requestId(),revision:inventory.revision,device_id:inventory.devices[0].device_id});
    await wait(async()=> (await serial({op:'status',connection:ref(connection)})).connection.state==='CONNECTED','owned memory UART ready');
    await activate(connection);
    await click(ui,await openCopy(ui,connection));
    await ui.waitFor(`document.querySelector('dialog:modal[aria-label="连接串口设备"]')?.textContent.includes('没有其他可选端口')`);
    assert.equal(await ui.evaluate(`${q('[aria-label="UART波特率"]')}.value`),'57600');
    assert.equal(await ui.evaluate(`${q('[aria-label="UART编码"]')}.value`),'gbk');
    assert.equal(await ui.evaluate(`${q('[aria-label="UART端口"]')}.options.length`),1);
    assert.equal(await ui.evaluate(`${q('button.primary-action')}.disabled`),true);
    await ui.screenshot('desktop-0.1.9-copy-uart-exclusive.png');
    const fresh=await serial({op:'inventory'});
    await assert.rejects(serial({op:'quick_start',settings,request_id:requestId(),revision:fresh.revision,device_id:fresh.devices[0].device_id}),/InvalidState/);
    await ui.click('取消连接窗口');
    assert.deepEqual((await sessions()).map(item=>({id:item.connection_id,state:item.state})),[{id:connection.connection_id,state:'CONNECTED'}]);
    evidence={result:'PASS',memoryUart:true,excludedOriginalPort:true,settingsRetained:true,serviceRejectedSamePort:true};
  }else{
    const first=await source('saved-peer'),second=await source('temporary-peer');
    const a=await connect(first,true), b=await connect(second,false);
    await activate(b);
    await ui.waitFor(`${tab(a)}?.getAttribute('aria-label')==='localhost'&&${tab(b)}?.getAttribute('aria-label')==='localhost'`);
    await first.control({op:'push',text:'ORIGINAL_OUTPUT_REMAINS\r\n'});
    await wait(async()=> (await readOutput(a)).includes('ORIGINAL_OUTPUT_REMAINS'),'original output marker arrived');
    const rates={segment_bytes:131072,segments:2};
    const oldLog=await logs(a,{op:'start',request_id:requestId(),limits:rates});
    let aAction=await openCopy(ui,a);
    assert.equal(await ui.evaluate(`${tab(b)}.getAttribute('aria-selected')`),'true');
    const menuImage=await ui.command('Page.captureScreenshot',{format:'png'});
    await writeFile('artifacts/desktop-0.1.9-copy-background-ssh.png',Buffer.from(menuImage.data,'base64'));
    if(!(await ui.evaluate(`!!${copyMenu}`)))aAction=await openCopy(ui,a);
    const fixedReply=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'error'});
    try{
      await click(ui,aAction);
      await ui.waitFor("[...document.querySelectorAll('dialog:modal button')].some(button=>button.textContent==='查询本次连接')");
      assert.equal(await fixedReply.count(),1,'one attempt with a lost Desktop start-fixed answer');
    }finally{await fixedReply.restore();}
    await ui.click('查询本次连接');
    const aCopy=await childOf(new Set([a.connection_id,b.connection_id]),'SSH2');
    await ui.waitFor("!document.querySelector('dialog:modal')");
    await verifyAdjacent(a,aCopy);
    assert.equal((await metric(first)).accepted_connections,2);
    assert.equal((await metric(second)).accepted_connections,1);
    assert.ok(!(await readOutput(aCopy)).includes('ORIGINAL_OUTPUT_REMAINS'));
    assert.deepEqual((await logs(aCopy,{op:'list'})).logs,[]);
    assert.equal((await logs(a,{op:'status',log_id:oldLog.log_id})).active,true);
    await keyGoesTo(aCopy,'COPY_A_EXACT',[a,b]);
    assert.equal(Buffer.from((await metric(second)).received.flat()).length,0);
    console.log('PASS saved background copy and fixed-revision receipt recovery with no duplicate start');

    await splitRight(b);
    const copyPane=await ui.evaluate(`${tab(b)}.closest('[data-pane]').dataset.pane`);
    const bAction=await openCopy(ui,b);
    await click(ui,bAction);
    await ui.waitFor(`document.querySelector('dialog:modal[aria-label="连接服务器"]')&&${q('[aria-label="SSH服务器"]')}.value==='localhost'`);
    assert.equal(await ui.evaluate(`${q('[aria-label="SSH端口"]')}.value`),String(second.port));
    assert.equal(await ui.evaluate(`${q('[aria-label="SSH登录密码"]')}.value`),'');
    assert.equal((await metric(second)).accepted_connections,1);
    await ui.click('连接');
    await ui.waitFor(`[...document.querySelectorAll('dialog:modal button')].some(b=>b.textContent==='提交本次登录信息')`);
    await ui.fill('SSH登录密码',second.password);
    await ui.click('提交本次登录信息');
    const bCopy=await childOf(new Set([a,b,aCopy].map(c=>c.connection_id)),'SSH2');
    await ui.waitFor("!document.querySelector('dialog:modal')");
    await verifyAdjacent(b,bCopy);
    await keyGoesTo(bCopy,'COPY_B_EXACT',[a,b,aCopy]);
    assert.equal(await ui.evaluate(`${tab(bCopy)}.closest('[data-pane]').dataset.pane`),copyPane);
    await ui.screenshot('desktop-0.1.9-copy-in-split.png');
    console.log('PASS temporary copy, manual authentication and exact split pane/input placement');
    assert.equal((await metric(second)).accepted_connections,2);
    await ui.click('收起窗格 2');
    await ui.waitFor(`document.querySelectorAll('[data-pane]').length===1&&!!${tab(bCopy)}`);
    await activate(bCopy);
    const wide=await seam(ui);verifySeam(wide);
    await ui.screenshot('desktop-0.1.9-integrated-title.png');
    fit(720,480);await ui.waitFor('innerWidth<=725');
    const narrow=await seam(ui);verifySeam(narrow);
    await ui.screenshot('desktop-0.1.9-integrated-title-narrow.png');
    const window=await verifyWindow(ui,title);
    console.log('PASS native window movement, maximize/restore and wide/narrow title seams');
    await logs(a,{op:'stop',log_id:oldLog.log_id});
    await wait(async()=> (await logs(a,{op:'status',log_id:oldLog.log_id})).durable,'original completes separately');

    const origin=await ui.evaluate(`(()=>{const b=${tab(b)}.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    dragNativeWindow(ui.app,[origin,{x:origin.x-25,y:origin.y+35},{x:45,y:120},{x:-35,y:150,outside:true}],
      {executable:desktop,title,raise:true,placeAtWorkAreaStart:true});
    const target=await wait(async()=> (await ui.otherPages())[0],'native detached WebView created');
    detached=await connectDesktopPage(target);
    await detached.waitFor(`${tab(b)}?.getAttribute('aria-selected')==='true'`);
    const detachedSeam=await seam(detached);verifySeam(detachedSeam);
    await detached.screenshot('desktop-0.1.9-integrated-title-detached.png');
    const label=await detached.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label');
    const detachedWindow=await verifyWindow(detached,childTitle,label);
    await click(detached,await openCopy(detached,b,childTitle),'Left',childTitle);
    await ui.waitFor(`document.querySelector('dialog:modal[aria-label="连接服务器"]')&&${q('[aria-label="SSH端口"]')}.value===${JSON.stringify(String(second.port))}`);
    await ui.click('收起连接窗口');
    assert.equal((await metric(second)).accepted_connections,2);
    await click(detached,q('.window-close'),'Left',childTitle);
    await wait(async()=> !(await ui.otherPages()).length,'detached close returned its original scope');
    detached.close();detached=undefined;
    await ui.waitFor(`!!${tab(b)}`);
    evidence={result:'PASS',sameAddress:true,savedCopy:true,temporaryCopy:true,isolatedInput:true,isolatedRecording:true,copyPane,
      wide,narrow,window,detachedSeam,detachedWindow,detachedCopyRouting:true};
  }
  await close();
  await writeFile(`artifacts/windows-0.1.9-session-copy-${uartMode?'uart':'ssh'}.json`,JSON.stringify(evidence,null,2)+'\n');
  console.log('PASS Windows session copy',uartMode?'memory UART exclusivity':'saved and temporary SSH, exact input, title seam and native windows');
}catch(error){
  if(ui)await ui.screenshot(`desktop-0.1.9-session-copy-${uartMode?'uart':'ssh'}-failure.png`).catch(()=>{});
  throw error;
}finally{
  detached?.close();
  await ui?.close();
  for(const process of processes){
    if(process.exitCode===null&&process.signalCode===null){
      const exited=new Promise(resolve=>process.once('exit',resolve));
      process.stdin.end();
      await exited;
    }
  }
  assert.equal(path.dirname(root),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('shared-terminal-session-copy-ui-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
