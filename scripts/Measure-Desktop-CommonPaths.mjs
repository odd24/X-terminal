import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const memoryUart=process.argv.includes('--memory-uart');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-paths-中文-'));
const result={result:'IN_PROGRESS',executable,memoryUart,configPageMs:[],sshEchoMs:[],logStartMs:[],logStopDurableMs:[],adbShortcutMs:[],uartEchoMs:[]};
const q=JSON.stringify;
const ref=({connection_id,generation})=>({connection_id,generation});
let ui,server;
const invoke=(command,request)=>ui.invoke(command,{request});
const ssh=request=>invoke('ssh_request',request);
const config=request=>invoke('config_request',request);
const logs=(connection,request)=>invoke('logging_request',{connection:ref(connection),...request});
async function until(check){
  const end=performance.now()+10000;
  while(performance.now()<end){const value=await check();if(value)return value;await delay(8);}
  throw Error('Path condition timed out');
}
async function timed(samples,action){
  const start=performance.now(),value=await action();
  samples.push(performance.now()-start);
  return value;
}
async function tool(name){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function activate(connection){
  await ui.command('Page.bringToFront');
  const selector=`[role="tab"][data-connection-id="${connection.connection_id}"]`;
  await until(()=>ui.evaluate(`!!document.querySelector(${q(selector)})`));
  await ui.selectTab(connection.connection_id);
  await until(()=>ui.evaluate(`document.querySelector('.pane-active')?.dataset.renderedId===${q(connection.connection_id)}&&document.querySelector('footer')?.textContent.includes('输入就绪')`));
  await ui.evaluate("document.querySelector('.pane-active .xterm-helper-textarea').focus()");
  await until(()=>ui.evaluate("document.activeElement?.matches('.pane-active .xterm-helper-textarea')"));
}
async function echo(connection,prefix,samples){
  await activate(connection);
  const ready=prefix+'_READY_';
  await ui.command('Input.insertText',{text:ready});
  await until(()=>ui.evaluate(`document.querySelector('.pane-active .terminal')?.textContent.includes(${q(ready)})`));
  for(let n=0;n<12;n++){
    const marker=`${prefix}_${String(n).padStart(2,'0')}_`;
    await timed(samples,async()=>{
      await ui.command('Input.insertText',{text:marker});
      await until(()=>ui.evaluate(`document.querySelector('.pane-active .terminal')?.textContent.includes(${q(marker)})`));
    });
  }
  const page=await ui.invoke('service_read',{connection:ref(connection),cursor:1});
  assert.ok(!page.truncated&&!page.events.some(event=>event.gap_bytes));
  const raw=Buffer.from(page.events.flatMap(event=>event.bytes)).toString();
  const expected=Array.from({length:12},(_,n)=>`${prefix}_${String(n).padStart(2,'0')}_`);
  assert.deepEqual([...raw.matchAll(new RegExp(prefix+'_\\d{2}_','g'))].map(m=>m[0]),expected);
}

async function measureMemoryUart(){
  ui=await launchDesktop(root,{executable,fixture:true});
  assert.equal((await ui.invoke('service_status')).fixture,true);
  const serial=request=>invoke('serial_request',request);
  const available=await serial({op:'inventory'});
  assert.deepEqual(available.devices.map(({port,instance_id})=>[port,instance_id]),[['COM7','SYNTHETIC-TEST-INSTANCE']]);
  assert.deepEqual(available.unidentified_ports,['COM99']);
  const settings={protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8'};
  const {connection:uart}=await serial({op:'quick_start',settings,request_id:crypto.randomUUID(),revision:available.revision,device_id:available.devices[0].device_id});
  await until(async()=> (await serial({op:'status',connection:ref(uart)})).connection.state==='CONNECTED');
  await echo(uart,'PERFUART',result.uartEchoMs);
}

async function measureCommonPaths(){
  const sshRoot=path.join(root,'ssh');await mkdir(sshRoot);
  server=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[sshRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:server.stdout})[Symbol.asyncIterator]();
  const next=async()=>{
    let timer;
    try{return JSON.parse((await Promise.race([lines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned SSH fixture did not respond')),8000);})])).value);}
    finally{clearTimeout(timer);}
  };
  const fixture=await next();
  const fixtureControl=async op=>{server.stdin.write(JSON.stringify(op)+'\n');return next();};
  await fixtureControl({op:'keyboard_echo'});
  const adb=path.join(root,'adb.exe'),inventory=path.join(root,'inventory.txt');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true});
  await writeFile(path.join(root,'fixture-root.txt'),root);
  await writeFile(inventory,'mock  device product:synthetic\n');
  ui=await launchDesktop(root,{executable});
  assert.equal((await ui.invoke('service_status')).fixture,false);
  const profile={id:crypto.randomUUID(),folder_id:null,name:'性能合成配置',settings:{protocol:'ssh2',
    host:'127.0.0.1',port:fixture.port,username:'synthetic',auth:'password',encoding:'utf8'}};
  const credential={action:'replace',value:{password:fixture.password,private_key:null,passphrase:null}};
  const start=performance.now();
  assert.equal((await config({op:'save_profile',profile,credential})).result,'saved_profile');
  result.configSaveMs=performance.now()-start;
  for(let i=0;i<12;i++)await timed(result.configPageMs,async()=>{
    const reply=await config({op:'page',revision:null,offset:0,folders:false});
    assert.equal(reply.profiles[0].id,profile.id);
    assert.ok(!JSON.stringify(reply).includes(fixture.password));
  });
  const startConnect=performance.now();
  const {connection}=await ssh({op:'start',profile_id:profile.id,request_id:crypto.randomUUID(),cols:80,rows:24});
  const answered=new Set();
  await until(async()=>{
    const state=await ssh({op:'status',connection:ref(connection)});
    assert.notEqual(state.connection.state,'FAILED');
    const challenge=state.challenge;
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,fixture.pin);
        await ssh({op:'answer_host',connection:ref(connection),challenge_id:challenge.id,approve:true});
      }else{
        assert.equal(challenge.kind,'credentials');
        await ssh({op:'authenticate',connection:ref(connection),challenge_id:challenge.id,use_saved:true,password:null});
      }
    }
    return state.connection.state==='CONNECTED';
  });
  result.sshHandshakeMs=performance.now()-startConnect;
  await echo(connection,'PERFSSH',result.sshEchoMs);
  for(let i=0;i<5;i++){
    const log=await timed(result.logStartMs,()=>logs(connection,{op:'start',request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}}));
    const marker=`PERFLOG_${i}_TAIL`;
    await fixtureControl({op:'push',text:marker+'\r\n'});
    await until(()=>ui.evaluate(`document.querySelector('.pane-active .terminal')?.textContent.includes(${q(marker)})`));
    const stopped=await timed(result.logStopDurableMs,async()=>{
      await logs(connection,{op:'stop',log_id:log.log_id});
      return until(async()=>{
        const state=await logs(connection,{op:'status',log_id:log.log_id});
        return state.durable&&state.worker_finished&&!state.active&&state;
      });
    });
    assert.equal(stopped.source_gap_bytes,0);
    assert.equal(stopped.rejected_raw_bytes,0);
    assert.match(await readFile(path.join(root,'logs',stopped.readable.filename),'utf8'),new RegExp(marker));
  }
  const shortcut={id:crypto.randomUUID(),name:'性能模拟 ADB',command:'adb devices -l'};
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts:[shortcut]}});
  await tool('轻量命令行');
  await until(()=>ui.evaluate("document.activeElement?.matches('.local-terminal:not([hidden]) .xterm-helper-textarea')"));
  if(!await ui.evaluate("!!document.querySelector('.adb-shortcut-panel:not([hidden])')"))await ui.click('快捷指令');
  await until(()=>ui.evaluate("!!document.querySelector('.adb-shortcut-run[aria-label=\"性能模拟 ADB\"]')"));
  for(let i=0;i<10;i++){
    const target=`FAKEDEVICE_${i}_`;
    await writeFile(inventory,`${target}  device product:synthetic\n`);
    await timed(result.adbShortcutMs,async()=>{
      await ui.click(shortcut.name);
      await until(()=>ui.evaluate(`document.querySelector('.local-terminal:not([hidden])[data-foreground=false]')?.innerText.includes(${q(target)})`));
    });
  }
  const calls=(await readFile(path.join(root,'adb-calls.txt'),'utf8')).trim().split(/\r?\n/);
  assert.ok(calls.length===10&&calls.every(line=>line.startsWith('devices|')));
}

try{
  if(memoryUart)await measureMemoryUart();
  else await measureCommonPaths();
  await tool('退出桌面');
  await until(()=>ui.evaluate('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")'));
  await ui.click('确认退出并停止服务');
  await until(()=>ui.app.exitCode===0);
  await ui.close();ui=undefined;
  result.result='PASS';
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)await ui.screenshot('desktop-performance-common-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(server?.exitCode===null){const ended=once(server,'exit');server.kill();await ended;}
  await writeFile(report,JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
