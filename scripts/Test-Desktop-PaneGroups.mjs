import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {connectDesktopPage, delay, dragNativeWindow, launchDesktop} from './lib/DesktopHarness.mjs';
import {closeSoakDesktop} from './lib/LoadSoak.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-terminal-pane-groups-ui-中文-'));
const desktop = path.resolve(process.argv[2]);
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
  dragNativeWindow(main.app,[start,{x:start.x-20,y:start.y+35},{x:50,y:120},{x:-40,y:150,outside:true}],{executable:desktop,raise:true});
  const target=await wait(async()=>(await main.otherPages())[0],'native detached WebView');
  return connectDesktopPage(target);
}
async function dockDrag(connection) {
  const mainBounds=await main.evaluate('({x:screenX,y:screenY,width:innerWidth,height:innerHeight})');
  const childBounds=await child.evaluate('({x:screenX,y:screenY,width:innerWidth,height:innerHeight})');
  const destination=[{x:mainBounds.width-65,y:100},{x:40,y:100},{x:mainBounds.width/2,y:45},{x:mainBounds.width/2,y:mainBounds.height-45}]
    .map(point=>({x:mainBounds.x+point.x-childBounds.x,y:mainBounds.y+point.y-childBounds.y}))
    .find(point=>point.x < -30 || point.y < -66 || point.x > childBounds.width+30 || point.y > childBounds.height+30);
  assert.ok(destination,'main has a visible landing area outside the child frame');
  const source=await child.evaluate(`document.querySelector('[role="tab"][data-connection-id="${connection.connection_id}"]').getBoundingClientRect().toJSON()`);
  const start=center(source);
  await child.command('Page.bringToFront');
  const points=[start,{x:start.x+32,y:start.y+40},{...destination,outside:true,holdMs:950}];
  const mouse=spawn('pwsh',['-NoProfile','-File','scripts/lib/Drag-TestWindow.ps1','-TargetProcessId',String(main.app.pid),
    '-ExpectedExecutable',desktop,'-Title','共享终端 · 独立会话','-Points',JSON.stringify(points),'-Raise'],{windowsHide:true});
  let errors='';
  mouse.stderr.on('data',chunk=>errors+=chunk);
  const done=new Promise(resolve=>mouse.once('exit',resolve));
  try {
    await main.waitFor(`!!document.querySelector('.tab-dock-preview')`);
    await main.screenshot('desktop-0.1.2-dock-preview.png');
  } finally {
    assert.equal(await done,0,errors);
  }
  await wait(async()=>!(await main.otherPages()).length,'physical drop returns the native session to main');
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
let report;
try{
  const left=await synthetic('left'),right=await synthetic('right'),lower=await synthetic('lower'),added=await synthetic('added');
  main=await launchDesktop(root,{executable:desktop,windowsHide:false});
  const service=await main.invoke('service_status');
  assert.equal(service.fixture,false);
  const a=await connect(left,'127.0.0.1'),b=await connect(right,'localhost'),c=await connect(lower,'127.0.0.1');
  await main.waitFor('document.querySelectorAll("[role=tab]").length===3');
  await choose(a);
  await tool('外观');await main.fill('应用主题','dark');await escape(main);
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
  await physical(tab(c),point(await geometry(host(a)),.55,.82),'.tab-split-preview[data-edge=bottom]','desktop-0.1.2-split-preview.png');
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
  await main.evaluate(addMenu+'.open=true; '+addMenu+'.querySelector("button").click()');
  await main.waitFor('!!document.querySelector(\'dialog:modal[aria-label="连接服务器"]\')');
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
  await physical(tab(d),point(await geometry(host(b)),.55,.50),'.tab-merge-preview','desktop-0.1.2-merge-preview.png');
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
  await main.screenshot('desktop-0.1.2-nested-pane-tabs.png');

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
  assert.deepEqual((await child.invoke('service_list')).map(ref),[ref(b)]);
  await main.waitFor('!'+tab(b));
  await dockDrag(b);child.close();child=undefined;
  await main.waitFor('!!'+tab(b));
  await main.click('收起窗格 2');
  await main.waitFor('document.querySelectorAll("[data-pane]").length===1 && document.querySelectorAll("[role=tab]").length===3');
  const close=await closeSoakDesktop(main,root,service,{});
  await main.close();main=undefined;
  report={result:'PASS',drops,layout:'left vertical split beside right pane',f6:true,exactInput:true,
    recording:records.map(entry=>entry.marker),centerAndRailMerge:true,groupPlus:true,lastTabCollapse:true,detachedAndDocked:true,close};
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
await writeFile('artifacts/windows-0.1.2-pane-groups.json',JSON.stringify(report,null,2)+'\n');
console.log('PASS physical pane tabs, nested geometry, input, recording and docking');
