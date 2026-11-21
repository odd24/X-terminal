import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {connectDesktopPage, delay, dragNativeWindow, launchDesktop} from './lib/DesktopHarness.mjs';
import {closeSoakDesktop} from './lib/LoadSoak.mjs';
import {checkMainToolbar,checkNewConnectionMenu,checkLogToolbar} from './lib/ToolbarMenuChecks.mjs';
import {checkNoticeActions,checkToolbarDirectory,observeLogDirectory,waitForStopNotice} from './lib/RecordingNoticeChecks.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-terminal-pane-groups-ui-中文-'));
const desktop = path.resolve(process.argv[2]);
const toolbarChecks=process.argv.includes('--toolbar');
const dockProbe=process.argv.includes('--dock-toolbar');
const notices=process.argv.includes('--recording-notices');
const version=process.argv.find(arg=>/^--ui-version=0\.1\.[5-8]$/.test(arg))?.split('=')[1]??'0.1.5';
const tabRecording=notices||process.argv.includes('--tab-recording');
const evidence=notices?version:toolbarChecks||dockProbe||tabRecording?'0.1.4':'0.1.2';
const toolbar=[];
const processes = [];
let main, child;
const wait = async (check, label) => {
  for (let attempt=0; attempt<120; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
};
const ref = ({connection_id, generation}) => ({connection_id, generation});
const query = css => `document.querySelector(${JSON.stringify(css)})`;
const geometry = expression => main.evaluate(`${expression}.getBoundingClientRect().toJSON()`);
const escape = page => page.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
const tool = async label => {
  await main.evaluate(`document.querySelector('.tools-menu').open=true`);
  await main.click(label);
};
const fit = async width => {
  const measurement=JSON.parse(execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId',String(main.app.pid),'-ExpectedExecutable',desktop,'-Width',String(width),'-Height',width===720?'480':'760'],
    {encoding:'utf8',windowsHide:true}));
  await main.waitFor(`Math.abs(innerWidth-${measurement.clientWidth*96/measurement.dpi})<=1`);
};
const center = rect => ({x:rect.left+rect.width/2,y:rect.top+rect.height/2});
async function synthetic(name) {
  const directory=path.join(root,name);
  await mkdir(directory);
  const proc=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  processes.push(proc);
  const lines=createInterface({input:proc.stdout})[Symbol.asyncIterator]();
  async function next() {
    let timer;
    try { return await Promise.race([lines.next().then(line=>JSON.parse(line.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSH fixture timed out')),8000);})]); }
    finally { clearTimeout(timer); }
  }
  return {...await next(), control:async message=>{proc.stdin.write(JSON.stringify(message)+'\n');return next();}};
}
async function connect(peer,host) {
  const request = value => main.invoke('ssh_request',{request:value});
  const c = (await request({op:'quick_start',settings:{protocol:'ssh2',host,port:peer.port,username:'synthetic',auth:'password',encoding:'utf8'},
    request_id:requestId(),rows:24,cols:80})).connection;
  const answered = new Set();
  await wait(async()=>{
    const current = await request({op:'status',connection:ref(c)});
    assert.notEqual(current.connection.state,'FAILED');
    const challenge=current.challenge;
    if (challenge && !answered.has(challenge.id)) {
      answered.add(challenge.id);
      if (challenge.kind==='host_key') {
        assert.equal(challenge.review.candidate.fingerprint,peer.pin);
        await request({op:'answer_host',connection:ref(c),challenge_id:challenge.id,approve:true});
      } else {
        await request({op:'authenticate',connection:ref(c),challenge_id:challenge.id,use_saved:false,password:peer.password});
      }
    }
    return current.connection.state==='CONNECTED';
  },'SSH connected');
  return c;
}
const rendered=(c,position)=>`document.querySelectorAll('[data-pane]')[${position}]?.dataset.renderedId===${JSON.stringify(c.connection_id)}`;
const terminalText=text=>`document.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(text)})`;
const terminalFocus=page=>page.evaluate(`document.querySelector('[data-active="true"] .xterm-helper-textarea').focus()`);
const write=async(page,peer,value)=>{
  await page.command('Page.bringToFront');
  await terminalFocus(page);
  await page.command('Input.insertText',{text:value});
  await wait(async()=>Buffer.from((await peer.control({op:'metrics'})).received.flat()).includes(Buffer.from(value)),value);
};
async function outsideDrag(c, fromPane=false) {
  const source=fromPane?`[data-rendered-id="${c.connection_id}"] .pane-focus`:`[role="tab"][data-connection-id="${c.connection_id}"]`;
  const start=center(await geometry(query(source)));
  await main.command('Page.bringToFront');
  dragNativeWindow(main.app,[start,{x:start.x-20,y:start.y+35},{x:50,y:120},{x:-40,y:150,outside:true}],
    {executable:desktop,raise:true,placeAtWorkAreaStart:tabRecording});
  const target=await wait(async()=>(await main.otherPages())[0],'native detached WebView');
  return connectDesktopPage(target);
}
async function dockDrag(connection) {
  const mainBounds=await main.evaluate('({width:innerWidth,height:innerHeight})');
  const landings=[{x:mainBounds.width-65,y:100},{x:40,y:100},{x:mainBounds.width/2,y:45},
    {x:mainBounds.width/2,y:mainBounds.height-45},{x:mainBounds.width-35,y:mainBounds.height-35}];
  const source=await child.evaluate(`document.querySelector('[role="tab"][data-connection-id="${connection.connection_id}"]').getBoundingClientRect().toJSON()`);
  const start=center(source);
  await child.command('Page.bringToFront');
  await terminalFocus(child);
  await child.waitFor('document.hasFocus()&&document.activeElement?.classList.contains("xterm-helper-textarea")');
  await child.evaluate(`(()=>{
    window.dockInputTrace=[];
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']){
      document.addEventListener(type,event=>{
        if(window.dockInputTrace.length<48)window.dockInputTrace.push([type,event.clientX,event.clientY,
          event.target.closest?.('[role=tab]')?.dataset.connectionId??null,innerWidth,innerHeight]);
      },true);
    }
  })()`);
  const points=[start,{x:start.x+32,y:start.y+40},{landings,outside:true,holdMs:1300}];
  const mouse=spawn('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1','-TargetProcessId',String(main.app.pid),
    '-ExpectedExecutable',desktop,'-Title','共享终端 · 独立会话','-LandingTitle','共享终端','-Points',JSON.stringify(points),'-Raise',
    ...(tabRecording?['-PlaceAtWorkAreaStart']:[])],{windowsHide:true});
  let errors='';
  mouse.stderr.on('data',chunk=>errors+=chunk);
  const done=new Promise(resolve=>mouse.once('exit',resolve));
  const preview=main.waitFor(`!!document.querySelector('.tab-dock-preview')`)
    .then(()=>main.screenshot(`desktop-${evidence}-dock-preview.png`)).catch(()=>{});
  assert.equal(await done,0,errors);
  try{await wait(async()=>!(await main.otherPages()).length,'physical drop returns the native session to main');}
  catch(error){console.error(await child.evaluate('JSON.stringify(window.dockInputTrace)').catch(()=>''));throw error;}
  await preview;
}

const tab = c => query('[role="tab"][data-connection-id="'+c.connection_id+'"]');
const pane = c => query('[data-rendered-id="'+c.connection_id+'"]');
const host = c => pane(c)+'.querySelector(".terminal")';
const tabIds = c => main.evaluate('[...'+pane(c)+'.querySelectorAll("[role=tab]")].map(tab=>tab.dataset.connectionId)');
async function physical(source,destination,preview,screenshot){
  const from=center(await geometry(source));
  await main.command('Page.bringToFront');
  const points=[from,{x:from.x+12,y:from.y+14},{...destination,holdMs:700}];
  const mouse=spawn('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1','-TargetProcessId',String(main.app.pid),
    '-ExpectedExecutable',desktop,'-Points',JSON.stringify(points),'-Raise'],{windowsHide:true});
  let stderr='';
  mouse.stderr.on('data',chunk=>stderr+=chunk);
  const done=new Promise((resolve,reject)=>{mouse.once('error',reject);mouse.once('exit',resolve);});
  try{
    await main.waitFor('!!'+query(preview));
    if(screenshot)await main.screenshot(screenshot);
  }finally{assert.equal(await done,0,stderr);}
}
const point=(rect,x,y)=>({x:rect.left+x*rect.width,y:rect.top+y*rect.height});
const choose=async c=>{
  await main.evaluate(tab(c)+'.click()');
  await main.waitFor('document.querySelector(".pane-active")?.dataset.renderedId==='+JSON.stringify(c.connection_id));
};
const recordButton=c=>`(${tab(c)}?.parentElement.querySelector('.tab-record-button'))`;
const recordState=(page,c,status)=>page.waitFor(`${recordButton(c)}?.dataset.recording===${JSON.stringify(status)}`);
const recordClick=async(page,c,keyboard=false)=>{
  const button=recordButton(c);
  await page.waitFor(`${button}?.getAttribute('aria-disabled')==='false'`);
  if(keyboard){
    await page.evaluate(`${button}.focus()`);
    for(const type of ['keyDown','keyUp'])await page.command('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
  }else{
    const point=center(await page.evaluate(`${button}.getBoundingClientRect().toJSON()`));
    assert.ok(await page.evaluate(`${button}.contains(document.elementFromPoint(${point.x},${point.y}))`),'recording control visible');
    await page.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
    await page.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
  }
};
let report;
try{
  const left=await synthetic('left'),right=await synthetic('right'),lower=await synthetic('lower'),added=await synthetic('added');
  main=await launchDesktop(root,{executable:desktop,windowsHide:false});
  const service=await main.invoke('service_status');
  assert.equal(service.fixture,false);
  if(toolbarChecks)toolbar.push(...await checkMainToolbar(main,fit,evidence));
  if(notices)await checkToolbarDirectory(main,root);
  const a=await connect(left,'127.0.0.1'),b=await connect(right,'localhost'),c=await connect(lower,'127.0.0.1');
  await main.waitFor('document.querySelectorAll("[role=tab]").length===3');
  await choose(a);
  if(tabRecording){
    let noticeChecks;
    const logs=(page,c)=>page.invoke('logging_request',{request:{op:'list',connection:ref(c)}}).then(value=>value.logs);
    const original=(page,c,id)=>page.invoke('logging_request',{request:{op:'start_status',connection:ref(c),request_id:id}});
    await fit(1100);
    if(notices){
      await observeLogDirectory(main,root,async()=>{
        await main.evaluate(`document.querySelector('.toolbar-log').click()`);
        const folder=`[...document.querySelectorAll('.terminal-context-menu button')].find(b=>b.textContent==='打开日志目录'&&!b.disabled)`;
        await main.waitFor(`!!(${folder})`);
        await main.evaluate(`(${folder}).click()`);
      });
      await main.waitFor(`!document.querySelector('.terminal-context-menu')`);
      assert.equal(await main.evaluate(`!!document.querySelector('.recording-notice')`),false);
    }
    await recordState(main,a,'idle');await recordState(main,b,'idle');
    const controlBounds=await main.evaluate(`(()=>{
      const label=${tab(b)}.querySelector('.tab-label'),button=${recordButton(b)};
      return {label:label.textContent,labelRight:label.getBoundingClientRect().right,recordLeft:button.getBoundingClientRect().left,
        fitted:label.scrollWidth<=label.clientWidth,tabIndex:button.tabIndex,action:button.getAttribute('aria-label')};
    })()`);
    assert.equal(controlBounds.label,'localhost');
    assert.ok(controlBounds.fitted&&controlBounds.labelRight<=controlBounds.recordLeft&&controlBounds.tabIndex===0);
    assert.match(controlBounds.action,/开始记录$/);
    await terminalFocus(main);
    const lostStart=await main.interceptIpc({op:'start',connectionId:b.connection_id,mode:'hold_error'});
    await recordClick(main,b);
    await recordState(main,b,'pending');
    await wait(async()=>await lostStart.count()===1,'original start accepted once');
    await main.evaluate(`${recordButton(b)}.click();${recordButton(b)}.click()`);
    assert.equal(await lostStart.count(),1);
    assert.equal(await main.evaluate('document.activeElement.classList.contains("xterm-helper-textarea")'),true);
    assert.equal(await main.evaluate('document.querySelector(".pane-active").dataset.renderedId'),a.connection_id);
    assert.deepEqual(await logs(main,a),[]);
    const saved=await main.evaluate(`JSON.parse(sessionStorage.getItem('terminal-tab-recording-v1'))[0][1]`);
    await lostStart.restore();await recordState(main,b,'unknown');
    await main.command('Page.reload');await recordState(main,b,'unknown');
    await choose(a);
    const verifyStart=await main.interceptIpc({op:'start',connectionId:b.connection_id});
    await recordClick(main,b,true);await recordState(main,b,'recording');
    assert.equal(await verifyStart.count(),0);await verifyStart.restore();
    const log=await original(main,b,saved.id);
    assert.equal(log.log_id,(await logs(main,b))[0].log_id);
    assert.equal(await main.evaluate('document.querySelector(".pane-active").dataset.renderedId'),a.connection_id);
    await right.control({op:'push',text:'\r\nTAB_RECORD_SSH_FILE\r\n'});
    await wait(async()=>{const [latest]=await logs(main,b);return latest?.readable?.flushed_bytes>0&&
      (await readFile(path.join(root,'logs',latest.readable.filename),'utf8')).includes('TAB_RECORD_SSH_FILE');},'flushed SSH text');
    await recordState(main,c,'idle');
    await main.screenshot(`desktop-${evidence}-tab-recording.png`);

    await main.splitTab(b.connection_id);
    await main.waitFor(rendered(a,0)+' && '+rendered(b,1));
    await recordState(main,b,'recording');
    await terminalFocus(main);
    const lostStop=notices?await main.interceptIpc({op:'stop',connectionId:b.connection_id,mode:'hold_error'}):undefined;
    await recordClick(main,b);
    if(lostStop){
      await wait(async()=>await lostStop.count()===1,'original stop was accepted once');
      await wait(async()=>(await logs(main,b))[0].durable,'service stop synchronized while renderer reply held');
      assert.equal(await main.evaluate(`!!document.querySelector('.recording-notice')`),false);
      await lostStop.restore();
      await recordState(main,b,'unknown');
      assert.equal(await main.evaluate(`!!document.querySelector('.recording-notice')`),false);
      await recordClick(main,b);
    }
    await recordState(main,b,'idle');
    assert.equal(await main.evaluate('document.querySelector(".pane-active").dataset.renderedId'),a.connection_id);
    const [stopped]=await logs(main,b);
    assert.equal(stopped.log_id,log.log_id);
    assert.equal(stopped.worker_finished&&stopped.durable,true);
    assert.equal(stopped.readable.flushed_bytes,stopped.readable.synced_bytes);
    const bytes=await readFile(path.join(root,'logs',stopped.readable.filename));
    assert.equal(bytes.byteLength,stopped.readable.synced_bytes);
    assert.ok(bytes.includes(Buffer.from('TAB_RECORD_SSH_FILE')));
    if(notices)await waitForStopNotice(main,'localhost',stopped);
    await right.control({op:'push',text:'\r\nAFTER_TAB_STOP\r\n'});
    await main.waitFor(`${pane(b)}?.querySelector('.xterm-rows')?.textContent.includes('AFTER_TAB_STOP')`);
    assert.deepEqual(await readFile(path.join(root,'logs',stopped.readable.filename)),bytes);

    const resumeRecording=async()=>{
      await recordClick(main,b);
      await recordState(main,b,'recording');
      const active=(await logs(main,b)).find(entry=>entry.active);
      assert.notEqual(active.log_id,stopped.log_id);
      assert.notEqual(active.readable.filename,stopped.readable.filename);
    };
    if(notices)noticeChecks=await checkNoticeActions(main,root,stopped,resumeRecording,()=>choose(c),version);
    else await resumeRecording();
    const live=(await logs(main,b)).find(entry=>entry.active);
    await right.control({op:'push',text:'\r\nDETACHED_TAB_RECORD\r\n'});
    child=await outsideDrag(b,true);
    await child.waitFor('document.querySelector("[data-pane]")?.dataset.renderedId==='+JSON.stringify(b.connection_id));
    await recordState(child,b,'recording');
    await checkLogToolbar(child,'detached recording log','停止记录');
    await child.screenshot(`desktop-${evidence}-detached-recording.png`);
    if(notices){
      await child.evaluate(`document.querySelector('.toolbar-log').click()`);
      const stop=`[...document.querySelectorAll('.terminal-context-menu button')].find(button=>button.textContent==='停止记录'&&!button.disabled)`;
      await child.waitFor(`!!(${stop})`);
      await child.evaluate(`(${stop}).click()`);
    }else await recordClick(child,b,true);
    await recordState(child,b,'idle');
    const detachedStop=(await logs(child,b)).find(entry=>entry.log_id===live.log_id);
    assert.equal(detachedStop.worker_finished&&detachedStop.durable,true);
    assert.ok((await readFile(path.join(root,'logs',detachedStop.readable.filename),'utf8')).includes('DETACHED_TAB_RECORD'));
    if(notices){
      await waitForStopNotice(child,'localhost',detachedStop);
      await child.screenshot(`desktop-${version}-detached-stop-notice.png`);
      await observeLogDirectory(child,root,()=>child.evaluate(`document.querySelector('.toolbar-log-directory').click()`));
    }
    await dockDrag(b);child.close();child=undefined;
    await recordState(main,b,'idle');
    assert.deepEqual(await logs(main,a),[]);
    if(notices){
      await choose(b);
      await tool('终端日志');
      for(const label of ['开始记录终端','停止记录终端']){
        await main.waitFor(`[...document.querySelectorAll('[aria-label="终端日志面板"] button')].some(btn=>btn.textContent===${JSON.stringify(label)}&&!btn.disabled)`);
        await main.click(label);
      }
      const advanced=await wait(async()=>{const [log]=await logs(main,b);return log.log_id!==detachedStop.log_id&&log.durable&&log.worker_finished?log:undefined;},'advanced panel stopped its own recording');
      await waitForStopNotice(main,'localhost',advanced);
      await main.click('关闭日志面板');
    }
    const close=await closeSoakDesktop(main,root,service,{});
    await main.close();main=undefined;
    report={result:'PASS',background:true,sameRequestOnReload:true,keyboard:true,split:true,detached:true,fileBytes:bytes.length,
      syncedBytes:stopped.readable.synced_bytes,untouchedOther:true,toolbar,
      ...(notices?{directoryExplorer:true,directoryFailureOnly:true,unknownStopSilent:true,detachedMenuStop:true,advancedStop:true,noticeChecks}:{}),close};
  }else if(dockProbe){
    await fit(1100);
    child=await outsideDrag(b);
    await child.waitFor('document.querySelector("[data-pane]")?.dataset.renderedId==='+JSON.stringify(b.connection_id));
    const detachedLog=await checkLogToolbar(child,'detached log');
    await dockDrag(b);child.close();child=undefined;
    await main.waitFor('!!'+tab(b));
    const close=await closeSoakDesktop(main,root,service,{});
    await main.close();main=undefined;
    report={result:'PASS',detachedLog,detachedAndDocked:true,close};
  }else{
  const settingsEntry=await main.evaluate(`[...document.querySelectorAll('.tools-menu button')].find(b=>b.textContent==='软件设置')?.textContent??'外观'`);
  await tool(settingsEntry);await main.fill('应用主题','dark');await escape(main);
  const positions={left:[.18,.54],top:[.54,.18],bottom:[.54,.82],right:[.82,.54]};
  const drops=[];
  for(const width of [1100,900]){
    await fit(width);
    for(const [edge,[x,y]] of Object.entries(positions)){
      const bounds=await geometry(host(a));
      const to=point(bounds,x,y);
      assert.ok(Math.min(to.x-bounds.left,bounds.right-to.x,to.y-bounds.top,bounds.bottom-to.y)>24);
      console.log('Native drop',width,edge);
      await physical(tab(b),to,'.tab-split-preview[data-edge="'+edge+'"]');
      const leading=edge==='left'||edge==='top';
      await main.waitFor(rendered(leading?b:a,0)+' && '+rendered(leading?a:b,1));
      assert.equal(await main.evaluate('document.querySelector(".pane-active").dataset.renderedId'),a.connection_id);
      drops.push({width,edge,x,y,minimumEdgeDistance:Math.min(to.x-bounds.left,bounds.right-to.x,to.y-bounds.top,bounds.bottom-to.y)});
    }
  }
  await fit(1100);
  await main.evaluate('void(window.originalPaneRenderer='+pane(a)+'.querySelector(".xterm"))');
  await physical(tab(c),point(await geometry(host(a)),.55,.82),'.tab-split-preview[data-edge=bottom]',`desktop-${evidence}-split-preview.png`);
  await main.waitFor(rendered(a,0)+' && '+rendered(c,1)+' && '+rendered(b,2));
  assert.equal(await main.evaluate(pane(a)+'.querySelector(".xterm")===window.originalPaneRenderer'),true);
  const upper=await geometry(pane(a)),below=await geometry(pane(c)),rightBounds=await geometry(pane(b));
  assert.ok(Math.abs(upper.left-below.left)<1&&below.top>upper.bottom&&rightBounds.left>upper.right);
  assert.ok(Math.abs(rightBounds.top-upper.top)<1&&Math.abs(rightBounds.bottom-below.bottom)<1);
  const separator=query('.split-divider[aria-orientation=horizontal]');
  const move=center(await geometry(separator));
  dragNativeWindow(main.app,[move,{x:move.x,y:move.y+40}],{executable:desktop,raise:true});
  await main.waitFor('Number('+separator+'.getAttribute("aria-valuenow"))>53');

  const addMenu=pane(a)+'.querySelector(".new-menu")';
  if(toolbarChecks)toolbar.push(...await checkNewConnectionMenu(main,'[data-rendered-id="'+b.connection_id+'"]'));
  await main.evaluate(addMenu+'.open=true; '+addMenu+'.querySelector("button").click()');
  await main.waitFor('!!document.querySelector(\'dialog:modal[aria-label="连接服务器"]\')');
  await main.waitFor('document.querySelector(\'dialog:modal button[type=submit]:not([disabled])\')?.textContent==="连接"');
  await main.fill('SSH服务器','127.0.0.1');await main.fill('SSH端口',added.port);
  await main.fill('SSH用户名','synthetic');await main.fill('SSH登录密码',added.password);
  await main.evaluate('document.querySelector(\'dialog:modal[aria-label="连接服务器"] form\').requestSubmit()');
  await main.waitFor('!!document.querySelector(\'dialog:modal [aria-label="快速连接核对指纹"]\')');
  assert.equal(await main.evaluate('document.querySelector("dialog:modal .fingerprint").textContent'),added.pin);
  await main.evaluate('document.querySelector(\'[aria-label="快速连接核对指纹"]\').click()');
  await main.click('信任并继续登录');
  const ids=new Set([a,b,c].map(c=>c.connection_id));
  const d=await wait(async()=>(await main.invoke('service_list')).find(item=>!ids.has(item.connection_id)&&item.state==='CONNECTED'),'group plus connection');
  await main.waitFor(rendered(d,0));
  assert.deepEqual(new Set(await tabIds(d)),new Set([a.connection_id,d.connection_id]));
  await physical(tab(d),point(await geometry(host(b)),.55,.50),'.tab-merge-preview',`desktop-${evidence}-merge-preview.png`);
  await main.waitFor(rendered(a,0)+' && '+rendered(c,1)+' && '+rendered(d,2));
  assert.deepEqual(new Set(await tabIds(d)),new Set([b.connection_id,d.connection_id]));
  assert.deepEqual(await tabIds(a),[a.connection_id]);
  assert.deepEqual(await tabIds(c),[c.connection_id]);
  await physical(tab(b),point(await geometry(tab(d)),.85,.5),'[data-insertion=after]');
  await main.waitFor('document.querySelectorAll(\'[data-rendered-id="'+d.connection_id+'"] [role=tab]\')[1]?.dataset.connectionId==="'+b.connection_id+'"');
  await choose(a);
  for(const target of [c,d,a]){
    await main.command('Input.dispatchKeyEvent',{type:'keyDown',key:'F6',code:'F6',windowsVirtualKeyCode:117});
    await main.command('Input.dispatchKeyEvent',{type:'keyUp',key:'F6',code:'F6',windowsVirtualKeyCode:117});
    await main.waitFor('document.querySelector(".pane-active")?.dataset.renderedId==='+JSON.stringify(target.connection_id)+' && document.activeElement?.classList.contains("xterm-helper-textarea")');
  }
  const logging=request=>main.invoke('logging_request',{request});
  const records=[];
  for(const [target,peer,marker] of [[a,left,'PANE-A-INPUT'],[c,lower,'PANE-C-INPUT'],[d,added,'PANE-D-INPUT']]){
    const connection=ref(target);
    const log=await logging({op:'start',connection,request_id:requestId(),limits:{segment_bytes:131072,segments:2}});
    await choose(target);await write(main,peer,marker);
    await peer.control({op:'push',text:marker+'-OUTPUT\r\n'});
    await main.waitFor(host(target)+'.textContent.includes('+JSON.stringify(marker+'-OUTPUT')+')');
    const state=await wait(async()=>{
      const status=await logging({op:'status',connection,log_id:log.log_id});
      if(!status.readable)return;
      const text=await readFile(path.join(root,'logs',status.readable.filename),'utf8');
      return text.includes(marker+'-OUTPUT')&&{status,text};
    },'owned recording marker');
    for(const other of ['PANE-A-INPUT','PANE-C-INPUT','PANE-D-INPUT'])if(other!==marker)assert.ok(!state.text.includes(other));
    records.push({marker,connection});
  }
  for(const [peer,expected] of [[left,'PANE-A-INPUT'],[lower,'PANE-C-INPUT'],[added,'PANE-D-INPUT'],[right,'']])
    assert.equal(Buffer.from((await peer.control({op:'metrics'})).received.flat()).toString(),expected);
  await main.screenshot(`desktop-${evidence}-nested-pane-tabs.png`);
  if(toolbarChecks)toolbar.push(await checkLogToolbar(main,'main log'));

  await physical(tab(d),point(await geometry(tab(c)),.75,.5),'[data-insertion=after]');
  await main.waitFor(rendered(d,1)+' && '+rendered(b,2));
  assert.deepEqual(new Set(await tabIds(d)),new Set([c.connection_id,d.connection_id]));
  await fit(900);
  await physical(tab(d),point(await geometry(host(b)),.5,.5),'.tab-merge-preview');
  await main.waitFor(rendered(c,1)+' && '+rendered(d,2));
  await main.evaluate(query('button[aria-label="关闭标签 '+c.connection_id+'"]')+'.click()');
  await main.waitFor('document.querySelectorAll("[data-pane]").length===2 && !'+tab(c));

  await fit(1100);
  child=await outsideDrag(b);
  await child.waitFor('document.querySelector("[data-pane]")?.dataset.renderedId==='+JSON.stringify(b.connection_id));
  if(toolbarChecks){
    toolbar.push(await checkLogToolbar(child,'detached log'));
    await child.screenshot(`desktop-${evidence}-detached-toolbar.png`);
  }
  assert.deepEqual((await child.invoke('service_list')).map(ref),[ref(b)]);
  await main.waitFor('!'+tab(b));
  await dockDrag(b);child.close();child=undefined;
  await main.waitFor('!!'+tab(b));
  await main.click('收起窗格 2');
  await main.waitFor('document.querySelectorAll("[data-pane]").length===1 && document.querySelectorAll("[role=tab]").length===3');
  const close=await closeSoakDesktop(main,root,service,{});
  await main.close();main=undefined;
  report={result:'PASS',drops,layout:'left vertical split beside right pane',f6:true,exactInput:true,
    recording:records.map(entry=>entry.marker),centerAndRailMerge:true,groupPlus:true,lastTabCollapse:true,detachedAndDocked:true,
    ...(toolbarChecks?{toolbar}:{}),close};
  }
}catch(error){
  if(tabRecording&&main) {
    await main.screenshot(`desktop-${evidence}-tab-recording-failure.png`).catch(()=>{});
    const state=await main.evaluate(`[...document.querySelectorAll('.connection-tab')].map(e=>({label:e.querySelector('.tab-label').textContent,record:e.querySelector('.tab-record-button')?.outerHTML}))`).catch(String);
    console.error('Recording controls at failure:',state);
  }
  throw error;
}finally{
  child?.close();
  await main?.close();
  for(const process of processes){
    if(process.exitCode!==null||process.signalCode!==null)continue;
    const exited=new Promise(resolve=>process.once('exit',resolve));process.stdin.end();await exited;
  }
  assert.equal(path.dirname(root),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('shared-terminal-pane-groups-ui-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
await writeFile(notices?`artifacts/windows-${evidence}-recording-notices.json`:tabRecording?`artifacts/windows-${evidence}-tab-recording-ssh.json`:dockProbe?`artifacts/windows-${evidence}-dock-toolbar.json`:`artifacts/windows-${evidence}-pane-groups.json`,JSON.stringify(report,null,2)+'\n');
console.log(notices?'PASS fixed log directory, verified stop notices, timeouts and exact original file':tabRecording?'PASS SSH tab recording, exact unknown recovery, synced file, split and detached window':dockProbe?'PASS detached toolbar popup and native dock return':
  'PASS physical pane tabs, nested geometry, input, recording and docking');
