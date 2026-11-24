import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {connectDesktopPage, createSshFixtureScope, delay, desktopEvidence, dragNativeWindow, launchDesktop} from './lib/DesktopHarness.mjs';
import {checkLogToolbar,checkMainToolbar,measureCompactToolbar,measurePopup} from './lib/ToolbarMenuChecks.mjs';
import {checkConnectionPanels} from './lib/ConnectionPanelChecks.mjs';
import {checkCornerNotices} from './lib/CornerNoticeChecks.mjs';

const desktop=path.resolve(process.argv[2]);
const uartMode=process.argv.includes('--uart');
const panels=process.argv.includes('--connection-panels');
const notices=process.argv.includes('--corner-notices');
const refresh=notices||panels||process.argv.includes('--toolbar-refresh');
const tabInteractions=process.argv.includes('--tab-interactions');
const copyRaces=process.argv.includes('--copy-races');
const webviewPointer=refresh||copyRaces||process.argv.includes('--webview-pointer');
const tabVersion=path.basename(path.dirname(desktop)).match(/^SharedTerminal-(\d+\.\d+\.\d+)-windows-x64$/)?.[1]??'unpacked';
const version=tabInteractions?tabVersion:notices?'0.1.12':panels?'0.1.11':refresh?'0.1.10':'0.1.9';
const artifact=notices?'corner-notices':panels?'connection-panels':refresh?'toolbar':uartMode?'session-copy-uart':copyRaces?'session-copy-races':'session-copy-ssh';
const rootPrefix=notices?'shared-terminal-log-viewer-ui-中文-':'shared-terminal-session-copy-ui-中文-';
const {root,start:source,close:closeFixtures}=await createSshFixtureScope(rootPrefix);
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
async function webviewClick(page,expression){
  const point=await page.evaluate(`(()=>{
    const target=(${expression}),b=target.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;
    return {x,y,visible:target.contains(document.elementFromPoint(x,y))};
  })()`);
  const {x,y,visible}=point;
  assert.equal(visible,true,'toolbar control is visible at its click point');
  await page.command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await page.command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
}
async function pointerGesture(from,to,count=1){
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:count});
  if(from!==to)await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:count});
}
const point=(expression,x=.5,y=.5)=>ui.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}};})()`);
async function checkMixedTabs(remote,anchor){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('轻量命令行');
  const local=q('[role="tab"][title="轻量命令行"]');
  await ui.waitFor(`${local}?.ariaSelected==='true'`);
  const terminal=q('.local-terminal:not([hidden]) .xterm');
  await ui.evaluate(`window.mixedLocal=${terminal}`);
  await pointerGesture(await point(local),await point(tab(anchor),.1));
  await ui.waitFor(`${local}?.parentElement.nextElementSibling?.contains(${tab(anchor)})`);
  await pointerGesture(await point(tab(remote)),await point(q('.local-pane-body:not([hidden])'),.87));
  await ui.waitFor(`document.querySelectorAll('[data-pane]').length===2&&${tab(remote)}?.closest('[data-pane]')!==${local}?.closest('[data-pane]')`);
  await pointerGesture(await point(local),await point(tab(remote),.1));
  await ui.waitFor(`${local}?.parentElement.nextElementSibling?.contains(${tab(remote)})&&${local}.ariaSelected==='true'`);
  assert.equal(await ui.evaluate(`${terminal}===window.mixedLocal`),true);
  await ui.click('关闭 本地 1');
  await ui.waitFor(`!${local}`);
  await ui.evaluate(`${tab(remote)}.closest('[data-pane]').querySelector('.pane-collapse').click()`);
  await ui.waitFor("document.querySelectorAll('[data-pane]').length===1");
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
  if(webviewPointer){
    const [start,intermediate,end]=points;
    await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
    for(const {x,y} of [intermediate,end])await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'left',buttons:1});
    await ui.waitFor('!!document.querySelector(".tab-split-preview[data-edge=right]")');
    await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:end.x,y:end.y,button:'left',buttons:0,clickCount:1});
  }else dragNativeWindow(ui.app,points,{executable:desktop,title,raise:true});
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
    const bar=document.querySelector('.window-chrome'),pane=document.querySelector('[data-pane][data-active="true"]');
    const active=pane.querySelector('.connection-tab:has([aria-selected="true"])'),terminal=pane.querySelector('.terminal');
    const rules=getComputedStyle(active),inactive=pane.querySelector('.connection-tab:has([aria-selected="false"])');
    return {gap:terminal.getBoundingClientRect().top-active.getBoundingClientRect().bottom,
      left:active.getBoundingClientRect().left,terminalLeft:terminal.getBoundingClientRect().left,
      active:getComputedStyle(active).backgroundColor,terminal:getComputedStyle(terminal).backgroundColor,
      inactive:inactive?getComputedStyle(inactive).backgroundColor:null,
      toolbar:getComputedStyle(bar).backgroundColor,topRadius:rules.borderTopLeftRadius,bottomRadius:rules.borderBottomLeftRadius,
      overshoot:bar.scrollWidth-bar.clientWidth,width:innerWidth};
  })()`);
}
async function toolbar(page,{detachedWindow=false}={}){
  const result=await page.evaluate(`(()=>{
    const header=document.querySelector('.window-chrome'),nav=header.querySelector('.app-bar');
    const limits=nav.getBoundingClientRect();
    const selectors=['.sidebar-toggle','.toolbar-log','.toolbar-log-directory','.tools-menu'];
    const controls=[...nav.children].map(node=>{
      const r=node.getBoundingClientRect(), style=getComputedStyle(node);
      return {kind:selectors.find(selector=>node.matches(selector))??node.textContent.trim(),
        fits:r.width>0&&r.height>0&&r.left>=limits.left&&r.right<=limits.right&&style.visibility==='visible'};
    });
    return {controls,grouped:getComputedStyle(header).backgroundColor!==getComputedStyle(nav).backgroundColor,
      toolbarBottom:limits.bottom,tabTops:[...document.querySelectorAll('.terminal-pane .pane-tab-bar')].map(rail=>rail.getBoundingClientRect().top),
      tabsInHeader:!!header.querySelector('.pane-tab-bar')};
  })()`);
  const expected=detachedWindow?['.toolbar-log','.toolbar-log-directory','移回主窗口']:['.sidebar-toggle','.toolbar-log','.toolbar-log-directory','.tools-menu'];
  assert.deepEqual(result.controls,expected.map(kind=>({kind,fits:true})));
  assert.equal(result.grouped,true);
  assert.equal(result.tabsInHeader,false);
  assert.ok(result.tabTops.length>0&&result.tabTops.every(top=>top>=result.toolbarBottom),JSON.stringify(result));
  return result;
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
async function detachOwnedSession(connection){
  const pointer=spawn('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1',
    '-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',desktop,'-Title',title,
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
    await ui.invoke('detach_session',{serviceId:service.service_id,connection:ref(connection)});
  }finally{
    lines.close();
    const code=await closed;
    assert.equal(code,0,error);
  }
}
async function verifyWindow(page,caption,label='main'){
  const chrome=q('.window-title');
  const start=await page.evaluate(`(()=>{const b=${chrome}.getBoundingClientRect();return{x:b.left+Math.min(116,b.width/2),y:b.top+b.height/2};})()`);
  const points=[start,{x:start.x+32,y:start.y+24},{x:start.x+62,y:start.y+40}];
  const movement=JSON.parse(native('scripts/lib/Drag-TestWindow.ps1',['-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',desktop,
    '-Title',caption,'-Points',JSON.stringify(points),'-Raise','-PlaceAtWorkAreaStart','-MeasureMovement']));
  assert.ok(Math.abs(movement.dx)>20||Math.abs(movement.dy)>20,JSON.stringify(movement));
  const control=expression=>refresh?webviewClick(page,expression):click(page,expression,'Left',caption);
  await control(q('button[aria-label="最大化窗口"]'));
  await wait(()=>windowQuery(page,'is_maximized',label),'native maximize button maximized');
  await page.waitFor(`!!${q('button[aria-label="还原窗口"]')}`);
  await control(q('button[aria-label="还原窗口"]'));
  await wait(async()=>!(await windowQuery(page,'is_maximized',label)),'native window restored');
  return {moved:true,maximized:true,restored:true,...movement};
}
async function close(){
  if(notices){
    await wait(async()=>(await sessions()).every(c=>['DISCONNECTED','FAILED'].includes(c.state)),'owned connections ended before idle shutdown');
    assert.equal(await ui.evaluate(`(()=>{
      const menu=document.querySelector('details.tools-menu');
      if(!menu.open)menu.querySelector('summary').click();
      const exit=[...menu.querySelectorAll('button')].find(button=>button.textContent==='退出桌面');
      if(!exit||exit.disabled)return false;
      setTimeout(()=>exit.click(),50);
      return true;
    })()`),true);
  }else{
    if(webviewPointer)await webviewClick(ui,q('.window-close'));
    else await click(ui,q('.window-close'));
    await ui.waitFor(`!!document.querySelector('dialog[aria-label="退出桌面确认"]')`);
    await ui.click('确认退出并停止服务');
  }
  await wait(()=>ui.app.exitCode===0,'owned desktop exited');
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',service.service_id+'.json'),'utf8'));
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');
  assert.equal(receipt.exited,true);
  await ui.close();
  ui=undefined;
}

async function setTheme(theme){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('软件设置');
  await ui.waitFor(`document.querySelector('[aria-label="应用主题"]')?.disabled===false`);
  await ui.fill('应用主题',theme);
  // Seed the detached window's theme in the isolated preferences. The open
  // main window already previews the same theme through the settings control.
  const before=await ui.invoke('config_request',{request:{op:'preferences'}});
  if(before.preferences.theme!==theme){
    const saved=await ui.invoke('config_request',{request:{op:'save_preferences',revision:before.revision,
      preferences:{...before.preferences,theme}}});
    assert.equal(saved.preferences.theme,theme);
  }
  await ui.click('关闭软件设置');
  await ui.waitFor(`document.documentElement.dataset.theme===${JSON.stringify(theme)}&&!document.querySelector('dialog:modal')`);
}

async function exerciseDirectory(page){
  await page.evaluate(`(()=>{
    const original=window.fetch;
    window.toolbarDirectory={original,result:[]};
    window.fetch=async function(input,options){
      const response=await original.call(this,input,options);
      if(new URL(String(input)).pathname==='/open_managed_log_directory')window.toolbarDirectory.result.push(response.headers.get('Tauri-Response'));
      return response;
    };
   })()`);
  try{
    await webviewClick(page,q('.toolbar-log-directory'));
    await page.waitFor("window.toolbarDirectory.result.length===1");
    assert.deepEqual(await page.evaluate('window.toolbarDirectory.result'),['ok']);
  }finally{
    await page.evaluate('window.fetch=window.toolbarDirectory.original; delete window.toolbarDirectory;');
  }
  await page.command('Page.bringToFront');
}

async function checkMoreTools(){
  await webviewClick(ui,q('.tools-menu > summary'));
  const anchored=await measurePopup(ui,'.tools-menu > summary','.tools-menu-content','compact more tools');
  const expanded=await ui.evaluate(`getComputedStyle(document.querySelector('.tools-menu > summary')).backgroundColor`);
  assert.notEqual(expanded,'rgba(0, 0, 0, 0)');
  const image=await ui.command('Page.captureScreenshot',{format:'png'});
  await writeFile(`artifacts/desktop-${version}-toolbar-more-tools.png`,Buffer.from(image.data,'base64'));
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await ui.waitFor("!document.querySelector('.tools-menu').open");
  return anchored;
}

async function toolbarRefresh(){
  const menus=await checkMainToolbar(ui,width=>fit(width,width===720?480:760),version);
  const first=await source('toolbar-first'),second=await source('toolbar-second');
  const a=await connect(first,false),b=await connect(second,false);
  await activate(b);
  await ui.waitFor(`${tab(a)}?.getAttribute('aria-label')==='localhost'&&${tab(b)}?.getAttribute('aria-label')==='localhost'`);
  await exerciseDirectory(ui);
  assert.equal((await stat(path.join(root,'logs'))).isDirectory(),true);
  const aRecord=`${tab(a)}.parentElement.querySelector('.tab-record-button')`;
  const bRecord=`${tab(b)}.parentElement.querySelector('.tab-record-button')`;
  await ui.waitFor(`${aRecord}?.getAttribute('aria-disabled')==='false'`);
  await webviewClick(ui,aRecord);
  await ui.waitFor(`${aRecord}.dataset.recording==='recording'&&${bRecord}.dataset.recording==='idle'
    &&${tab(b)}.getAttribute('aria-selected')==='true'&&${q('.toolbar-log')}.dataset.logPhase!=='RECORDING'`);
  await activate(a);
  await ui.waitFor(`${q('.toolbar-log')}.dataset.logPhase==='RECORDING'&&${q('.toolbar-log')}.getAttribute('aria-description').includes('正在记录')`);
  menus.push(await checkLogToolbar(ui,'active recording log','停止记录'));
  const geometry={};
  for(const theme of ['light','dark']){
    await setTheme(theme);
    for(const [name,width,height] of [['wide',1100,760],['narrow',720,480]]){
      fit(width,height);
      await ui.waitFor(width===720?'innerWidth<=725':'innerWidth>=1080');
      const k=theme+'-'+name;
      geometry[k]=await measureCompactToolbar(ui);
      verifySeam(await seam(ui));
      await ui.evaluate(`${pane}.querySelector('.xterm-helper-textarea').focus()`);
      await ui.screenshot(`desktop-${version}-toolbar-${k}.png`);
    }
  }
  assert.notEqual(geometry['light-wide'].background,geometry['dark-wide'].background);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...await ui.evaluate(`(()=>{const b=${q('.toolbar-log')}.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`)});
  await ui.waitFor(`getComputedStyle(${q('.toolbar-log')}).backgroundColor!=='rgba(0, 0, 0, 0)'`);
  menus.push(await checkMoreTools());
  fit(1100,760);
  await ui.waitFor('innerWidth>=1080');
  await splitRight(b);
  geometry.split=await measureCompactToolbar(ui);
  assert.equal(geometry.split.tabTops.length,2);
  await ui.screenshot(`desktop-${version}-toolbar-split.png`);
  await webviewClick(ui,q('.sidebar-toggle'));
  await ui.waitFor("document.querySelector('.desktop-body').classList.contains('sidebar-hidden')");
  await detachOwnedSession(a);
  detached=await connectDesktopPage(await wait(async()=> (await ui.otherPages())[0],'native detached toolbar window'));
  await detached.waitFor(`${tab(a)}?.getAttribute('aria-selected')==='true'&&document.documentElement.dataset.theme==='dark'`);
  geometry.detached=await measureCompactToolbar(detached,true);
  verifySeam(await seam(detached));
  await detached.screenshot(`desktop-${version}-toolbar-detached.png`);
  menus.push(await checkLogToolbar(detached,'detached log','停止记录'));
  await exerciseDirectory(detached);
  const label=await detached.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label');
  const detachedWindow=await verifyWindow(detached,childTitle,label);
  await webviewClick(detached,q('.app-bar button:last-child'));
  await wait(async()=> !(await ui.otherPages()).length,'dedicated move-back control returned the original window');
  detached.close();detached=undefined;
  await ui.waitFor(`!!${tab(a)}`);
  await webviewClick(ui,q('.sidebar-toggle'));
  await ui.waitFor("!document.querySelector('.desktop-body').classList.contains('sidebar-hidden')");
  await activate(a);
  await ui.waitFor(`${aRecord}.dataset.recording==='recording'&&${aRecord}.getAttribute('aria-disabled')==='false'`);
  await webviewClick(ui,aRecord);
  await wait(async()=> (await logs(a,{op:'list'})).logs[0]?.durable,'original recording stopped independently');
  assert.deepEqual((await logs(b,{op:'list'})).logs,[]);
  const window=await verifyWindow(ui,title);
  return {result:'PASS',geometry,menus,window,detachedWindow,recordingScoped:true,nativeDirectoryBothWindows:true};
}

