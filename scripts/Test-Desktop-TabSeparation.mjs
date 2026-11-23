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
const baseline=process.argv.includes('--baseline');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-tab-separation-中文-'));
const evidence={result:'IN_PROGRESS',executable,baseline,
  sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),measurements:[],screenshots:[],checks:[]};
const q=JSON.stringify;
const node=css=>`document.querySelector(${q(css)})`;
const tab=id=>`[role="tab"][data-connection-id="${id}"]`;
const wrapper=id=>`.connection-tab:has(> ${tab(id)})`;
const close=id=>wrapper(id)+' > .tab-close-button';
const record=id=>wrapper(id)+' > .tab-record-button';
const rail='.pane-active [role=tablist]';
const plus='.pane-active .new-menu > summary';
const localBody='.pane-active .local-pane-body:not([hidden])';
const localOutput=localBody+' .local-terminal:not([hidden]) .local-terminal-output';
const localInput=localBody+' .local-terminal:not([hidden]) .xterm-helper-textarea';
const remoteInput='.pane-active > .terminal:not([hidden]) .xterm-helper-textarea';
let ui,peer,lines;

const wait=expression=>ui.waitFor(expression);
const selected=()=>ui.evaluate("document.querySelector('.pane-active [role=tab][aria-selected=true]')?.dataset.connectionId");
const ssh=request=>ui.invoke('ssh_request',{request});
const list=()=>ui.invoke('service_list');
const point=(css,x=.5,y=.5)=>ui.evaluate(`(()=>{const r=${node(css)}.getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`);
const mouse=(type,p)=>ui.command('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
const move=p=>ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
async function click(css){
  const p=await point(css);
  assert.equal(await ui.evaluate(`${node(css)}.contains(document.elementFromPoint(${p.x},${p.y}))`),true,css);
  await mouse('mousePressed',p);await mouse('mouseReleased',p);
}
async function key(key){
  const code={Tab:9,Escape:27,ArrowDown:40}[key];
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:code});
}
async function tool(label){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(label);
}
async function appearance(theme,palette='black_white'){
  await tool('软件设置');
  await wait("!!document.querySelector('dialog:modal [aria-label=\"应用主题\"]')");
  await ui.fill('应用主题',theme);
  await ui.fill('终端配色',palette);
  await wait(`document.documentElement.dataset.theme===${q(theme)}&&document.documentElement.dataset.terminalPalette===${q(palette)}`);
  await ui.click('关闭软件设置');
}
async function screenshot(suffix){
  const file=`windows-0.1.27-tabs-${suffix}.png`;
  await ui.screenshot(file);evidence.screenshots.push(file);
}
async function until(read,label){
  for(let i=0;i<160;i++){const value=await read();if(value)return value;await delay(50);}
  assert.fail('Timed out: '+label);
}
async function next(){
  let timer;
  try{return await Promise.race([lines.next().then(entry=>JSON.parse(entry.value)),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('Loopback peer timeout')),8000);
  })]);}finally{clearTimeout(timer);}
}
async function connect(server,profileId){
  const created=await ssh({op:'start',profile_id:profileId,request_id:requestId(),cols:96,rows:30});
  const target={connection_id:created.connection.connection_id,generation:created.connection.generation};
  const answered=new Set();
  await until(async()=>{
    const status=await ssh({op:'status',connection:target}), challenge=status.challenge;
    assert.notEqual(status.connection.state,'FAILED');
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,server.pin);
        await ssh({op:'answer_host',connection:target,challenge_id:challenge.id,approve:true});
      }else await ssh({op:'authenticate',connection:target,challenge_id:challenge.id,use_saved:true,password:null});
    }
    return status.connection.state==='CONNECTED';
  },'exact SSH login');
  return target;
}
async function openLocal(name){
  await tool('轻量命令行');await wait(`${node(rail+' [aria-selected=true]')}?.textContent===${q(name)}&&document.activeElement===${node(localInput)}`);
  return selected();
}
async function readTabs(stage){
  const result=await ui.evaluate(`(()=>{
    const rail=${node(rail)},canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const terminal=rail.closest('[data-pane]').querySelector(':scope > .terminal:not([hidden]), .local-terminal:not([hidden]) .local-terminal-output');
    const strip=getComputedStyle(rail.parentElement),railColor=strip.backgroundColor;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const paint=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);};
    const rgb=(text,base=railColor)=>{ctx.clearRect(0,0,1,1);paint(base);paint(text);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
    const relative=tuple=>tuple.map(n=>n/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
      .reduce((sum,v,index)=>sum+v*[.2126,.7152,.0722][index],0);
    return {stage:${q(stage)},viewport:[innerWidth,innerHeight,devicePixelRatio],gap:getComputedStyle(rail).columnGap,
      railBackground:railColor,stripHeight:rail.parentElement.getBoundingClientRect().height,
      terminalBackground:getComputedStyle(terminal).backgroundColor,terminalTop:terminal.getBoundingClientRect().top,
      tabs:[...rail.querySelectorAll('.connection-tab')].map(box=>{
        const label=box.querySelector('[role=tab]'),ending=box.querySelector('.tab-close-button');
        const c=box.getBoundingClientRect(),x=ending.getBoundingClientRect(),style=getComputedStyle(box);
        const title=getComputedStyle(label),divider=getComputedStyle(box,'::before');
        const background=relative(rgb(style.backgroundColor)),ink=relative(rgb(getComputedStyle(ending).color));
        const titleInk=relative(rgb(title.color)),dividerInk=relative(rgb(divider.backgroundColor,railColor));
        const contrast=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        return {id:label.dataset.connectionId,label:label.textContent,selected:label.ariaSelected==='true',
          background:style.backgroundColor,outline:style.boxShadow,topRadius:style.borderTopLeftRadius,bottomRadius:style.borderBottomLeftRadius,
          divider:divider.content==='none'?null:{height:divider.height,width:divider.width,contrast:contrast(background,dividerInk),position:divider.right},
          rect:[c.left,c.right,c.height,c.bottom],closeWidth:x.width,closeHeight:x.height,inBounds:x.left>=c.left&&x.right<=c.right,
          closeContrast:contrast(background,ink),titleContrast:contrast(background,titleInk),weight:Number(title.fontWeight),
          record:box.querySelector('.tab-record-button')?.dataset.recording};
      })};
  })()`);
  evidence.measurements.push(result);
  return result;
}
function compare(stage,measurement,split=false){
  const {tabs,gap,terminalBackground,terminalTop,stripHeight}=measurement;
  assert.equal(gap,'2px',stage);
  assert.equal(stripHeight,split?32:42,stage+' strip height');
  assert.equal(tabs.filter(tab=>tab.selected).length,1);
  const selected=tabs.find(tab=>tab.selected);
  assert.equal(selected.background,terminalBackground,stage+' terminal fill');
  assert.ok(Math.abs(selected.rect[3]-terminalTop)<.1,stage+' bottom seam');
  assert.equal(selected.divider,null,stage+' separator skipped for selected tab');
  assert.equal(selected.topRadius,'8px',stage);
  assert.equal(selected.bottomRadius,'0px',stage);
  assert.ok(selected.weight>=550,stage+' active title weight');
  assert.ok(tabs.every(tab=>tab.outline==='none'&&tab.titleContrast>=4.5),stage+' box-free and legible labels');
  assert.ok(tabs.filter(tab=>!tab.selected).every(tab=>tab.background==='rgba(0, 0, 0, 0)'&&tab.divider?.height==='14px'
    &&tab.divider.width==='1px'&&tab.divider.position==='0px'&&tab.divider.contrast>1.2),stage+' flat inactive faces and short visible separators');
  assert.ok(tabs.every(tab=>tab.inBounds&&tab.closeWidth===26&&tab.closeHeight>=26&&tab.closeContrast>=3),stage+' exact close bounds and contrast');
  for(let i=1;i<tabs.length;i++)assert.ok(tabs[i].rect[0]-tabs[i-1].rect[1]>=1.9,stage+' adjacent gap');
}
async function stop(){
  await ui.command('Emulation.clearDeviceMetricsOverride');
  await tool('退出桌面');await wait("!!document.querySelector('dialog[aria-label=\"退出桌面确认\"]')");
  await ui.click('确认退出并停止服务');
  await until(()=>ui.app.exitCode!==null,'managed exit');
  assert.equal(ui.app.exitCode,0);
}

