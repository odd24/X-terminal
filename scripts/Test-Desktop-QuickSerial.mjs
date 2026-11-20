import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectDesktopPage, dragNativeWindow, launchDesktop, delay } from './lib/DesktopHarness.mjs';
const build=fixture=>{const r=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'ordinary service restoration/fixture build must actually succeed');};
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await delay(50);}throw new Error(`Timeout: ${label}`);};
let directory,saveDirectory,ui,detached;
try {
  build(true);
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-quick-serial-ui-中文-'));
  saveDirectory=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));await mkdir(path.join(saveDirectory,'UART日志'));
  ui=await launchDesktop(directory,{fixture:true,windowsHide:false});
  // A click is one action, after the actual visible control is enabled (including fieldsets).
  const click=async label=>{
    if(label==='串口连接')await ui.evaluate(`(()=>{const m=document.querySelector('.new-menu');if(m)m.open=true;})()`);
    if(label==='终端日志')await ui.evaluate(`document.querySelector('.tools-menu').open=true`);
    const lookup=`Array.from(document.querySelectorAll('button')).find(b=>(b.textContent===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})&&b.getClientRects().length>0&&!b.matches(':disabled'))`;await ui.waitFor(`!!(${lookup})`);assert.equal(await ui.evaluate(`(()=>{const b=${lookup};if(!b)return false;b.click();return true;})()`),true,`ready control clicked once: ${label}`);};
  const rpc=request=>ui.invoke('serial_request',{request});
  const config=()=>ui.invoke('config_request',{request:{op:'page',revision:null,offset:0,folders:false}});
  const show=async()=>{await click('串口连接');await ui.waitFor(`document.querySelector('[aria-label="UART端口"]')?.options.length===2`);};
  const choose=async()=>{await ui.fill('UART端口',await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').options[1].value`));};
  const connected=async()=>{await ui.waitFor(`!document.querySelector('dialog:modal')`);let c;await wait(async()=>{c=(await ui.invoke('service_list')).find(c=>c.state==='CONNECTED');return !!c;},'connected');return {connection_id:c.connection_id,generation:c.generation};};
  const end=async target=>{await rpc({op:'close',connection:target});await wait(async()=> (await rpc({op:'status',connection:target})).connection.state==='DISCONNECTED','closed');};
  const raw=async target=>(await ui.invoke('service_read',{connection:target,cursor:1})).events.flatMap(e=>e.bytes);
  const native=(action,target)=>new Promise((resolve,reject)=>{const p=spawn('pwsh',['-NoProfile','-File','scripts/lib/NativeSaveDialog.ps1','-TargetProcessId',String(ui.app.pid),'-Action',action,...(target?['-TargetPath',target]:[])],{windowsHide:true});let text='';p.stdout.on('data',d=>text+=d);p.stderr.on('data',d=>text+=d);p.on('error',reject);p.on('exit',c=>c===0?resolve(text):reject(new Error(text)));});
  await show();assert.equal((await config()).profiles.length,0);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="保存UART连接"]').checked`),false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').value`),'');
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="UART初始控制线"]').textContent.includes('DTR 低电平')`));
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="串口快速连接"]').textContent.includes('COM99')`));
  assert.equal(await ui.evaluate(`document.querySelector('dialog:modal').scrollWidth<=document.querySelector('dialog:modal').clientWidth`),true,'serial form must not overflow horizontally');
  await ui.screenshot('CR-022-S2-serial-form.png');
  await click('连接串口');await ui.waitFor(`document.querySelector('#uart-device-error')&&document.activeElement.getAttribute('aria-label')==='UART端口'`);
  await choose();await ui.fill('UART波特率',0);
  await click('连接串口');await ui.waitFor(`!!document.querySelector('#uart-baud-error')`);
  assert.equal((await ui.invoke('service_list')).length,0);
  await ui.fill('UART波特率',57600);
  const terminalWidth=await ui.evaluate(`document.querySelector('.terminal-workspace').getBoundingClientRect().width`);
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='通信参数与控制线').parentElement.open=true`);
  await ui.fill('UART流控','hardware');assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART初始RTS"]').disabled`),true);
  await ui.fill('UART流控','none');assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART初始RTS"]').value`),'false');
  const hold=await ui.interceptIpc({command:'serial_request',op:'quick_start',mode:'hold'});
  await ui.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='连接串口');b.click();b.click();})()`);
  await wait(async()=>await hold.count()===1,'one held start');assert.equal((await ui.invoke('service_list')).filter(c=>c.protocol==='SERIAL').length,1);
  await hold.release();const first=await connected();await hold.restore();
  assert.equal((await config()).profiles.length,0,'temporary serial must not persist a Profile');
  assert.equal(await ui.evaluate(`document.querySelector('.terminal-workspace').getBoundingClientRect().width`),terminalWidth,'connecting must not add a sidebar or shrink terminal columns');
  await wait(async()=>Buffer.from(await raw(first)).toString('utf8').includes('Android启动 log'),'passive receive without a send');
  await ui.waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);
  // Passive fixture rejects any attempted writes: initial receive/logging cannot rely on echo.
  await click('终端日志');await click('开始记录终端');
  let log;const logging=request=>ui.invoke('logging_request',{request});
  await wait(async()=>{log=(await logging({op:'list',connection:first})).logs.find(l=>l.active);return log?.phase==='RECORDING';},'recording');
  await wait(async()=> (await logging({op:'status',connection:first,log_id:log.log_id})).written_raw_bytes>100,'passive UART log written');
  await click('停止记录终端');await wait(async()=>{const l=await logging({op:'status',connection:first,log_id:log.log_id});return l.phase==='STOPPED'&&l.durable&&l.worker_finished;},'stopped and synced');
  await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='查看日志').disabled`);await click('查看日志');
  await ui.waitFor(`document.querySelector('[aria-label="本次日志文本"]')?.textContent.includes('Android启动 log')`);
  const output=path.join(saveDirectory,'UART日志','Android串口.log');await click('保存日志');console.log(await native('select',output));
  await ui.waitFor(`document.querySelector('[aria-label="文本导出另存状态"]')?.textContent.includes('日志已保存')`);
  const scope=JSON.parse(await ui.evaluate(`sessionStorage.getItem('terminal-text-log-task-v1')`));
  const receipt=await logging({op:'text_export_status',...scope}),saved=await readFile(output),managed=await readFile(path.join(directory,'terminal-log-exports',scope.request_id,'export.jsonl'));
  assert.deepEqual(saved,managed);assert.equal(createHash('sha256').update(saved).digest('hex'),receipt.sha256);assert.ok(saved.toString('utf8').includes('Android启动 log'));
  assert.equal((await rpc({op:'status',connection:first})).connection.state,'CONNECTED');await ui.screenshot('P10.1-passive-uart-log.png');
  // Occupied port is a visible rejection; it never closes the old session.
  await show();await choose();await click('连接串口');await ui.waitFor(`document.querySelector('[aria-label="串口快速连接"] [role="alert"]')?.textContent.includes('设备目录已变化')`);
  assert.equal((await rpc({op:'status',connection:first})).connection.state,'CONNECTED');await click('取消连接窗口');await end(first);
  // Unknown Start: query original number only, including after reload.
  await show();await choose();const lost=await ui.interceptIpc({command:'serial_request',op:'quick_start',mode:'error'});await click('连接串口');
  await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='查询串口连接结果')`);assert.equal(await lost.count(),1);await lost.restore();
  const original=await ui.evaluate(`sessionStorage.getItem('terminal-serial-start-v1')`);assert.ok(original);
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.dataset.serviceId`);await show();
  assert.equal(await ui.evaluate(`sessionStorage.getItem('terminal-serial-start-v1')`),original);
  await click('查询串口连接结果');const second=await connected();assert.notEqual(second.connection_id,first.connection_id);assert.equal((await ui.invoke('service_list')).length,2);await end(second);
  // Cancel while real Start reply is held: close only its eventual returned ref.
  await show();await choose();const late=await ui.interceptIpc({command:'serial_request',op:'quick_start',mode:'hold'});await click('连接串口');await wait(async()=>await late.count()===1,'late start held');await click('取消连接窗口');await late.release();
  await wait(async()=>{const list=await ui.invoke('service_list');return list.length===3&&list.every(c=>['DISCONNECTED','FAILED'].includes(c.state));},'cancelled late connection closed');await late.restore();
  await show();await choose();await ui.evaluate(`document.querySelector('[aria-label="保存UART连接"]').click()`);await click('连接串口');const third=await connected();assert.equal((await config()).profiles.length,1);await end(third);
  await show();await ui.fill('串口已保存连接',(await config()).profiles[0].id);await choose();await click('连接串口');const fourth=await connected();
  // Backend CONNECTED can precede the selected pane and its summary button.
  await ui.click('连接与服务详情');
  await ui.waitFor(`document.querySelector('[data-pane="first"]')?.dataset.renderedId===${JSON.stringify(fourth.connection_id)}&&document.querySelector('[data-pane="first"]').dataset.renderedGeneration==='${fourth.generation}'&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='发送与接收详情'&&!b.matches(':disabled'))`);
  assert.equal(await ui.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='发送与接收详情');if(!b||b.matches(':disabled')||!b.getClientRects().length)return false;b.click();return true;})()`),true,'the exact rendered target has a real details entry');
  await ui.waitFor(`document.querySelector('dialog:modal')?.getAttribute('aria-label')==='串口收发详情'&&document.querySelector('[aria-label="串口状态"]')?.textContent.includes(${JSON.stringify(fourth.connection_id)})`);
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='发送、HEX与控制线').parentElement.open=true`);
  await ui.fill('串口发送格式','hex');await ui.fill('串口发送换行','cr_lf');await ui.fill('串口发送内容','00 ff');await click('发送串口内容');
  await wait(async()=>Buffer.from(await raw(fourth)).equals(Buffer.from([0,255,13,10])),'exact hex and CRLF on new connection');
  // Echo can precede the receipt poll and enabled UI. Do not click a disabled send button.
  await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='发送串口内容'&&!b.matches(':disabled'))`);
  await ui.fill('串口发送格式','text');await ui.fill('串口发送换行','lf');await ui.fill('串口发送内容','串口通信');const sendObserved=await ui.interceptIpc({command:'serial_request',op:'send',mode:'delay',delayMs:0});await click('发送串口内容');await wait(async()=>await sendObserved.count()===1,'second text send actually dispatched once');assert.equal(await sendObserved.count(),1);await sendObserved.restore();
  const prior=Buffer.concat([Buffer.from([0,255,13,10]),Buffer.from('串口通信\n')]);
  await wait(async()=>Buffer.from(await raw(fourth)).equals(prior),'exact UTF8 text and LF');
  if(process.argv.includes('--window-interactions')){
    await click('关闭串口详情');
    await click('关闭连接与服务详情');
    const option=`document.querySelector('[role="tab"][data-connection-id="${fourth.connection_id}"]')`;
    const point=await ui.evaluate(`(()=>{const r=${option}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.command('Page.bringToFront');
    dragNativeWindow(ui.app,[point,{x:point.x-25,y:point.y+42},{x:60,y:140},{x:-35,y:180,outside:true}]);
    let target;
    await wait(async()=>{[target]=await ui.otherPages();return !!target;},'detached UART window');
    detached=await connectDesktopPage(target);
    await detached.waitFor(`document.querySelector('.pane-active')?.dataset.renderedId===${JSON.stringify(fourth.connection_id)} && document.activeElement?.matches('.xterm-helper-textarea')`);
    assert.deepEqual((await detached.invoke('service_list')).map(c=>({connection_id:c.connection_id,generation:c.generation})),[fourth]);
    await detached.command('Input.insertText',{text:'DETACHED-UART'});
    const expected=Buffer.concat([prior,Buffer.from('DETACHED-UART')]);
    await wait(async()=>Buffer.from((await detached.invoke('service_read',{connection:fourth,cursor:1})).events.flatMap(e=>e.bytes)).equals(expected),'detached input echoes on original UART');
    await detached.screenshot('desktop-detached-memory-uart.png');
    await detached.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='移回主窗口').click();true`);
    await wait(async()=>!(await ui.otherPages()).length,'return UART to main window');
    detached.close();detached=undefined;
    await ui.waitFor(`!!${option}`);
    assert.deepEqual(Buffer.from(await raw(fourth)),expected);
    assert.equal((await rpc({op:'status',connection:fourth})).connection.state,'CONNECTED');
    console.log('PASS actual drag-out and return for the exact in-memory UART generation');
    await end(fourth);
  } else {
    await end(fourth);
    await click('关闭串口详情');
  }
  await ui.screenshot('P10.1-serial-final.png');
  await writeFile('artifacts/P10.1-quick-serial-result.json',JSON.stringify({result:'PASS',first,second,third,fourth,bytes:saved.length,sha256:receipt.sha256,hardware:'memory backend only; no real COM opened'},null,2));
  console.log('PASS S2 native quick serial: optional save, passive UART receive/log/save, real IPC held/lost replies, one Start, original query/reload, cancel late close, occupied port, saved reuse; no real COM');
}catch(e){if(ui){await ui.screenshot('P10.1-serial-failure.png').catch(()=>{});await writeFile('artifacts/P10.1-serial-failure.txt',await ui.evaluate('document.body.innerText').catch(String));}throw e;
}finally{
  try {detached?.close();await ui?.close();for(const [dir,prefix] of [[directory,'shared-terminal-quick-serial-ui-中文-'],[saveDirectory,'shared-terminal-save-ui-中文-']])if(dir){const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith(prefix));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
  finally{build(false);}
}
