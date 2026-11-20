import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {connectDesktopPage, delay, dragNativeWindow, launchDesktop} from './lib/DesktopHarness.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-terminal-window-ui-中文-'));
const desktop = path.resolve('target/debug/shared-terminal-desktop.exe');
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
const selector = (tag,label) => `${tag}[aria-label=${JSON.stringify(label)}]`;
const query = css => `document.querySelector(${JSON.stringify(css)})`;
const modal = label => query(selector('dialog:modal',label));
const dialog = label => query(selector('dialog[open]',label));
const geometry = expression => main.evaluate(`${expression}.getBoundingClientRect().toJSON()`);
const input = (page,type,point) => page.command('Input.dispatchMouseEvent',{
  type, ...point, button:'left', buttons:type==='mouseReleased'?0:1, clickCount:type==='mouseMoved'?0:1,
});
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
const panelHeading = expression => `${expression}.querySelector(':scope > .config-panel > .config-heading:first-child h2')`;
const center = rect => ({x:rect.left+rect.width/2,y:rect.top+rect.height/2});
async function drag(from,to,{during,intermediate}={}) {
  await input(main,'mousePressed',from);
  if(intermediate)await input(main,'mouseMoved',intermediate);
  await input(main,'mouseMoved',to);
  if(during)await during();
  await input(main,'mouseReleased',to);
}
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
async function outsideDrag(c) {
  const start=center(await geometry(query(`[role="tab"][data-connection-id="${c.connection_id}"]`)));
  await main.command('Page.bringToFront');
  dragNativeWindow(main.app,[start,{x:start.x-20,y:start.y+35},{x:50,y:120},{x:-40,y:150,outside:true}]);
  const target=await wait(async()=>(await main.otherPages())[0],'native detached WebView');
  return connectDesktopPage(target);
}