try{
  peer=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  lines=createInterface({input:peer.stdout})[Symbol.asyncIterator]();
  const server=await next(),profileId=randomUUID();
  ui=await launchDesktop(root,{executable});
  evidence.nativeDpr=await ui.evaluate('devicePixelRatio');
  assert.equal((await ui.invoke('service_status')).fixture,false);
  await ui.command('Emulation.setDeviceMetricsOverride',{width:1100,height:700,deviceScaleFactor:1,mobile:false});
  await appearance('light');
  await ui.invoke('config_request',{request:{op:'save_profile',profile:{id:profileId,folder_id:null,name:'同地址回环样本',settings:{
    protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8',
  }},credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
  const a=await connect(server,profileId);
  peer.stdin.write(JSON.stringify({op:'push',text:'\x1b[32m\r\nWelcome to the loopback SSH fixture\r\n\r\noperator@loopback:~$ \x1b[0m'})+'\n');
  await next();
  const b=await connect(server,profileId);
  const one=await openLocal('本地 1'),two=await openLocal('本地 2');
  await wait(`!!${node(tab(a.connection_id))}&&!!${node(tab(b.connection_id))}`);
  await wait(`${node(record(a.connection_id))}?.dataset.recording==='idle'&&${node(record(b.connection_id))}?.dataset.recording==='idle'`);
  if(await ui.evaluate("document.querySelector('.pane-active .adb-panel-toggle')?.getAttribute('aria-expanded')==='true'"))await ui.click('快捷指令');
  if(await ui.evaluate(`${node(rail+' [role=tab]')}.dataset.connectionId`)!==a.connection_id){
    const before=await point(tab(b.connection_id),.16);
    await mouse('mousePressed',await point(tab(a.connection_id)));
    await mouse('mouseMoved',before);
    await wait(`${node(wrapper(b.connection_id))}.dataset.insertion==='before'`);
    await mouse('mouseReleased',before);
  }
  await click(tab(a.connection_id));
  await wait(`document.querySelector('.pane-active').dataset.renderedId===${q(a.connection_id)}`);
  await wait("document.querySelector('.pane-active .xterm-rows').textContent.includes('operator@loopback:')");
  await ui.evaluate(`${node(remoteInput)}.focus()`);
  await move({x:12,y:300});
  const light=await readTabs('light mixed');
  assert.deepEqual(light.tabs.map(t=>t.label),['127.0.0.1','127.0.0.1','本地 1','本地 2']);
  assert.deepEqual(light.tabs.map(t=>t.id),[a.connection_id,b.connection_id,one,two]);
  if(baseline){
    assert.equal(light.gap,'4px');
    assert.ok(light.tabs.every(t=>t.outline!=='none'&&t.divider===null));
    await screenshot('00-baseline-0.1.26-light');
  }else{
    compare('light mixed',light);
    await screenshot('01-A-light-mixed');
    await appearance('light','follow_theme');
    await ui.evaluate(`${node(remoteInput)}.focus()`);
    const white=await readTabs('light terminal follows theme');
    compare('light terminal follows theme',white);
    assert.notEqual(white.terminalBackground,light.terminalBackground);
    await screenshot('02-A-light-terminal');
    await appearance('light');
    const inactive=tab(b.connection_id);
    const resting=light.tabs.find(t=>t.id===b.connection_id).background;
    await move(await point(inactive));await wait(`getComputedStyle(${node(wrapper(b.connection_id))}).backgroundColor!==${q(resting)}`);
    assert.equal(await selected(),a.connection_id);
    await key('Tab');
    await ui.evaluate(`${node(close(b.connection_id))}.focus()`);
    await wait(`${node(close(b.connection_id))}.matches(':focus-visible')&&getComputedStyle(${node(close(b.connection_id))},'::before').outlineStyle==='solid'`);
    await screenshot('03-A-light-close-focus');

    await click(tab(one));await wait(`document.activeElement===${node(localInput)}`);
    await ui.command('Input.insertText',{text:'LOCAL_TAB_DRAFT'});
    await wait(`${node(localOutput)}.innerText.includes('LOCAL_TAB_DRAFT')`);
    await ui.evaluate(`window.oldLocal=${node(localOutput)}.querySelector('.xterm')`);
    await appearance('dark');
    await wait(`${node(record(b.connection_id))}?.getAttribute('aria-disabled')==='false'`);
    await click(record(b.connection_id));
    await wait(`${node(record(b.connection_id))}.dataset.recording==='recording'`);
    assert.equal(await selected(),one);
    assert.notEqual(await ui.evaluate(`${node(record(a.connection_id))}.dataset.recording`),'recording');
    const ink=await ui.evaluate(`getComputedStyle(${node(record(b.connection_id))}).color`);
    await click(tab(b.connection_id));await wait(`${node(tab(b.connection_id))}.ariaSelected==='true'`);
    assert.equal(await ui.evaluate(`getComputedStyle(${node(record(b.connection_id))}).color`),ink);
    assert.notEqual(ink,await ui.evaluate(`getComputedStyle(${node(tab(b.connection_id))}).color`));
    await click(tab(one));await wait(`${node(tab(one))}.ariaSelected==='true'`);
    await move({x:12,y:310});
    await screenshot('04-A-dark-with-recording');
    compare('dark mixed',await readTabs('dark mixed with exact recording'));
    await click(record(b.connection_id));
    await wait(`${node(record(b.connection_id))}.dataset.recording==='idle'`);
    const dismiss='.recording-notice button[aria-label="关闭通知"]';
    await wait(`!!${node(dismiss)}`);
    await click(dismiss);
    await click(plus);
    await wait(`${node(rail+' [aria-selected=true]')}?.textContent==='本地 3'`);
    assert.equal(await ui.evaluate("document.querySelectorAll('[role=tab]').length"),5);
    const three=await selected();
    const destination=await point(localBody,.86);
    await mouse('mousePressed',await point(tab(three)));await mouse('mouseMoved',destination);
    await wait("!!document.querySelector('.tab-split-preview[data-edge=right]')");
    await mouse('mouseReleased',destination);
    await wait("document.querySelectorAll('[data-pane]').length===2");
    await ui.evaluate(`${node(tab(one))}.scrollIntoView({block:'nearest',inline:'nearest'})`);
    await click(tab(one));
    await wait(`document.querySelector('.pane-active [role=tab][aria-selected=true]').dataset.connectionId===${q(one)}`);
    assert.equal(await ui.evaluate(`${node(localOutput)}.querySelector('.xterm')===window.oldLocal&&${node(localOutput)}.innerText.includes('LOCAL_TAB_DRAFT')`),true);
    await move({x:12,y:310});
    compare('dark wide split',await readTabs('dark wide split'),true);
    await screenshot('05-A-dark-wide-split');
    await ui.command('Emulation.setDeviceMetricsOverride',{width:720,height:480,deviceScaleFactor:1.5,mobile:false});
    await wait(`devicePixelRatio===1.5&&innerWidth===720&&${node(rail)}.scrollWidth>${node(rail)}.clientWidth`);
    await ui.evaluate(`${node(tab(one))}.scrollIntoView({block:'nearest',inline:'nearest'})`);
    await move({x:12,y:310});
    compare('dark narrow split',await readTabs('dark narrow split 150%'),true);
    await screenshot('06-A-dark-narrow-split-150');
    await ui.evaluate(`${node(rail)}.scrollLeft=0`);
    const wheel=await point(rail,.40);
    await ui.command('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel,deltaX:0,deltaY:420});
    await wait(`${node(rail)}.scrollLeft>0`);
    if(await ui.evaluate("document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')==='true'"))await click('.sidebar-toggle');
    await ui.selectTab(a.connection_id);
    await wait(`${node(tab(a.connection_id))}.ariaSelected==='true'`);
    await ui.evaluate(`${node(rail)}.scrollLeft=0`);
    await move({x:12,y:310});
    await screenshot('07-A-dark-narrow-same-address-150');
    await ui.evaluate(`${node(close(b.connection_id))}.scrollIntoView({block:'nearest',inline:'nearest'})`);
    await click(close(b.connection_id));
    await wait(`!${node(tab(b.connection_id))}&&!!${node(tab(a.connection_id))}&&!!${node(tab(one))}&&!!${node(tab(two))}`);
    await until(async()=>(await list()).some(c=>c.connection_id===b.connection_id&&c.state==='DISCONNECTED'),'clicked SSH disconnected');
    assert.ok((await list()).some(c=>c.connection_id===a.connection_id&&c.state==='CONNECTED'));
    await ui.evaluate(`${node(plus)}.focus()`);await key('ArrowDown');
    await wait("!!document.querySelector('.pane-active .new-menu .app-menu[data-positioned]')");
    await key('Escape');await wait(`document.activeElement===${node(plus)}&&!${node('.pane-active .new-menu')}.open`);
    evidence.checks.push('two identical frozen SSH labels and two local labels; A-style continuous black and light terminal seam, no top line, short inactive dividers; exact recording and close, keyboard focus, cross-pane drag, wheel overflow, preserved draft and pane add controls');
  }
  await stop();
  evidence.result='PASS';
  console.log(baseline?'PASS reproduced framed tabs from 0.1.26':'PASS A-style tab seam and separators, mixed exact actions, and both split widths');
}catch(error){
  evidence.result='FAIL';evidence.error=String(error.stack);
  if(ui)await screenshot('failure').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(peer&&peer.exitCode===null&&peer.signalCode===null){const ended=new Promise(resolve=>peer.once('exit',resolve));peer.kill();await ended;}
  await writeFile(`artifacts/windows-0.1.27-tabs-${baseline?'baseline':'result'}.json`,JSON.stringify(evidence,null,2)+'\n');
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
