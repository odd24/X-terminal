import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const uart=process.argv.includes('--uart');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const root=await mkdtemp(path.join(await realpath(tmpdir()),uart?'shared-terminal-serial-ui-中文-shortcut-':'shared-terminal-shortcut-routes-中文-'));
const result={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),checks:[]};
const q=JSON.stringify, node=selector=>`document.querySelector(${q(selector)})`;
const pane='[data-pane].pane-active';
const sidebar=pane+' .adb-shortcut-panel:not([hidden])';
const output=pane+' .local-terminal:not([hidden]) .local-terminal-output';
const selected=()=>ui.evaluate(`${node(pane+' [role="tab"][aria-selected="true"]')}?.dataset.connectionId`);
const row=name=>node(sidebar+` .adb-shortcut-run[aria-label="${name}"]`);
const ref=({connection_id,generation})=>({connection_id,generation});
const {join}=path;
let ui;
const peers=[];

async function wait(read,reason,timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await read();if(value)return value;await delay(60);}
  assert.fail(reason);
}
async function key(key,code,modifiers=0){
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:code,modifiers});
}
async function clickRow(name){
  await ui.waitFor(`!!${row(name)}`);
  await ui.evaluate(`${row(name)}.click()`);
}
async function tool(name){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function activate(connection){
  await ui.selectTab(connection.connection_id);
  await ui.waitFor(`${node(pane)}.dataset.renderedId===${q(connection.connection_id)}&&document.querySelector('footer').innerText.includes('输入就绪')`);
}
async function connectSsh(name){
  const dir=join(root,name);
  await mkdir(dir);
  const child=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[dir],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  peers.push(child);
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const read=async()=>{
    let timer;
    try {return JSON.parse((await Promise.race([lines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture response timeout')),8000)})])).value);}
    finally{clearTimeout(timer);}
  };
  const peer=await read();
  const ssh=request=>ui.invoke('ssh_request',{request});
  const settings={protocol:'ssh2',host:'localhost',port:peer.port,username:'synthetic',auth:'password',encoding:'utf8'};
  const {connection}=await ssh({op:'quick_start',settings,request_id:requestId(),cols:80,rows:24});
  const seen=new Set();
  await wait(async()=>{
    const status=await ssh({op:'status',connection:ref(connection)});
    assert.notEqual(status.connection.state,'FAILED');
    const challenge=status.challenge;
    if(challenge&&!seen.has(challenge.id)){
      seen.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,peer.pin);
        await ssh({op:'answer_host',connection:ref(connection),challenge_id:challenge.id,approve:true});
      }else await ssh({op:'authenticate',connection:ref(connection),challenge_id:challenge.id,use_saved:false,password:peer.password});
    }
    return status.connection.state==='CONNECTED';
  },'SSH fixture not connected');
  child.stdin.write(JSON.stringify({op:'keyboard_echo'})+'\n');await read();
  return connection;
}
async function connectUart(){
  assert.equal((await ui.invoke('service_status')).fixture,true);
  const serial=request=>ui.invoke('serial_request',{request});
  const inventory=await serial({op:'inventory'});
  assert.deepEqual(inventory.devices.map(device=>device.port),['COM7']);
  assert.deepEqual(inventory.unidentified_ports,['COM99']);
  const settings={protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',
    dtr_on_open:false,rts_on_open:false,encoding:'utf8'};
  const {connection}=await serial({op:'quick_start',settings,request_id:requestId(),revision:inventory.revision,device_id:inventory.devices[0].device_id});
  await wait(async()=>(await serial({op:'status',connection:ref(connection)})).connection.state==='CONNECTED','memory UART not connected');
  return connection;
}
async function stream(connection){
  const page=await ui.invoke('service_read',{connection:ref(connection),cursor:1});
  assert.equal(page.truncated,false);assert.equal(page.events.some(event=>event.gap_bytes),false);
  return Buffer.from(page.events.flatMap(event=>event.bytes)).toString('utf8');
}
const seen=(message)=>ui.waitFor(`${node(output)}?.innerText.includes(${q(message)})`);
const flags=async()=>ui.evaluate("({reads:window.routes.reads,sends:window.routes.sends})");
async function stop(){
  await tool('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=退出桌面确认]")');
  await ui.click('确认退出并停止服务');
  await wait(()=>ui.app.exitCode===0,'desktop did not exit');
}
try{
  if(uart){
    const fixture=await readFile(path.resolve('target/desktop-shortcuts-memory-uart/debug/session-service.exe'));
    assert.deepEqual(await readFile(join(path.dirname(executable),'session-service.exe')),fixture,
      'memory UART requires the separately built owned fixture service');
  }
  const adb=join(root,'adb.exe'), grep=join(root,'grep.exe'), probe=join(root,'probe.exe');
  const file=join(root,'结果测试.cmd'), failFile=join(root,'结果失败.cmd');
  await writeFile(join(root,'fixture-root.txt'),'owner');
  await writeFile(file,'@echo off\r\necho BAT_PAUSED\r\nset /p ANSWER=INPUT:\r\nexit /b 0\r\n');
  await writeFile(failFile,'@echo off\r\necho BAT_FAILED\r\nexit /b 7\r\n');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-shortcut.rs','-o',adb],{windowsHide:true,timeout:20000});
  await copyFile(adb,grep);await copyFile(adb,probe);
  process.env.SHORTCUT_FIXTURE_ROOT=root;
  process.env.PATH=root;
  delete process.env.ANDROID_SERIAL;
  ui=await launchDesktop(root,{executable,fixture:uart});
  const mode=value=>writeFile(join(root,'mode.txt'),value);
  const calls=()=>readFile(join(root,'calls.txt'),'utf8').catch(()=>'');
  const legacy={id:randomUUID(),name:'旧 ADB',command:'adb devices -l'};
  const make=(name,command,close_on_success=false)=>({id:randomUUID(),name,command,close_on_success,desktop_kind:'local'});
  const pipeline='adb root\nadb shell "dmesg -w"|grep power';
  const target='ONCE_'+(uart?'UART':'SSH');
  const local=make('真实管道',pipeline);
  const fallback=make('内置筛选','adb shell "dmesg -w" | Select-String power');
  const send={id:randomUUID(),name:'发送样本',command:target,desktop_kind:'send',append_enter:true};
  const pause={id:randomUUID(),name:'暂停脚本',script_path:file,close_on_success:true};
  const fail={id:randomUUID(),name:'失败脚本',script_path:failFile,close_on_success:true};
  const auto=make('成功关闭','probe delay',true);
  const failure=make('前段失败','probe fail | grep power\nprobe tail',true);
  const missing=make('缺少 grep','adb shell "dmesg -w" | grep power');
  const settings=await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,
    shortcuts:[legacy,local,fallback,send,pause,fail,auto,failure,missing]}});
  assert.equal(settings.shortcuts.find(item=>item.id===local.id).command,pipeline);
  await ui.command('Page.reload');
  const first=uart?await connectUart():await connectSsh('first');
  const second=uart?undefined:await connectSsh('second');
  await ui.evaluate(`(()=>{
    const original=window.fetch;
    const state=window.routes={reads:0,sends:0,pending:[],hold:false};
    window.fetch=async function(input,init){
      const command=new URL(String(input)).pathname;
      const payload=JSON.parse(init?.body??'{}');
      if(command==='/local_shortcut_text'){
        state.reads++;
        const response=await original.call(this,input,init);
        if(state.hold)await new Promise(resolve=>state.pending.push(resolve));
        return response;
      }
      if((command==='/ssh_request'||command==='/serial_request')&&['write','send'].includes(payload.request?.op))state.sends++;
      return original.call(this,input,init);
    };
  })()`);
  await activate(first);
  await tool('基础撰写');
  await ui.waitFor(`!!${node('[aria-label="撰写正文"]')}`);
  await ui.fill('撰写正文','DRAFT_STAYS_IN_REMOTE');
  await ui.click('关闭撰写');
  await key('b',66,10);
  await ui.waitFor(`!!${node(sidebar)}&&${row(send.name)}?.getAttribute('aria-disabled')==='false'`);
  assert.equal(await ui.evaluate("document.querySelectorAll('[role=tab]').length"),uart?1:2);
  await ui.click('管理');await ui.waitFor(`!!${node(sidebar+' [aria-label="选择 发送样本"]')}`);
  assert.deepEqual(await flags(),{reads:0,sends:0});
  await ui.click('完成管理');
  const location=await ui.evaluate(`(()=>{const r=${row(send.name)}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...location});
  await ui.waitFor(`${node('.shortcut-preview')}?.textContent.includes(${q(uart?'当前串口':'当前 SSH')})&&${node('.shortcut-preview')}?.textContent.includes(${q(target)})`);
  assert.deepEqual(await flags(),{reads:0,sends:0});
  await key('Escape',27);
  await clickRow(send.name);
  await wait(async()=>(await stream(first)).includes(target),'shortcut bytes not echoed');
  assert.equal((await stream(first)).split(target).length,2);
  assert.equal((await flags()).reads,1);
  if(uart)assert.equal(await stream(first),target+'\r');
  if(second){
    await ui.evaluate('window.routes.hold=true');
    await clickRow(send.name);await ui.waitFor('window.routes.pending.length===1');
    await activate(second);
    await ui.evaluate('window.routes.pending.splice(0).forEach(resolve=>resolve())');
    await delay(250);
    assert.equal((await stream(first)).split(target).length,2);
    assert.equal((await stream(second)).includes(target),false);
    await activate(first);
  }
  result.checks.push('sidebar keyboard opens without a local tab, management is passive, one exact send and no dispatch after switching');
  const run=async name=>{
    await clickRow(name);
    await ui.waitFor(`!!${node(output)}`);
    assert.notEqual(await selected(),first.connection_id);
    return selected();
  };
  const close=async id=>{
    await ui.evaluate(`${node('[role=tab][data-connection-id="'+id+'"]')}.parentElement.querySelector('.tab-close-button').click()`);
    await activate(first);
  };
  const id=await run(legacy.name);
  await seen('List of devices attached');
  assert.equal((await ui.invoke('service_list')).find(connection=>connection.connection_id===first.connection_id).state,'CONNECTED');
  assert.equal(await ui.evaluate(`${row(send.name)}.getAttribute('aria-disabled')`),'true');
  await close(id);
  const paused=await run(pause.name);await seen('BAT_PAUSED');
  assert.equal(await selected(),paused);
  await key('Enter',13);
  await wait(async()=>await selected()===first.connection_id,'successful script did not return to origin');
  assert.equal(await ui.evaluate(`!!${node('[role=tab][data-connection-id="'+paused+'"]')}`),false);
  const scriptFailed=await run(fail.name);
  await seen('退出（7）');
  assert.equal(await selected(),scriptFailed);
  await close(scriptFailed);
  await tool('基础撰写');
  await ui.waitFor(`${node('[aria-label="撰写正文"]')}?.value==='DRAFT_STAYS_IN_REMOTE'`);
  await ui.click('关闭撰写');
  result.checks.push('legacy ADB and BAT open a focused local result from a live remote source; pause retains, exit 0 returns to source, exit 7 retains');
  if(!uart){
    await mode('');
    const success=await run(local.name);
    await seen('LOCAL_GREP:power signal');await seen('[2/2] 完成');
    assert.equal(await ui.evaluate(`${node(output)}.innerText.includes('cold boot')`),false);
    const lines=(await calls()).split(/\r?\n/);
    assert.ok(lines.indexOf('adb|-s|fixed|root')<lines.indexOf('adb|-s|fixed|wait-for-device'));
    assert.ok(lines.indexOf('adb|-s|fixed|wait-for-device')<lines.indexOf('adb|-s|fixed|shell|dmesg -w'));
    assert.ok(lines.includes('grep|power'));
    await close(success);
    const select=await run(fallback.name);await seen('power signal');await seen('[1/1] 完成');
    assert.equal(await ui.evaluate(`${node(output)}.innerText.includes('cold boot')`),false);
    await close(select);
    await mode('deny');
    const beforeDeny=await calls();
    const denied=await run(local.name);await seen('root 被拒绝');
    assert.doesNotMatch((await calls()).slice(beforeDeny.length),/wait-for-device|shell|grep/);
    await close(denied);
    await mode('timeout');
    const beforeTimeout=await calls();
    const timed=await run(local.name);
    await wait(async()=>await ui.evaluate(`${node(output)}?.innerText.includes('本步骤超时')`),'ADB wait did not time out',18000);
    assert.doesNotMatch((await calls()).slice(beforeTimeout.length),/shell|grep/);
    await close(timed);
    await mode('cancel-wait');
    const beforeCancel=await calls();
    const cancelled=await run(local.name);await seen('等待原 ADB 设备');
    await key('c',67,2);await seen('已中断整组命令');
    assert.doesNotMatch((await calls()).slice(beforeCancel.length),/shell|grep/);
    await close(cancelled);
    await mode('interactive');
    const interactive=await run(local.name);await seen('LOCAL_GREP:power signal');
    await ui.command('Input.insertText',{text:'typed'});await key('Enter',13);await seen('LOCAL_GREP:power input typed');
    await key('c',67,2);await seen('已中断整组命令');
    assert.equal(await selected(),interactive);await close(interactive);
    await mode('');
    const failed=await run(failure.name);await seen('退出码 7');
    assert.equal(await ui.evaluate(`${node(output)}.innerText.includes('TAIL_SHOULD_RUN')`),false);
    await close(failed);
    await rename(grep,join(root,'owned-grep.exe'));
    const absent=await run(missing.name);
    await ui.waitFor(`document.querySelector('.local-terminal:not([hidden]) [role=alert]')?.textContent.includes('Select-String power')`);
    await close(absent);
    const delayed=await run(auto.name);await seen('WAITING_FOR_RELEASE');
    await activate(second);await writeFile(join(root,'release'),'continue');
    await ui.waitFor(`!${node('[role=tab][data-connection-id="'+delayed+'"]')}`);
    assert.equal(await selected(),second.connection_id);
    await ui.click('新建快捷指令');await ui.click('本地命令');
    await ui.waitFor(`!!${node('[aria-label="Windows 本地命令"]')}`);
    await ui.fill('指令名称','窗口保存例');
    await ui.fill('Windows 本地命令',pipeline);
    await ui.click('保存指令');
    await ui.waitFor(`!!${row('窗口保存例')}`);
    const uiSaved=(await ui.invoke('local_adb_settings',{settings:null})).shortcuts.find(item=>item.name==='窗口保存例');
    assert.equal(uiSaved.command,pipeline);
    assert.equal(uiSaved.desktop_kind,'local');
    assert.equal(!!uiSaved.close_on_success,false);
    result.checks.push('fixed mock-device root and restart, local grep and Select-String, denial/timeout/interruption stop tail, interactive input, pipeline segment failure, missing grep and background auto-close');
  }
  await stop();
  result.result='PASS';
  console.log(`PASS shortcut routes ${uart?'memory UART':'SSH and Windows batch'}`);
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)await ui.screenshot(`windows-${version}-shortcut-routes-${uart?'uart':'ssh'}-failure.png`).catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  for(const child of peers){
    if(child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.stdin.end();await exited;
    }
  }
  await writeFile(`artifacts/windows-${version}-shortcut-routes-${uart?'uart':'ssh'}.json`,JSON.stringify(result,null,2)+'\n');
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