try {
  const left=await synthetic('left'),right=await synthetic('right');
  main=await launchDesktop(root);
  const service=await main.invoke('service_status');
  await tool('外观');
  await main.fill('应用主题','dark');
  const appearance=modal('外观设置');
  const initial=await geometry(appearance);
  await drag(center(await geometry(panelHeading(appearance))),{x:initial.left+130,y:initial.top+24+90});
  const moved=await geometry(appearance);
  assert.ok(moved.x>initial.x+40 && moved.y>initial.y+45,'dragging the title bar moves the dialog');
  const slider=await geometry(query('[aria-label="终端文字亮度"]'));
  await drag({x:slider.right-25,y:center(slider).y},{x:slider.left+60,y:center(slider).y});
  assert.equal((await geometry(appearance)).x,moved.x,'operating a slider does not move its dialog');
  assert.ok(await main.evaluate(`${query('[aria-label="终端文字亮度"]')}.valueAsNumber<100`));
  await main.fill('终端文字亮度',100);
  await main.screenshot('desktop-draggable-appearance.png');
  await fit(720);
  const fitted=await geometry(appearance);
  assert.ok(fitted.left>=7&&fitted.top>=7&&fitted.right<=(await main.evaluate('innerWidth'))-7&&fitted.bottom<=(await main.evaluate('innerHeight'))-7);
  await escape(main);
  await main.waitFor(`!${appearance} && document.activeElement?.matches('.tools-menu > summary')`);
  await tool('外观');
  assert.ok(Math.abs((await geometry(appearance)).left-(await main.evaluate('innerWidth')-(await geometry(appearance)).width)/2)<2);
  await main.click('保存桌面偏好');
  await main.waitFor(`document.querySelector('[aria-label="桌面偏好状态"]').textContent.includes('已保存')`);
  await main.click('关闭外观');

  for(const [entry,label] of [
    ['连接配置','连接配置'],['批量修改配置','批量修改连接配置'],['导入原生配置','原生连接配置导入'],
    ['上次关闭信息','上次关闭信息'],['另存保全信息','另存保全信息'],['工作区','保存与打开工作区'],
    ['标签分组','管理标签分组'],['SSH2 连接','SSH2 连接工具'],['串口高级工具','串口高级工具'],
    ['exec 任务','独立 exec 任务'],['基础撰写','撰写终端输入'],['终端日志','管理终端日志'],
    ['Agent 授权','管理 Agent 授权'],['查找终端','查找终端内容'],['常用命令','管理和准备常用命令'],
    ['多目标发送','明确选择多目标文本发送'],['连续同步键盘','明确启停连续同步键盘'],['窗口触发器','配置本窗口触发器'],
  ]){
    const before=await geometry(query('.terminal-workspace'));
    await tool(entry);
    await main.waitFor(`!!${dialog(label)}`);
    assert.equal((await geometry(query('.terminal-workspace'))).width,before.width,entry);
    assert.equal(await main.evaluate(`!!(${panelHeading(dialog(label))}) && !!document.querySelector('.session-sidebar').getClientRects().length && !document.querySelector('.auxiliary-panels')`),true,entry);
    await escape(main);
    await main.waitFor(`!${dialog(label)}`);
  }
  await tool('终端日志');
  await tool('Agent 授权');
  const logDialog=dialog('管理终端日志'),agentDialog=dialog('管理 Agent 授权');
  assert.ok(await main.evaluate(`Number(getComputedStyle(${agentDialog}).zIndex)>Number(getComputedStyle(${logDialog}).zIndex)`));
  await main.evaluate(`${logDialog}.querySelector('button').focus()`);
  assert.ok(await main.evaluate(`Number(getComputedStyle(${agentDialog}).zIndex)<Number(getComputedStyle(${logDialog}).zIndex)`));
  await escape(main);
  await main.waitFor(`!${logDialog} && !!${agentDialog}`);
  await main.click('关闭Agent授权');
  await fit(1100);
  const a=await connect(left,'127.0.0.1'),b=await connect(right,'localhost');
  await main.waitFor(`document.querySelectorAll('[role="tab"]').length===2 && document.querySelector('.pane-active')?.dataset.renderedId`);
  await left.control({op:'push',text:'BEFORE-WINDOW-A\r\n'});
  await right.control({op:'push',text:'BEFORE-WINDOW-B\r\n'});
  const tab=c=>query(`[role="tab"][data-connection-id="${c.connection_id}"]`);
  await main.evaluate(`${tab(a)}.click()`);
  await main.waitFor(terminalText('BEFORE-WINDOW-A'));
  const before=await main.evaluate(`[...document.querySelectorAll('[role="tab"]')].map(tab=>tab.dataset.connectionId)`);
  const source=before[0]===a.connection_id?a:b,anchor=source===a?b:a;
  const anchorRect=await geometry(tab(anchor));
  await drag(center(await geometry(tab(source))),{x:anchorRect.right-8,y:center(anchorRect).y},{
    during:async()=>{await main.waitFor(`!!document.querySelector('[data-insertion="after"]')`);await main.screenshot('desktop-tab-insertion.png');},
  });
  await main.waitFor(`JSON.stringify([...document.querySelectorAll('[role="tab"]')].map(tab=>tab.dataset.connectionId))===${JSON.stringify(JSON.stringify(before.toReversed()))}`);
  assert.equal(await main.evaluate(`${tab(a)}.getAttribute('aria-selected')`),'true');

  for(const edge of ['left','right','top','bottom']){
    const grid=await geometry(query('.terminal-grid'));
    const point=center(grid);
    if(edge==='left')point.x=grid.left+15;
    if(edge==='right')point.x=grid.right-15;
    if(edge==='top')point.y=grid.top+15;
    if(edge==='bottom')point.y=grid.bottom-15;
    const leading=edge==='left'||edge==='top';
    const direction=['left','right'].includes(edge)?'horizontal':'vertical';
    await drag(center(await geometry(tab(b))),point,{
      during:async()=>{
        await main.waitFor(`!!${query(`.tab-split-preview[data-edge="${edge}"]`)}`);
        if(edge==='left')await main.screenshot('desktop-tab-split-drop.png');
      },
    });
    await main.waitFor(`!!document.querySelector('.terminal-grid.${direction}') && ${rendered(leading?b:a,0)} && ${rendered(leading?a:b,1)}`);
    assert.equal(await main.evaluate(`document.querySelector('.pane-active').dataset.renderedId`),a.connection_id);
    await main.click('收起分屏，保留连接');
    await main.waitFor(`document.querySelectorAll('[data-pane]').length===1 && ${rendered(a,0)}`);
  }
  const terminal=await main.evaluate(`(()=>{const host=document.querySelector('.terminal'),xterm=host.querySelector('.xterm'),s=getComputedStyle(host);return {borderLeft:s.borderLeftColor,borderRight:s.borderRightColor,background:s.backgroundColor,custom:xterm.querySelectorAll('.scrollbar.vertical').length,legacy:getComputedStyle(xterm.querySelector('.xterm-viewport')).overflowY};})()`);
  assert.deepEqual(terminal,{borderLeft:'rgba(0, 0, 0, 0)',borderRight:'rgba(0, 0, 0, 0)',background:'rgb(0, 0, 0)',custom:1,legacy:'hidden'});
  await left.control({op:'push',text:Array.from({length:65},(_,i)=>`EDGE-${i}\r\n`).join('')});
  await main.waitFor(terminalText('EDGE-64'));
  const end=await geometry(query('.terminal'));
  await main.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:end.right-25,y:end.top+40});
  await main.screenshot('desktop-single-terminal-edges.png');
  await left.control({op:'push',text:'RETAINED-INDEPENDENT-A\r\n'});
  const log = await main.invoke('logging_request',{request:{op:'start',connection:ref(a),request_id:requestId(),limits:{segment_bytes:131072,segments:2}}});

  child=await outsideDrag(a);
  await child.waitFor(`document.querySelector('footer')?.dataset.serviceId===${JSON.stringify(service.service_id)} && ${terminalText('RETAINED-INDEPENDENT-A')}`);
  await child.waitFor(`document.activeElement?.matches('.xterm-helper-textarea') && document.hasFocus()`);
  assert.equal((await child.invoke('service_status')).pid,service.pid);
  assert.deepEqual((await child.invoke('service_list')).map(ref),[ref(a)]);
  assert.deepEqual((await main.invoke('service_list')).map(ref),[ref(b)]);
  await main.waitFor(rendered(b,0));
  assert.equal(await main.evaluate(`!!${tab(a)}`),false);
  await child.screenshot('desktop-detached-session.png');
  const position=await child.evaluate('({x:screenX,y:screenY})');
  dragNativeWindow(main.app,[{x:200,y:-14},{x:237,y:15},{x:274,y:55}],{title:'共享终端 · 独立会话'});
  await child.waitFor(`Math.abs(screenX-${position.x})>40 && Math.abs(screenY-${position.y})>30`);
  await assert.rejects(main.invoke('ssh_request',{request:{op:'write_text',connection:ref(a),request_id:requestId(),text:'WRONG-WINDOW'}}),/SESSION_IN_OTHER_WINDOW/);
  await assert.rejects(child.invoke('ssh_request',{request:{op:'write_text',connection:ref(b),request_id:requestId(),text:'WRONG-WINDOW'}}),/SESSION_IN_OTHER_WINDOW/);
  await assert.rejects(child.invoke('service_read',{connection:ref(b),cursor:1}),/SESSION_IN_OTHER_WINDOW/);
  await write(child,left,'DETACHED-INPUT-A');
  await write(main,right,'MAIN-INPUT-B');
  assert.equal(Buffer.from((await left.control({op:'metrics'})).received.flat()).toString(),'DETACHED-INPUT-A');
  assert.equal(Buffer.from((await right.control({op:'metrics'})).received.flat()).toString(),'MAIN-INPUT-B');
  await left.control({op:'push',text:'RECORDED-IN-INDEPENDENT-WINDOW\r\n'});
  const listLogs=()=>child.invoke('logging_request',{request:{op:'list',connection:ref(a)}}).then(reply=>reply.logs);
  await wait(async()=>{const [item]=await listLogs();return item?.log_id===log.log_id && item.readable && (await readFile(path.join(root,'logs',item.readable.filename),'utf8')).includes('RECORDED-IN-INDEPENDENT-WINDOW');},'same active recording writes independent-window output');
  await child.evaluate(`document.querySelector('.toolbar-log').click()`);
  await child.waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some(item=>item.textContent==='停止记录'&&!item.disabled)`);
  await child.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent==='停止记录').click()`);
  await wait(async()=>{const [item]=await listLogs();return item?.durable&&!item.active;},'stop log from detached window');

  const requestClose = () => main.invoke('plugin:window|close',{label:'main'});
  const exit=modal('退出桌面确认');
  await requestClose();
  await main.waitFor(`!!${exit} && document.activeElement?.textContent==='取消退出'`);
  await drag(center(await geometry(panelHeading(exit))),{x:740,y:410});
  await main.screenshot('desktop-exit-dialog.png');
  await main.click('取消退出');
  await main.waitFor(`!${exit}`);
  assert.equal((await child.invoke('service_status')).service_id,service.service_id);
  await child.evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='移回主窗口').click();true`);
  await wait(async()=>!(await main.otherPages()).length,'close detached native window');
  child.close();child=undefined;
  await main.waitFor(`!!${tab(a)} && !!${tab(b)}`);
  assert.deepEqual((await main.invoke('service_list')).map(ref).sort((x,y)=>x.connection_id.localeCompare(y.connection_id)),[ref(a),ref(b)].sort((x,y)=>x.connection_id.localeCompare(y.connection_id)));
  await main.evaluate(`${tab(a)}.click()`);
  await main.waitFor(terminalText('RECORDED-IN-INDEPENDENT-WINDOW'));
  assert.equal((await left.control({op:'metrics'})).attempts,1);
  assert.equal((await right.control({op:'metrics'})).attempts,1);

  // Exit when the only live session is owned by the detached window.
  child=await outsideDrag(a);
  await child.waitFor(rendered(a,0));
  await main.invoke('ssh_request',{request:{op:'close',connection:ref(b)}});
  await wait(async()=>(await main.invoke('service_list')).every(c=>c.state==='DISCONNECTED'),'main connection ends');
  await tool('外观');
  await requestClose();
  await main.waitFor(`!!${exit} && document.activeElement?.textContent==='取消退出'`);
  await escape(main);
  await main.waitFor(`!${exit} && ${appearance}.contains(document.activeElement)`);
  await main.click('关闭外观');
  await requestClose();
  await main.waitFor(`!!${exit}`);
  await main.click('确认退出并停止服务');
  await wait(()=>main.app.exitCode!==null,'app exits with child still open');
  assert.equal(main.app.exitCode,0);
  await main.close();main=undefined;
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',service.service_id+'.json'),'utf8'));
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');
  assert.equal(receipt.owned_pid,service.pid);
  assert.equal(receipt.exited,true);
  await writeFile('artifacts/desktop-window-interactions-result.json',JSON.stringify({result:'PASS',dialogs:'wide/narrow, drag, Escape and nested native modal focus',split:['left','right','top','bottom'],detach:'native pointer outside the owned HWND, exact original connection and service, correct keyboard and log routing, reattach, parent shutdown'},null,2));
  console.log('PASS desktop draggable dialogs, four split edges, tab insertion, physical drag outside native window, ownership handoff, recording, reattach and managed exit');
}catch(error){
  await main?.screenshot('desktop-window-interactions-failure.png').catch(()=>{});
  await writeFile('artifacts/desktop-window-interactions-failure.txt',String(error.stack??error));
  throw error;
}finally{
  child?.close();
  await main?.close();
  for(const proc of processes){
    if(proc.exitCode!==null||proc.signalCode!==null)continue;
    const exited=new Promise(resolve=>proc.once('exit',resolve));
    proc.kill();
    await exited;
  }
  assert.equal(path.dirname(root),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('shared-terminal-window-ui-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
