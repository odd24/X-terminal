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
const perfIndex=process.argv.indexOf('--measure');
const performanceReport=perfIndex<0?undefined:path.resolve(process.argv[perfIndex+1]);
const echoStages=process.argv.includes('--echo-stages');
const windowCommands=process.argv.includes('--window-commands');
const powershell=performanceReport?execFileSync('where.exe',['pwsh.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]:undefined;
const uart=process.argv.includes('--uart');
assert.ok(!echoStages||performanceReport&&!uart,'echo stages require --measure on the loopback SSH path');
assert.ok(!windowCommands||performanceReport&&!uart&&!echoStages,'window command checks require a dedicated SSH report');
const ttyBaseline=process.argv.includes('--expect-piped-shell');
const variant=uart?'uart':ttyBaseline?'adb-shell-baseline':'ssh';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const root=await mkdtemp(path.join(await realpath(tmpdir()),uart?'shared-terminal-serial-ui-中文-shortcut-':'shared-terminal-shortcut-routes-中文-'));
const result={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),checks:[]};
const q=JSON.stringify, node=selector=>`document.querySelector(${q(selector)})`;
const pane='[data-pane].pane-active';
const sidebar=pane+' .adb-shortcut-panel:not([hidden])';
const output=pane+' .local-terminal:not([hidden]) .local-terminal-output';
const localInput=pane+' .local-terminal:not([hidden]) .xterm-helper-textarea';
const selected=()=>ui.evaluate(`${node(pane+' [role="tab"][aria-selected="true"]')}?.dataset.connectionId`);
const row=name=>node(sidebar+` .adb-shortcut-run[aria-label="${name}"]`);
const ref=({connection_id,generation})=>({connection_id,generation});
const {join}=path;
let ui;
const peers=[];
const pushOutput=new Map();
const fixtureControl=new Map();

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
  const control=async request=>{child.stdin.write(JSON.stringify(request)+'\n');return read();};
  await control({op:'keyboard_echo'});
  pushOutput.set(connection.connection_id,async text=>{await control({op:'push',text});});
  if(echoStages)fixtureControl.set(connection.connection_id,control);
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
async function run(){
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
  const singleShell={id:randomUUID(),name:'单条 shell',command:'adb shell'};
  const shellGroup=make('root 后进入 shell','adb root\nadb shell');
  const stateShell=make('检查设备后进入 shell','adb -s fixed get-state\nadb -s fixed shell',true);
  const commandShell=make('执行设备命令','adb shell "dmesg -w"');
  const partial=make('无换行输出','probe partial\nprobe tail');
  const settings=await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,
    shortcuts:[legacy,local,fallback,send,pause,fail,auto,failure,missing,singleShell,shellGroup,stateShell,commandShell,partial]}});
  assert.equal(settings.shortcuts.find(item=>item.id===local.id).command,pipeline);
  await ui.command('Page.reload');
  const first=uart?await connectUart():await connectSsh('first');
  const second=uart?undefined:await connectSsh('second');
  if(windowCommands){
    const {verifyWindowCommands}=await import('./lib/MeasureRoutes.mjs');
    await verifyWindowCommands({ui,first,second,executable,powershell});
    result.checks.push('main and detached transport scopes, targetless and fixed status, original late reply');
    return;
  }
  if(echoStages){
    const {measureEchoStages}=await import('./lib/MeasureRoutes.mjs');
    result.performance={echoStages:await measureEchoStages({ui,first,second,activate,key,pushOutput,fixtureControl})};
    return;
  }
  await ui.evaluate(`(()=>{
    const original=window.fetch;
    const state=window.routes={reads:0,sends:0,pending:[],hold:false,localStarts:[]};
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
      if(command==='/local_terminal'&&payload.action?.kind==='run_adb')state.localStarts.push(payload.action);
      return original.call(this,input,init);
    };
  })()`);
  await activate(first);
  if(second&&process.argv.includes('--verify-reads')){
    const visible=message=>`document.querySelector('.pane-active .xterm-rows')?.textContent.includes(${q(message)})`;
    const snapshot=await ui.interceptIpc({command:'desktop_session_snapshot',mode:'hold'});
    try{
      await wait(async()=>await snapshot.count()>0,'snapshot response must be held');
      await delay(650);
      await pushOutput.get(first.connection_id)('FALLBACK_WITHOUT_SNAPSHOT\r\n');
      await ui.waitFor(visible('FALLBACK_WITHOUT_SNAPSHOT'));
    }finally{await snapshot.restore();}
    await ui.evaluate(`(()=>{
      const original=window.fetch;
      window.fetch=async function(input,init){
        const response=await original.call(this,input,init);
        if(new URL(String(input)).pathname==='/service_read'){
          const page=await response.clone().json();
          if(page.connection.connection_id===${q(first.connection_id)}&&
             new TextDecoder().decode(Uint8Array.from(page.events.flatMap(e=>e.bytes))).includes('LATE_ORIGINAL')){
            window.fetch=original;
            await new Promise(resolve=>window.releaseOldPage=resolve);
          }
        }
        return response;
      };
    })()`);
    await pushOutput.get(first.connection_id)('LATE_ORIGINAL\r\n');
    await ui.waitFor("typeof window.releaseOldPage==='function'");
    await ui.selectTab(second.connection_id);
    assert.equal(await selected(),second.connection_id);
    await ui.evaluate('window.releaseOldPage()');
    await activate(second);
    await pushOutput.get(second.connection_id)('SECOND_ONLY\r\n');
    await ui.waitFor(visible('SECOND_ONLY'));
    assert.equal(await ui.evaluate(visible('LATE_ORIGINAL')),false);
    await activate(first);await ui.waitFor(visible('LATE_ORIGINAL'));
    assert.equal(await ui.evaluate(visible('SECOND_ONLY')),false);
    result.checks.push('idle fallback during a held snapshot; delayed old read never paints into a newly selected connection');
  }
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
  await ui.waitFor(`${row(send.name)}?.getClientRects().length>0&&!${node(sidebar+' [aria-label="选择 发送样本"]')}`);
  await ui.command('Page.bringToFront');
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});
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
  await mode('multiple');
  const startCalls=await calls();
  const tabCount=await ui.evaluate("document.querySelectorAll('[role=tab]').length");
  await ui.evaluate(`(()=>{const button=${row(singleShell.name)};button.click();button.click();})()`);
  await ui.waitFor(`!!document.querySelector('[aria-label="本次 ADB 设备"]')`);
  const cancelledId=await selected();
  assert.equal(await ui.evaluate("document.querySelectorAll('[role=tab]').length"),tabCount+1);
  await ui.click('取消本次操作');
  await ui.waitFor(`${row(singleShell.name)}?.getAttribute('aria-disabled')==='false'`);
  assert.equal((await calls()).slice(startCalls.length).trim(),'adb|devices|-l');
  await close(cancelledId);
  await mode('');
  result.checks.push('rapid activation opens one result; cancelling device selection releases startup without running a device command');
  const id=await run(legacy.name);
  await seen('List of devices attached');
  assert.equal((await ui.invoke('service_list')).find(connection=>connection.connection_id===first.connection_id).state,'CONNECTED');
  assert.equal(await ui.evaluate(`${row(send.name)}.getAttribute('aria-disabled')`),'true');
  await close(id);
  if(performanceReport){
    const {measureRoutes}=await import('./lib/MeasureRoutes.mjs');
    await mode('already-root');
    result.performance={};
    await measureRoutes({ui,first,second,group:shellGroup.name,single:singleShell.name,activate,close,key,row,output,executable,powershell,pushOutput},result.performance);
  }
  const paused=await run(pause.name);await seen('BAT_PAUSED');await seen('INPUT:');
  assert.equal(await selected(),paused);
  await ui.waitFor(`document.activeElement===${node(localInput)}`);
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
    const snapshot=()=>ui.evaluate(`${node(output)}?.innerText`);
    const consoleLines=()=>ui.evaluate(`(()=>{
      const host=${node(output)};
      for(let fiber=host[Object.keys(host).find(key=>key.startsWith('__reactFiber'))];fiber;fiber=fiber.return){
        for(let hook=fiber.memoizedState;hook;hook=hook.next){
          const terminal=hook.memoizedState?.current;
          if(terminal?.buffer?.active&&terminal?.element){
            const buffer=terminal.buffer.active;
            return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i).translateToString(true));
          }
        }
      }
      throw new Error('Owned shortcut result terminal not located');
    })()`);
    const type=async text=>{await ui.command('Input.insertText',{text});await key('Enter',13);};
    const focus=()=>ui.waitFor("document.activeElement?.matches('.local-terminal:not([hidden]) .xterm-helper-textarea')");
    const recorded=async from=>(await calls()).slice(from.length).trim().split(/\r?\n/);
    await mode('already-root');
    const singleStart=await calls();
    const single=await run(singleShell.name);
    await focus();await seen('fixture:/ #');
    assert.ok((await recorded(singleStart)).includes('bare-shell-terminal|true'));
    await type('exit');await seen('前台进程退出（0）');await close(single);

    const groupStart=await calls();
    const group=await run(shellGroup.name);
    await focus();
    if(ttyBaseline){
      await seen('[2/2] 开始');
      await wait(async()=>(await recorded(groupStart)).includes('bare-shell-terminal|false'),'0.1.33 shell must be piped');
      assert.doesNotMatch(await snapshot(),/fixture:\/ #/);
      assert.ok((await recorded(groupStart)).includes('adb|-s|fixed|wait-for-device'));
      await key('c',67,2);await seen('已中断整组命令');await close(group);
      result.checks.push('0.1.33 single command sees a TTY; the exact root/shell group starts over pipes and has no prompt');
    }else{
      await seen('fixture:/ #');
      const lines=await consoleLines();
      const rootLine=lines.indexOf('adb root');
      assert.ok(rootLine>=0);
      const initial=['adb root','adbd is already running as root','adb shell','fixture:/ #'];
      assert.deepEqual(lines.slice(rootLine,rootLine+initial.length),initial);
      assert.equal(lines[rootLine-1],'固定 ADB 设备 fixed');
      assert.doesNotMatch(lines.join('\n'),/\[\d+\/\d+\] (?:开始|完成)|adb -s fixed (?:root|shell)|wait-for-device/);
      const action=await ui.evaluate('window.routes.localStarts.at(-1)');
      assert.equal(action.id,group);
      await ui.invoke('local_terminal',{action});
      await ui.command('Input.insertText',{text:'pwd'});
      await seen('fixture:/ # pwd');
      await key('Enter',13);await seen('/fixture-read-only');
      const screenshot=`windows-${version}-adb-group-output.png`;
      await ui.screenshot(screenshot);
      result.transcript=initial;
      result.screenshot=screenshot;
      await type('exit');await seen('前台进程退出（0）');
      const completed=await consoleLines();
      for(const command of ['adb root','adb shell'])assert.equal(completed.filter(line=>line===command).length,1);
      assert.doesNotMatch(completed.join('\n'),/\[\d+\/\d+\] (?:开始|完成)/);
      assert.deepEqual((await recorded(groupStart)).filter(line=>!line.startsWith('adb|devices')),[
        'adb|-s|fixed|root','adb|-s|fixed|shell','bare-shell-terminal|true',
        'bare-shell-input|pwd','bare-shell-input|exit',
      ]);
      await close(group);

      const stateStart=await calls();
      const state=await run(stateShell.name);
      await seen('fixture:/ #');
      assert.ok((await consoleLines()).includes('adb -s fixed get-state'));
      assert.ok((await consoleLines()).includes('adb -s fixed shell'));
      await ui.invoke('local_terminal',{action:{kind:'resize',id:state,cols:94,rows:31}});
      await delay(200);
      await type('size');await seen('FIXTURE_SIZE:94x31');
      await type('exit 7');await seen('ADB 交互终端退出码 7');
      assert.equal(await selected(),state);
      await close(state);
      const ended=await run(stateShell.name);await seen('fixture:/ #');
      await type('exit');
      await ui.waitFor(`!${node('[role=tab][data-connection-id="'+ended+'"]')}`);
      assert.equal(await selected(),first.connection_id);
      assert.equal((await recorded(stateStart)).filter(line=>line==='adb|-s|fixed|get-state').length,2);
      await mode('interactive-proof');
      const stopped=await run(stateShell.name);await seen('proof:/ #');
      await ui.waitFor(`document.activeElement===${node(localInput)}`);
      await key('c',67,2);
      await seen('^C');assert.equal(await selected(),stopped);
      await type('exit');
      await ui.waitFor(`!${node('[role=tab][data-connection-id="'+stopped+'"]')}`);
      assert.equal(await selected(),first.connection_id);
      result.checks.push('checked interactive ADB shortcut retains the same shell after Ctrl+C and returns to SSH after explicit exit');
      const middle=await run(shellGroup.name);await seen('proof:/ #');
      await key('c',67,2);await seen('^C');
      assert.equal(await selected(),middle);await close(middle);
      await mode('');
      const commandStart=await calls();
      const command=await run(commandShell.name);
      await seen('cold boot');await seen('前台进程退出（0）');
      assert.ok((await recorded(commandStart)).includes('adb|-s|fixed|shell|dmesg -w'));
      await close(command);
      const adjacent=await run(partial.name);
      await seen('前台进程退出（0）');
      const withoutNewline=await consoleLines();
      const partialLine=withoutNewline.indexOf('probe partial');
      assert.ok(partialLine>=0);
      assert.deepEqual(withoutNewline.slice(partialLine,partialLine+4),
        ['probe partial','OUTPUT_WITHOUT_NEWLINE','probe tail','TAIL_SHOULD_RUN']);
      await close(adjacent);
      result.checks.push('original commands echo once in order without phase labels or blank rows; unterminated output gets one separator; real TTY and fixed-device dedup, keyboard echo, resize, exit and interruption retained');
    }
  }
  if(!ttyBaseline){
    await mode('');
    const pipelineStart=await calls();
    const success=await run(local.name);
    await seen('LOCAL_GREP:power signal');await seen('前台进程退出（0）');
    assert.equal(await ui.evaluate(`${node(output)}.innerText.includes('cold boot')`),false);
    const lines=(await calls()).slice(pipelineStart.length).split(/\r?\n/);
    assert.ok(lines.indexOf('adb|-s|fixed|root')<lines.indexOf('adb|-s|fixed|wait-for-device'));
    assert.ok(lines.indexOf('adb|-s|fixed|wait-for-device')<lines.indexOf('adb|-s|fixed|shell|dmesg -w'));
    assert.ok(lines.includes('grep|power'));
    await close(success);
    result.checks.push('two-line local ADB pipeline from active remote session');
  }
  if(!uart&&!ttyBaseline){
    const select=await run(fallback.name);await seen('power signal');await seen('前台进程退出（0）');
    assert.ok((await ui.evaluate(`${node(output)}.innerText`)).split(/\r?\n/).some(line=>line.trimEnd()===fallback.command));
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
    assert.doesNotMatch(await ui.evaluate(`${node(output)}.innerText`),/^probe tail\s*$/m);
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
}
try{
  await run();
  await stop();
  result.result='PASS';
  console.log(windowCommands?'PASS isolated window transport commands':echoStages?'PASS isolated echo stages':`PASS shortcut routes ${uart?'memory UART':'SSH and Windows batch'}`);
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)await ui.screenshot(`windows-${version}-shortcut-routes-${variant}-failure.png`).catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  for(const child of peers){
    if(child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.stdin.end();await exited;
    }
  }
  await writeFile(performanceReport??`artifacts/windows-${version}-shortcut-routes-${variant}.json`,JSON.stringify(result,null,2)+'\n');
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