try{
  ui=await launchDesktop(root,{executable:desktop,fixture:uartMode});
  service=await ui.invoke('service_status');
  assert.equal(service.fixture,uartMode);
  if(notices){
    evidence=await checkCornerNotices({ui,version,root,source,connect,activate,wait,fit,setTheme,webviewClick});
  }else if(panels){
    evidence=await checkConnectionPanels({ui,version,root,source,connect,wait,fit,setTheme,splitRight,keyGoesTo,webviewClick});
  }else if(refresh){
    evidence=await toolbarRefresh();
  }else if(uartMode){
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
    await ui.waitFor("!document.querySelector('dialog:modal')");
    const where=await point(tab(connection));
    await pointerGesture(where,where);
    await pointerGesture(where,where,2);
    await ui.waitFor(`document.querySelector('dialog:modal[aria-label="连接串口设备"]')?.textContent.includes('没有其他可选端口')`);
    assert.equal(await ui.evaluate(`${q('button.primary-action')}.disabled`),true);
    await ui.click('取消连接窗口');
    assert.deepEqual((await sessions()).map(item=>({id:item.connection_id,state:item.state})),[{id:connection.connection_id,state:'CONNECTED'}]);
    evidence={result:'PASS',memoryUart:true,memoryUartDoubleClick:true,excludedOriginalPort:true,settingsRetained:true,serviceRejectedSamePort:true};
  }else if(copyRaces){
    const first=await source('focus-peer'),second=await source('copy-peer');
    const a=await connect(first,false),b=await connect(second,false);
    await activate(a);
    await splitRight(b);
    await ui.waitFor(`${tab(b)}?.getAttribute('aria-label')==='localhost'`);
    const held=await ui.interceptIpc({command:'ssh_request',op:'status',connectionId:b.connection_id,mode:'hold'});
    try{
      const where=await point(tab(b));
      const doubleClick=async()=>{
        await pointerGesture(where,where);
        await pointerGesture(where,where,2);
      };
      await doubleClick();
      await wait(async()=>await held.count()===1,'observed copy status read');
      await doubleClick();
      await activate(a);
      await ssh({op:'close',connection:ref(b)});
      await ui.waitFor(`${tab(b)}?.title.includes('DISCONNECTED')`);
      assert.equal(await held.count(),1,'rapid double-clicks started one copy read');
    }finally{await held.restore();}
    await ui.waitFor(`${q('[aria-label="标签操作状态"]')}?.textContent.includes('原会话或窗格已变化')`);
    assert.equal(await ui.evaluate("!!document.querySelector('dialog:modal')"),false);
    assert.equal(await ui.evaluate(`${pane}?.dataset.renderedId`),a.connection_id);
    assert.equal((await metric(second)).accepted_connections,1);
    evidence={result:'PASS',copyReadCount:1,closedSourceHasNoDialog:true,focusPreserved:true,secondEndpointConnections:1};
  }else if(tabInteractions){
    const first=await source('mixed-peer'),second=await source('copy-peer');
    const a=await connect(first,false),b=await connect(second,false);
    await activate(a);
    await splitRight(b);
    const copyPane=await ui.evaluate(`${tab(b)}.closest('[data-pane]').dataset.pane`);
    const where=await point(tab(b));
    await pointerGesture(where,where);
    await pointerGesture(where,where,2);
    await ui.waitFor(`document.querySelector('dialog:modal[aria-label="连接服务器"]')&&${q('[aria-label="SSH服务器"]')}.value==='localhost'`);
    assert.equal(await ui.evaluate(`${q('[aria-label="SSH端口"]')}.value`),String(second.port));
    assert.equal(await ui.evaluate(`${q('[aria-label="SSH登录密码"]')}.value`),'');
    assert.equal((await metric(second)).accepted_connections,1);
    await ui.click('连接');
    await ui.waitFor(`[...document.querySelectorAll('dialog:modal button')].some(button=>button.textContent==='提交本次登录信息')`);
    await ui.fill('SSH登录密码',second.password);
    await ui.click('提交本次登录信息');
    const bCopy=await childOf(new Set([a,b].map(c=>c.connection_id)),'SSH2');
    await ui.waitFor("!document.querySelector('dialog:modal')");
    await verifyAdjacent(b,bCopy);
    await keyGoesTo(bCopy,'DOUBLE_CLICK_COPY_EXACT',[a,b]);
    assert.equal(await ui.evaluate(`${tab(bCopy)}.closest('[data-pane]').dataset.pane`),copyPane);
    assert.equal((await metric(second)).accepted_connections,2);
    await ui.evaluate(`${tab(b)}.closest('[data-pane]').querySelector('.pane-collapse').click()`);
    await ui.waitFor("document.querySelectorAll('[data-pane]').length===1");
    await checkMixedTabs(a,bCopy);
    evidence={result:'PASS',
      mixedTabInteraction:true,sshDoubleClick:true,temporaryAuthentication:true,isolatedInput:true,copyPane};
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
    await click(ui,aAction);
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
    console.log('PASS saved background copy with ordinary saved credential and host trust');

    await splitRight(b);
    const copyPane=await ui.evaluate(`${tab(b)}.closest('[data-pane]').dataset.pane`);
    const splitToolbar=await toolbar(ui);
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
    await ui.evaluate("document.querySelector('[aria-label=\"终端窗格 2\"] .pane-collapse, [aria-label=\"收起窗格 2\"]').click()");
    await ui.waitFor(`document.querySelectorAll('[data-pane]').length===1&&!!${tab(bCopy)}`);
    await activate(bCopy);
    const wide=await seam(ui);verifySeam(wide);
    const wideToolbar=await toolbar(ui);
    await ui.screenshot('desktop-0.1.9-integrated-title.png');
    fit(720,480);await ui.waitFor('innerWidth<=725');
    const narrow=await seam(ui);verifySeam(narrow);
    const narrowToolbar=await toolbar(ui);
    await ui.screenshot('desktop-0.1.9-integrated-title-narrow.png');
    const window=await verifyWindow(ui,title);
    console.log('PASS native window movement, maximize/restore and wide/narrow title seams');
    await logs(a,{op:'stop',log_id:oldLog.log_id});
    await wait(async()=> (await logs(a,{op:'status',log_id:oldLog.log_id})).durable,'original completes separately');

    fit(1100,760);
    await ui.waitFor('innerWidth>=1080');
    await activate(a);
    await ui.waitFor(`(()=>{const r=${tab(a)}.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`);
    const origin=await ui.evaluate(`(()=>{const b=${tab(a)}.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    dragNativeWindow(ui.app,[origin,{x:origin.x-25,y:origin.y+35},{x:45,y:120},{x:-35,y:150,outside:true}],
      {executable:desktop,title,raise:true,placeAtWorkAreaStart:true});
    const target=await wait(async()=> (await ui.otherPages())[0],'native detached WebView created');
    detached=await connectDesktopPage(target);
    await detached.waitFor(`${tab(a)}?.getAttribute('aria-selected')==='true'`);
    const detachedSeam=await seam(detached);verifySeam(detachedSeam);
    const detachedToolbar=await toolbar(detached,{detachedWindow:true});
    await detached.screenshot('desktop-0.1.9-integrated-title-detached.png');
    const label=await detached.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label');
    const detachedWindow=await verifyWindow(detached,childTitle,label);
    const fixedReply=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'error'});
    try{
      await click(detached,await openCopy(detached,a,childTitle),'Left',childTitle);
      await ui.waitFor("[...document.querySelectorAll('dialog:modal button')].some(button=>button.textContent==='查询本次连接')");
      assert.equal(await fixedReply.count(),1,'one attempt with a lost Desktop start-fixed answer');
    }finally{await fixedReply.restore();}
    await wait(async()=> (await metric(first)).accepted_connections===3,'fixed start reached the original saved endpoint');
    await ui.click('查询本次连接');
    await ui.waitFor("[...document.querySelectorAll('dialog:modal button')].some(button=>button.textContent==='使用已记住的凭据')");
    await ui.click('使用已记住的凭据');
    const routedCopy=await childOf(new Set([a,b,aCopy,bCopy].map(c=>c.connection_id)),'SSH2');
    await ui.waitFor("!document.querySelector('dialog:modal')");
    assert.equal((await metric(first)).accepted_connections,3);
    assert.deepEqual((await detached.invoke('service_list')).map(ref),[ref(a)]);
    await keyGoesTo(routedCopy,'DETACHED_COPY_EXACT',[b,aCopy,bCopy]);
    await click(detached,q('.window-close'),'Left',childTitle);
    await wait(async()=> !(await ui.otherPages()).length,'detached close returned its original scope');
    detached.close();detached=undefined;
    await ui.waitFor(`!!${tab(a)}`);
    evidence={result:'PASS',sameAddress:true,savedCopy:true,temporaryCopy:true,isolatedInput:true,isolatedRecording:true,copyPane,
      wide,narrow,window,splitToolbar,wideToolbar,narrowToolbar,detachedSeam,detachedWindow,detachedToolbar,
      detachedCopyRouting:true,lostReplyRecoveredWithoutReplay:true};
  }
  await close();
  await writeFile(`artifacts/windows-${version}-${artifact}.json`,JSON.stringify({...evidence,...await desktopEvidence(desktop)},null,2)+'\n');
  console.log(copyRaces?'PASS delayed copy status, duplicate gesture and closed source focus':tabInteractions?'PASS mixed local and SSH tabs, SSH double-click and exact copy input':notices?'PASS Windows corner notices, immediate dismissal and exact native actions':panels?'PASS Windows connection panels, exact lifecycle receipts, pane controls and unchanged toolbar':refresh?'PASS compact Windows toolbar, both themes and sizes, split, native detached and exact recording':`PASS Windows session copy ${uartMode?'memory UART exclusivity':'saved and temporary SSH, exact input, title seam and native windows'}`);
}catch(error){
  if(ui)await ui.screenshot(`desktop-${version}-${artifact}-failure.png`).catch(()=>{});
  throw error;
}finally{
  try{
    detached?.close();
    await ui?.close();
  }finally{await closeFixtures();}
}
