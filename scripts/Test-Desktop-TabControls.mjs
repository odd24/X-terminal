import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const fixtureHash=await hash(path.join(path.dirname(executable),'session-service.exe'));
assert.equal(fixtureHash,await hash('target/x86_64-pc-windows-msvc/debug/session-service.exe'),'use the separately built memory UART service');
const root=await mkdtemp(path.join(path.resolve(tmpdir()),'shared-terminal-tab-controls-中文-'));
const evidence={result:'IN_PROGRESS',executable,desktopSha256:await hash(executable),fixtureHash,measurements:[],checks:[],screenshots:[]};
let ui,peer,peerLines;
const q=JSON.stringify;
const query=css=>`document.querySelector(${q(css)})`;
const menu='.tree-new-menu';
const newConfig=menu+' > summary';
const refresh='.tree-heading-actions > button';
const tabs='[role=tab][data-connection-id]';
const button=id=>`.connection-tab:has([data-connection-id="${id}"]) > .tab-close-button`;
const cfg=request=>ui.invoke('config_request',{request});
const rpc=(command,request)=>ui.invoke(command,{request});
const ssh=request=>rpc('ssh_request',request);
const serial=request=>rpc('serial_request',request);
const ref=({connection_id,generation})=>({connection_id,generation});
const list=()=>ui.invoke('service_list');
const has=id=>`!!${query(`${tabs}[data-connection-id="${id}"]`)}`;
async function until(check,label){
  for(let n=0;n<160;n++){if(await check())return;await delay(50);}
  throw new Error('Timed out: '+label);
}
async function next(){
  let timer;
  try{return await Promise.race([peerLines.next().then(line=>JSON.parse(line.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSH fixture timeout')),7000);})]);}
  finally{clearTimeout(timer);}
}
async function key(key,code,vk){
  const text=key==='Enter'?'\r':key===' '?' ':undefined;
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,text});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});
}
async function tool(name){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function appearance(theme,palette){
  await tool('软件设置');
  await ui.waitFor(`!!${query('dialog:modal [aria-label="应用主题"]')}`);
  await ui.fill('应用主题',theme);
  await ui.fill('终端配色',palette);
  await ui.waitFor(`document.documentElement.dataset.theme===${q(theme)}&&document.documentElement.dataset.terminalPalette===${q(palette)}`);
  await ui.click('关闭软件设置');
  await ui.waitFor("!document.querySelector('dialog:modal')");
}
async function screenshot(name){
  await ui.screenshot(name);
  evidence.screenshots.push(name);
}
async function coords(css){
  return ui.evaluate(`(()=>{const r=${query(css)}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
const pointer=(type,point)=>ui.command('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});

async function measure(scale,theme,palette,id,selected){
  const node=(await ui.command('DOM.getDocument')).root.nodeId;
  const {nodeId}=await ui.command('DOM.querySelector',{nodeId:node,selector:button(id)});
  for(const [state,pseudos] of [['normal',[]],['hover',['hover']],['pressed',['hover','active']],['keyboard',['focus-visible']]]){
    await ui.command('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:pseudos});
    const measured=await ui.evaluate(`(()=>{
      const btn=${query(button(id))}, icon=btn.firstElementChild;
      const box=btn.getBoundingClientRect(), glyph=icon.getBoundingClientRect();
      const overlay=getComputedStyle(btn,'::before');
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const colors=element=>getComputedStyle(element).backgroundColor;
      const paint=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);};
      const pixel=()=>Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);
      const luminance=color=>color.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4)
        .reduce((value,n,index)=>value+n*[.2126,.7152,.0722][index],0);
      paint(colors(btn.closest('.pane-tab-bar')));paint(colors(btn.parentElement));paint(colors(btn));
      const tabBackground=pixel();paint(overlay.backgroundColor);
      const background=pixel();paint(getComputedStyle(icon).color);const ink=pixel();
      const small=Math.min(luminance(background),luminance(ink)),big=Math.max(luminance(background),luminance(ink));
      return {width:box.width,height:box.height,offsetX:glyph.x+glyph.width/2-box.x-box.width/2,
        offsetY:glyph.y+glyph.height/2-box.y-box.height/2,stroke:getComputedStyle(icon.firstElementChild).stroke,
        contrast:(big+.05)/(small+.05),tabBackground,background,ink,ring:overlay.outlineStyle,radius:overlay.borderRadius,
        selected:btn.parentElement.querySelector('[role=tab]').ariaSelected==='true'};
    })()`);
    assert.equal(measured.selected,selected);
    assert.ok(measured.width>=24&&measured.height>=24,JSON.stringify(measured));
    assert.ok(Math.abs(measured.offsetX)<.6&&Math.abs(measured.offsetY)<.6);
    assert.notEqual(measured.stroke,'none');
    assert.ok(measured.contrast>=3,`${theme}/${palette}/${scale}/${state}: ${JSON.stringify(measured)}`);
    if(state==='hover'||state==='pressed')assert.notDeepEqual(measured.background,measured.tabBackground);
    assert.equal(measured.radius,'6px');
    if(state==='keyboard')assert.equal(measured.ring,'solid');
    evidence.measurements.push({scale,theme,palette,id,selected,state,...measured});
    if(state==='hover'&&selected&&theme==='light'&&palette==='black_white'&&scale===1)
      await screenshot('windows-0.1.24-tab-close-hover.png');
    if(state==='keyboard'&&selected&&theme==='dark'&&palette==='x'&&scale===1.5)
      await screenshot('windows-0.1.24-tab-close-dark-150.png');
  }
  await ui.command('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:[]});
}

try{
  peer=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  peerLines=createInterface({input:peer.stdout})[Symbol.asyncIterator]();
  const server=await next();
  ui=await launchDesktop(root,{executable,fixture:true});
  const inventory=await serial({op:'inventory'});
  assert.equal(inventory.result,'inventory');
  assert.deepEqual(inventory.devices.map(device=>[device.port,device.instance_id]),[['COM7','SYNTHETIC-TEST-INSTANCE']]);
  const save=async(name,settings)=>{
    const profile={id:crypto.randomUUID(),folder_id:null,name,settings};
    assert.equal((await cfg({op:'save_profile',profile,credential:{action:'clear'}})).result,'saved_profile');
    return profile;
  };
  const sshProfile=await save('回环 SSH',{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'});
  const a=ref((await ssh({op:'start',profile_id:sshProfile.id,request_id:requestId(),cols:80,rows:24})).connection);
  const seen=new Set();
  await until(async()=>{
    const status=await ssh({op:'status',connection:a}), challenge=status.challenge;
    assert.notEqual(status.connection.state,'FAILED');
    if(challenge&&!seen.has(challenge.id)){
      seen.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,server.pin);
        await ssh({op:'answer_host',connection:a,challenge_id:challenge.id,approve:true});
      }else if(challenge.kind==='credentials'){
        await ssh({op:'authenticate',connection:a,challenge_id:challenge.id,use_saved:false,password:server.password});
      }
    }
    return status.connection.state==='CONNECTED';
  },'loopback SSH connected');
  const serialProfile=await save('内存 UART',{protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8'});
  const b=ref((await serial({op:'start',profile_id:serialProfile.id,request_id:requestId(),revision:inventory.revision,device_id:inventory.devices[0].device_id})).connection);
  await until(async()=>(await list()).some(c=>c.connection_id===b.connection_id&&c.state==='CONNECTED'),'memory UART connected');
  await tool('轻量命令行');
  await ui.waitFor(`!!${query('.pane-active .local-terminal:not([hidden])')}&&${has(a.connection_id)}&&${has(b.connection_id)}`);
  const localId=await ui.evaluate(`${query(tabs+'[aria-selected=true]')}.dataset.connectionId`);
  evidence.nativeDevicePixelRatio=await ui.evaluate('devicePixelRatio');
  evidence.dynamicContrast=await ui.evaluate("CSS.supports('color','contrast-color(black)')");
  await ui.command('DOM.enable');
  await ui.command('CSS.enable');
  for(const scale of [1,1.5]){
    await ui.command('Emulation.setDeviceMetricsOverride',{width:1000,height:710,deviceScaleFactor:scale,mobile:false});
    await ui.waitFor(`devicePixelRatio===${scale}`);
    const geometry=await ui.evaluate(`[...${query('.tree-heading-actions')}.querySelectorAll('.icon-button')].map(control=>{
      const rect=control.getBoundingClientRect(),svg=control.firstElementChild.getBoundingClientRect(),ink=control.querySelector('path').getBBox();
      return [rect.x,rect.y,rect.width,rect.height,svg.x+svg.width/2,svg.y+svg.height/2,ink.x+ink.width/2,ink.y+ink.height/2];
    })`);
    assert.equal(geometry.length,2);
    for(const [index,g] of geometry.entries()){
      assert.deepEqual(g.slice(2,4),[28,28]);
      assert.ok(Math.abs(g[4]-g[0]-14)<.5&&Math.abs(g[5]-g[1]-14)<.5);
      assert.ok(Math.abs(g[6]-8)<.6&&Math.abs(g[7]-8)<.6,`optical center ${index}: ${g}`);
    }
    assert.ok(geometry[0][0]<geometry[1][0]&&Math.abs(geometry[0][1]-geometry[1][1])<.25);
    evidence.measurements.push({scale,geometry});
    if(scale===1)await screenshot('windows-0.1.24-sidebar-controls.png');
    for(const [theme,palette] of [['light','follow_theme'],['dark','follow_theme'],['light','black_white'],['dark','x'],['light','black_green']]){
      await appearance(theme,palette);
      const selected=scale===1&&palette==='black_white'?a.connection_id
        :scale===1.5&&palette==='x'?b.connection_id:localId;
      await ui.selectTab(selected);
      await ui.waitFor(`${query(`${tabs}[data-connection-id="${selected}"]`)}.ariaSelected==='true'`);
      for(const id of [a.connection_id,b.connection_id,localId])
        await measure(scale,theme,palette,id,id===selected);
    }
    await ui.selectTab(a.connection_id);
    await ui.waitFor(`${query(`${tabs}[data-connection-id="${a.connection_id}"]`)}.ariaSelected==='true'`);
    await measure(scale,'light','black_green',a.connection_id,true);
    await ui.selectTab(b.connection_id);
    await ui.waitFor(`${query(`${tabs}[data-connection-id="${b.connection_id}"]`)}.ariaSelected==='true'`);
    await measure(scale,'light','black_green',b.connection_id,true);
    await ui.selectTab(localId);
  }
  await ui.command('Emulation.clearDeviceMetricsOverride');
  evidence.checks.push('28x28 sidebar targets and centered SVG at 100% and 150%; close targets, strokes, contrast and focus ring across five theme/palette combinations');

  await ui.evaluate(`${query(newConfig)}.click()`);
  await ui.waitFor(`${query(menu)}.open&&!!${query(menu+' [data-positioned]')}`);
  await ui.evaluate(`${query(newConfig)}.focus()`);
  await key('Escape','Escape',27);
  await ui.waitFor(`!${query(menu)}.open&&document.activeElement===${query(newConfig)}`);
  const refreshed=await save('等待刷新',{...sshProfile.settings});
  await ui.evaluate(`${query(refresh)}.click()`);
  await ui.waitFor(`!!${query(`[data-profile-id="${refreshed.id}"]`)}`);
  const start=await coords(button(a.connection_id));
  const outside=await coords('.pane-active .local-pane-body');
  await pointer('mousePressed',start);
  try{
    await pointer('mouseMoved',outside);
    assert.equal(await ui.evaluate("!!document.querySelector('[data-drag-source],.tab-split-preview')"),false);
  }finally{await pointer('mouseReleased',outside);}
  assert.equal(await ui.evaluate(has(a.connection_id)),true);
  await pointer('mousePressed',start);await pointer('mouseReleased',start);
  await ui.waitFor(`!${has(a.connection_id)}&&${has(b.connection_id)}&&${has(localId)}`);
  await until(async()=>(await list()).some(c=>c.connection_id===a.connection_id&&c.state==='DISCONNECTED'),'exact SSH closed');
  await key('Tab','Tab',9);
  await ui.evaluate(`${query(button(b.connection_id))}.focus()`);
  assert.equal(await ui.evaluate(`${query(button(b.connection_id))}.matches(':focus-visible')`),true);
  await key('Enter','Enter',13);
  await ui.waitFor(`!${has(b.connection_id)}&&${has(localId)}`);
  await until(async()=>(await list()).some(c=>c.connection_id===b.connection_id&&c.state==='DISCONNECTED'),'exact UART closed');
  await ui.evaluate(`${query(button(localId))}.click()`);
  await ui.waitFor(`!${has(localId)}`);
  evidence.checks.push('sidebar menu Escape and focus, refresh imports only the expected row, close hit does not start drag, exact SSH/UART/local closure');
  await tool('退出桌面');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  evidence.result='PASS';
  console.log('PASS Windows tab and sidebar icons, geometry, contrast, refresh and exact close');
}catch(error){
  evidence.result='FAIL';evidence.error=String(error.stack);
  await ui?.screenshot('windows-0.1.24-tab-controls-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(peer&&peer.exitCode===null){const ended=new Promise(resolve=>peer.once('exit',resolve));peer.stdin.end();await ended;}
  await writeFile('artifacts/windows-0.1.24-tab-controls-result.json',JSON.stringify(evidence,null,2)+'\n');
  assert.equal(path.dirname(root),path.resolve(tmpdir()));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
