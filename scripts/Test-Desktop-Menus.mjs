import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const version=path.basename(path.dirname(executable)).match(/^SharedTerminal-(\d+\.\d+\.\d+)-windows-x64$/)?.[1]??'0.1.25';
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-menu-ui-中文-'));
const evidence={result:'IN_PROGRESS',executable,desktopSha256:createHash('sha256').update(await readFile(executable)).digest('hex'),
  screenshots:[],surfaces:[],checks:[]};
const q=JSON.stringify;
const node=css=>`document.querySelector(${q(css)})`;
const tools='.tools-menu > summary', top='.tools-menu .app-menu', plus='.pane-active .new-menu > summary';
const plusMenu='.pane-active .new-menu .app-menu', configPlus='.tree-new-menu > summary';
const treeMenu='[aria-label="会话配置菜单"]', sessionMenu='[aria-label="会话标签菜单"]';
const localInput='.pane-active .local-terminal:not([hidden]) .xterm-helper-textarea';
const localBody='.pane-active .local-terminal:not([hidden]) .local-terminal-output';
const localMenu='[aria-label="本地终端右键菜单"]', logMenu='[aria-label="终端日志菜单"]';
const rowTrigger='[aria-label="示例脚本 的管理操作"]', rowMenu='[aria-label="示例脚本 的管理菜单"]';
const addTrigger='button[aria-label="新建快捷指令"]', addMenu='[aria-label="新建指令类型"]';
const id=randomUUID(), profile=`[data-profile-id="${id}"]`;
const profileName='菜单样本 · 回环连接';
let ui,peer,lines,baseline;

const wait=expression=>ui.waitFor(expression);
const focus=selector=>ui.evaluate(`${node(selector)}.focus()`);
const active=selector=>wait(`document.activeElement===${node(selector)}`);
const point=(selector,x=.5,y=.5)=>ui.evaluate(`(()=>{const r=${node(selector)}.getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`);
async function mouse(type,where,button='left',count=1){
  await ui.command('Input.dispatchMouseEvent',{type,...where,button,buttons:type==='mouseReleased'?0:button==='right'?2:1,clickCount:count});
}
async function click(selector,button='left',count=1){
  const p=await point(selector);
  assert.equal(await ui.evaluate(`${node(selector)}.contains(document.elementFromPoint(${p.x},${p.y}))`),true,selector);
  await mouse('mousePressed',p,button,count);
  await mouse('mouseReleased',p,button,count);
}
const move=where=>ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...where});
async function key(key,modifiers=0){
  const vk={Escape:27,Tab:9,Enter:13,ArrowDown:40,ArrowUp:38,Home:36,End:35,F10:121}[key];
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{
    type,key,code:key,windowsVirtualKeyCode:vk,modifiers,...(key==='Enter'&&type==='keyDown'?{text:'\r'}:{}),
  });
}
const visible=selector=>wait(`!!${node(selector)}?.dataset.positioned&&getComputedStyle(${node(selector)}).visibility==='visible'`);
const config=request=>ui.invoke('config_request',{request});
const terminal=(text)=>ui.command('Input.insertText',{text});
const selected=()=>ui.evaluate("document.querySelector('.pane-active [role=tab][aria-selected=true]')?.dataset.connectionId");
const action=label=>wait(`document.activeElement?.textContent===${q(label)}`);
const close=async(selector,trigger)=>{await key('Escape');await wait(`!${node(selector)}?.dataset.positioned`);await active(trigger);};
async function screenshot(name){
  const file=`windows-${version}-menus-${name}.png`;
  await ui.screenshot(file);
  evidence.screenshots.push(file);
}
async function style(selector){
  await visible(selector);
  await ui.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  return ui.evaluate(`(()=>{
    const popup=${node(selector)},item=popup.querySelector('button'),box=popup.getBoundingClientRect();
    const style=getComputedStyle(popup),row=getComputedStyle(item);
    return {chrome:[style.backgroundColor,style.borderColor,style.borderRadius,style.boxShadow,style.padding],
      item:[row.fontSize,row.lineHeight,row.minHeight,row.padding,row.borderRadius],
      box:[box.left,box.top,box.right,box.bottom],viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,
      visibleCount:[...popup.querySelectorAll('button')].filter(b=>b.getClientRects().length).length,
      scrollable:popup.scrollHeight>popup.clientHeight,wideLabels:[...popup.querySelectorAll('button')]
        .filter(b=>b.getClientRects().length&&b.scrollWidth>b.clientWidth).map(b=>b.textContent)};
  })()`);
}
async function surface(label,selector,snapshot){
  const result=await style(selector);
  assert.ok(result.box[0]>=7&&result.box[1]>=7&&result.box[2]<=result.viewport[0]-7&&result.box[3]<=result.viewport[1]-7,
    `${label} ${JSON.stringify(result.box)} within ${JSON.stringify(result.viewport)}`);
  assert.deepEqual(result.chrome,baseline.chrome,label+' surface');
  assert.deepEqual(result.item,baseline.item,label+' row');
  assert.deepEqual(result.wideLabels,[],label+' untruncated labels');
  evidence.surfaces.push({label,...result});
  if(snapshot)await screenshot(snapshot);
  return result;
}
async function tool(label){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(label);
}
async function reply(){
  let timeout;
  try{return await Promise.race([lines.next().then(line=>JSON.parse(line.value)),new Promise((_,reject)=>{
    timeout=setTimeout(()=>reject(new Error('Loopback fixture timeout')),8000);
  })]);}finally{clearTimeout(timeout);}
}
const ask=async request=>{peer.stdin.write(JSON.stringify(request)+'\n');return reply();};
async function until(read){
  for(let i=0;i<160;i++){
    const value=await read();
    if(value)return value;
    await delay(50);
  }
  assert.fail('Expected loopback state did not arrive');
}

try{
  const script=path.join(root,'示例脚本.cmd');
  await writeFile(script,'@echo off\r\necho MENU_NOT_EXECUTED\r\n');
  peer=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  lines=createInterface({input:peer.stdout})[Symbol.asyncIterator]();
  const server=await reply();
  const previous=path.resolve('artifacts/SharedTerminal-0.1.25-windows-x64-tab-fix/shared-terminal-desktop.exe');
  ui=await launchDesktop(root,{executable:previous,webviewDirectory:path.join(root,'baseline-webview')});
  await ui.command('Emulation.setDeviceMetricsOverride',{width:1100,height:710,deviceScaleFactor:1,mobile:false});
  await click(tools);
  evidence.originalToolbar=await style('.tools-menu .tools-menu-content');
  await tool('退出桌面');
  await until(()=>ui.app.exitCode!==null);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
  ui=await launchDesktop(root,{executable});
  assert.equal((await ui.invoke('service_status')).fixture,false);
  evidence.nativeDpr=await ui.evaluate('devicePixelRatio');
  await ui.command('Emulation.setDeviceMetricsOverride',{width:1100,height:710,deviceScaleFactor:1,mobile:false});
  await wait("innerWidth===1100&&devicePixelRatio===1&&document.documentElement.dataset.theme==='light'");
  await config({op:'save_profile',profile:{id,folder_id:null,name:profileName,settings:{protocol:'ssh2',
    host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}},
    credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}});
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:null,shortcuts:[{id:randomUUID(),name:'示例脚本',script_path:script}]}});
  if(!await ui.evaluate("document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')==='true'"))
    await click('.sidebar-toggle');
  await ui.click('刷新会话树');
  await wait(`!!${node(profile)}`);
  await tool('轻量命令行');await active(localInput);
  const localId=await selected(), localTab=`[role="tab"][data-connection-id="${localId}"]`;
  await terminal('MENU_DRAFT_123');
  await wait(`${node(localBody)}.innerText.includes('MENU_DRAFT_123')`);
  await ui.evaluate(`window.originalLocal=${node(localBody)}.querySelector('.xterm')`);
  if(!await ui.evaluate(`!!${node(rowTrigger)}?.getClientRects().length`))await ui.click('快捷指令');
  await wait(`!!${node(rowTrigger)}?.getClientRects().length`);

  await click(tools);baseline=await style(top);
  assert.deepEqual(baseline.chrome,evidence.originalToolbar.chrome);
  assert.deepEqual(baseline.item,evidence.originalToolbar.item);
  assert.equal(baseline.box[2]-baseline.box[0],evidence.originalToolbar.box[2]-evidence.originalToolbar.box[0]);
  await surface('更多工具',top,'01-light-toolbar');
  await key('ArrowDown');await action('查找终端');
  assert.equal(await ui.evaluate("getComputedStyle(document.activeElement).outlineStyle"),'solid');
  await key('End');await action('退出桌面');
  assert.ok(await ui.evaluate(`${node(top)}.scrollTop>0`));
  await close(top,tools);

  await move(await point(plus));await visible(plusMenu);
  await surface('标签加号',plusMenu,'02-light-tab-plus');
  await move(await point(plusMenu+' button'));
  await wait(`getComputedStyle(${node(plusMenu+' button')}).backgroundColor!=='rgba(0, 0, 0, 0)'`);
  assert.equal(await selected(),localId);
  await move({x:18,y:350});await wait(`!${node(plusMenu)}.dataset.positioned`);
  await focus(plus);await key('ArrowDown');await action('本地终端');
  await move(await point(plusMenu+' button'));await move({x:18,y:350});await delay(170);
  await visible(plusMenu);await close(plusMenu,plus);

  await click(profile,'right');await surface('配置树右键',treeMenu,'03-light-tree-context');
  await key('End');await action('删除');await key('ArrowDown');await action('连接');await close(treeMenu,profile);
  await click(rowTrigger);await surface('快捷指令管理',rowMenu,'04-light-shortcut-more');
  await key('Home');await action('重命名');await key('ArrowDown');await action('置顶');
  await key('ArrowDown');await action('重新定位');await close(rowMenu,rowTrigger);
  await click(configPlus);await surface('配置加号','.tree-new-menu .app-menu');
  await key('ArrowDown');await action('新建 SSH 配置');await close('.tree-new-menu .app-menu',configPlus);
  await click(addTrigger);await surface('快捷指令加号',addMenu);await close(addMenu,addTrigger);
  await focus(localTab);await key('F10',8);await surface('会话标签右键',sessionMenu);await close(sessionMenu,localTab);
  await focus(localInput);await key('F10',8);await surface('本地复制粘贴',localMenu,'05-light-clipboard');
  await action('粘贴');await close(localMenu,localInput);
  assert.deepEqual(await ui.invoke('service_list'),[]);
  assert.equal(await ui.evaluate("document.querySelectorAll('[role=tab]').length"),1);
  assert.equal(await ui.evaluate(`${node(localBody)}.querySelector('.xterm')===window.originalLocal&&${node(localBody)}.innerText.includes('MENU_DRAFT_123')`),true);
  evidence.checks.push('light at 100%: matched chrome and action rows; passive openings, keyboard cycles and cancellation leave the existing local draft and session count unchanged');

  // The primary click and an explicit keyboard command still act at their own entry points.
  await click(plus);await wait("document.querySelectorAll('[role=tab]').length===2");
  await ui.click('关闭 本地 2');await wait("document.querySelectorAll('[role=tab]').length===1");
  await click(rowTrigger);await action('重命名');await key('Enter');
  await wait("!!document.querySelector('form[aria-label=快捷指令编辑]')");
  assert.equal(await ui.evaluate(`${node(localBody)}.querySelector('.xterm')===window.originalLocal&&${node(localBody)}.innerText.includes('MENU_DRAFT_123')`),true);
  await ui.click('取消编辑');
  const ssh=request=>ui.invoke('ssh_request',{request});
  const started=await ssh({op:'start',profile_id:id,request_id:requestId(),cols:80,rows:24});
  const target={connection_id:started.connection.connection_id,generation:started.connection.generation};
  const asked=new Set();
  for(let attempts=0;attempts<125;attempts++){
    const status=await ssh({op:'status',connection:target});
    const c=status.challenge;
    assert.notEqual(status.connection.state,'FAILED');
    if(status.connection.state==='CONNECTED')break;
    if(c&&!asked.has(c.id)){
      asked.add(c.id);
      if(c.kind==='host_key'){
        assert.equal(c.review.candidate.fingerprint,server.pin);
        await ssh({op:'answer_host',connection:target,challenge_id:c.id,approve:true});
      }else await ssh({op:'authenticate',connection:target,challenge_id:c.id,use_saved:true,password:null});
    }
    await delay(50);
  }
  assert.equal((await ssh({op:'status',connection:target})).connection.state,'CONNECTED');
  await ui.selectTab(localId);await active(localInput);
  const remoteTab=`[role="tab"][data-connection-id="${target.connection_id}"]`;
  const edge=await point('.pane-active .local-pane-body:not([hidden])',.86);
  await mouse('mousePressed',await point(remoteTab));await mouse('mouseMoved',edge);
  await wait("!!document.querySelector('.tab-split-preview[data-edge=right]')");
  await mouse('mouseReleased',edge);await wait("document.querySelectorAll('[data-pane]').length===2");
  await ui.selectTab(target.connection_id);
  await wait(`document.querySelector('.pane-active').dataset.renderedId===${q(target.connection_id)}`);
  await tool('SSH2 连接');
  const sshActions='.ssh-session-menu > summary', sshMenu='.ssh-session-menu .app-menu';
  await wait(`!!${node(sshActions)}?.getClientRects().length`);
  await click(sshActions);await surface('SSH 更多会话操作',sshMenu);
  assert.equal(await ui.evaluate(`${node(sshMenu+' button')}.disabled`),true);
  await key('ArrowDown');await active(sshActions);
  await close(sshMenu,sshActions);
  await key('Escape');await wait("!document.querySelector('dialog[open][aria-label=\"SSH2 连接工具\"]')");
  await ask({op:'push',text:'MENU_LAYOUT_LOOPBACK\r\n'});
  await wait("document.querySelector('.pane-active .xterm-rows').textContent.includes('MENU_LAYOUT_LOOPBACK')");
  await tool('软件设置');
  await wait("!!document.querySelector('dialog:modal[aria-label=软件设置]')");
  await ui.fill('应用主题','dark');
  await wait("document.documentElement.dataset.theme==='dark'");
  await ui.click('关闭软件设置');
  await ui.command('Emulation.setDeviceMetricsOverride',{width:720,height:360,deviceScaleFactor:1.5,mobile:false});
  await wait('innerWidth===720&&innerHeight===360&&devicePixelRatio===1.5');
  await click(tools);baseline=await style(top);
  await surface('深色更多工具',top,'06-dark-toolbar');
  await close(top,tools);
  await focus(plus);await key('ArrowDown');await surface('深色窄分屏加号',plusMenu);await close(plusMenu,plus);
  await click('.toolbar-log');
  const narrow=await surface('深色窄分屏日志',logMenu,'07-dark-narrow-log');
  assert.equal(narrow.scrollable,true);
  assert.ok(await ui.evaluate("document.querySelector('.pane-active').getBoundingClientRect().width<360"));
  assert.ok(await ui.evaluate(`${node(logMenu)}.innerText.includes('右窗格')`));
  await key('End');await action('粘贴');
  assert.ok(await ui.evaluate(`${node(logMenu)}.scrollTop>0`));
  await screenshot('08-dark-log-scrolled');
  await key('Home');await action('保存终端缓冲内容…');await close(logMenu,'.toolbar-log');
  const logs=async()=>(await ui.invoke('logging_request',{request:{op:'list',connection:target}})).logs;
  assert.deepEqual(await logs(),[]);
  const remoteInput='.pane-active .terminal .xterm-helper-textarea';
  await focus(remoteInput);await key('F10',8);await surface('深色终端键盘日志',logMenu);await close(logMenu,remoteInput);
  async function chooseRecording(label){
    await click('.toolbar-log');await visible(logMenu);
    const button=`[...${node(logMenu)}.querySelectorAll('button')].find(b=>b.textContent===${q(label)}&&!b.disabled)`;
    await wait(`!!(${button})`);
    await ui.evaluate(`(${button}).focus()`);
    await key('Enter');
    await wait(`!${node(logMenu)}`);
  }
  await chooseRecording('开始记录');
  const recording=await until(async()=>(await logs()).find(log=>log.active&&log.readable));
  await ask({op:'push',text:Array.from({length:100},(_,i)=>`LONG-MENU-LOG-${i.toString().padStart(3,'0')}\r\n`).join('')});
  const logfile=path.join(root,'logs',recording.readable.filename);
  await until(async()=>(await readFile(logfile,'utf8').catch(()=>'' )).includes('LONG-MENU-LOG-099'));
  await chooseRecording('停止记录');
  await until(async()=>(await logs()).find(log=>log.log_id===recording.log_id&&log.durable&&!log.active));
  assert.match(await readFile(logfile,'utf8'),/LONG-MENU-LOG-000[\s\S]*LONG-MENU-LOG-099/);
  assert.equal((await logs()).length,1);
  evidence.checks.push('dark WebView DPI simulation 150%: 720×360 CSS viewport, mixed split, long log menu scroll, disabled rows skipped, safe launch from the keyboard, Escape restores the exact trigger');
  evidence.checks.push('opening log menu creates no recording; explicit keyboard start and stop produce one durable log on the same loopback session with the first and last fixture lines');

  await ui.command('Emulation.clearDeviceMetricsOverride');
  await tool('退出桌面');await wait("!!document.querySelector('dialog:modal[aria-label=退出桌面确认]')");
  await ui.click('确认退出并停止服务');
  for(let i=0;i<240&&ui.app.exitCode===null;i++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  evidence.result='PASS';
  console.log('PASS shared menu styles, geometry, focus, passive opening, local draft and narrow dark split');
}catch(error){
  evidence.result='FAIL';
  evidence.error=String(error.stack);
  await ui?.screenshot(`windows-${version}-menus-failure.png`).catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(peer&&peer.exitCode===null&&peer.signalCode===null){
    const exited=new Promise(resolve=>peer.once('exit',resolve));
    peer.kill();await exited;
  }
  await writeFile(`artifacts/windows-${version}-menus-result.json`,JSON.stringify(evidence,null,2)+'\n');
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
