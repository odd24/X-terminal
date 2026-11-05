import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-ssh-ui-'));
const fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], {windowsHide:true, stdio:['pipe','pipe','pipe']});
const lines = createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
const next = async () => {
  let timeout;
  try { const result = await Promise.race([lines.next(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]); assert.equal(result.done,false); return JSON.parse(result.value); }
  finally { clearTimeout(timeout); }
};
const control = async request => { fixture.stdin.write(JSON.stringify(request)+'\n'); return next(); };
let ui;
try {
  const server = await next();
  ui = await launchDesktop(directory);
  const save = async (name,auth,credential={action:'keep'}) => {
    const profile = {id:crypto.randomUUID(), folder_id:null, name, settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth,encoding:'utf8'}};
    const reply = await ui.invoke('config_request',{request:{op:'save_profile',profile,credential}});
    assert.equal(reply.result,'saved_profile');return profile;
  };
  const password = await save('loopback password','password');
  const keyboard = await save('loopback challenge','keyboard_interactive');
  const keyProfile = {id:crypto.randomUUID(), folder_id:null, name:'loopback key', settings:{...password.settings,auth:'public_key'}};
  assert.equal((await ui.invoke('config_request',{request:{op:'save_profile_key_file',profile:keyProfile,key_path:server.key_path,passphrase:server.password}})).result,'saved_profile');
  await ui.click('SSH2 连接');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length === 4`);
  const choose = async profile => { await ui.fill('SSH2 配置',profile.id); await ui.click('建立 SSH2 连接'); };
  const state = value => ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith(${JSON.stringify(value)})`);
  const waitButton = label => ui.waitFor(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent===${JSON.stringify(label)} && !button.disabled)`);
  await choose(password); await waitButton('拒绝 SSH2 主机');
  assert.equal((await control({op:'metrics'})).attempts,0,'no authentication before trust');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='信任本次 SSH2 主机').disabled`),true);
  assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent===${JSON.stringify(server.pin)}`),true);
  await ui.click('拒绝 SSH2 主机'); await state('FAILED');
  await ui.click('显式重连 SSH2'); await waitButton('拒绝 SSH2 主机');
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
  await ui.click('信任本次 SSH2 主机'); await waitButton('提交本次 SSH2 密码');
  await ui.fill('SSH2 临时密码','wrong synthetic password'); await ui.click('提交本次 SSH2 密码');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 临时密码"]')?.value === ''`);
  for(let attempt=0;attempt<100 && (await control({op:'metrics'})).attempts<1;attempt++) await delay(50);
  await delay(300); await waitButton('提交本次 SSH2 密码');
  await ui.fill('SSH2 临时密码',server.password); await ui.click('提交本次 SSH2 密码'); await state('CONNECTED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH2 临时密码"]') === null`),true);
  let connection = (await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
  assert.equal(connection.generation,2);
  await ui.waitFor(`document.querySelector('footer [aria-label="活动编码"]')?.textContent==='编码：UTF-8' && document.querySelector('footer [aria-label="权限状态"]')?.textContent.includes('桌面输入可用')`);
  assert.equal(await ui.evaluate(`document.querySelector('footer [aria-label="权限状态"]').textContent.includes('Agent 写入未开放')`),true,'Desktop readiness does not imply Agent authorization');
  // Fill and cross the receipt cap through the real Desktop adapter, then use real keyboard input.
  // Historical timestamps keep the new GUI request above the retired watermark after the loop.
  const orderedInputId = index => `00000000-${index.toString(16).padStart(4,'0')}-7000-8000-000000000001`;
  const capacityConnection = {connection_id:connection.connection_id,generation:connection.generation};
  for (let index=1;index<=1100;index++) {
    const request_id=orderedInputId(index);
    let receipt=await ui.invoke('ssh_request',{request:{op:'resize',connection:capacityConnection,request_id,cols:80,rows:24}});
    assert.equal(receipt.result,'input');
    const deadline=Date.now()+5000;
    while(receipt.state==='PENDING'||receipt.state==='DISPATCHING') {
      assert.ok(Date.now()<deadline,'capacity fixture input must finish');
      await delay(1);
      receipt=await ui.invoke('ssh_request',{request:{op:'input_status',connection:capacityConnection,request_id}});
    }
    assert.equal(receipt.state,'PIPELINE_QUEUED');
  }
  const expired = await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('ssh_request',${JSON.stringify({request:{op:'resize',connection:capacityConnection,request_id:orderedInputId(1),cols:80,rows:24}})}).then(()=>null,error=>String(error))`);
  assert.equal(expired,'RequestExpired');
  await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await ui.command('Input.insertText',{text:'first'});
  await ui.command('Input.insertText',{text:'second'});
  await ui.waitFor(`document.querySelector('.input-status output').textContent.includes('发送管线')`);
  for(let attempt=0;attempt<100;attempt++){ const metrics=await control({op:'metrics'});if(Buffer.from(metrics.received.flat()).toString()==='firstsecond')break;await delay(50); }
  assert.equal(Buffer.from((await control({op:'metrics'})).received.flat()).toString(),'firstsecond');
  assert.equal(await ui.evaluate(`document.querySelector('.input-status').textContent.includes('first')`),false,'typed bytes excluded from diagnostics');
  const beforeResize=(await control({op:'metrics'})).sizes.length;
  await ui.fill('字号','20');
  for(let attempt=0;attempt<100 && (await control({op:'metrics'})).sizes.length<=beforeResize;attempt++) await delay(50);
  const sizes=(await control({op:'metrics'})).sizes; assert.ok(sizes.length>=2);assert.notDeepEqual(sizes[0],sizes.at(-1));
  await ui.click('屏幕快照'); await ui.waitFor(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('firstsecond')`);
  await ui.screenshot('desktop-ssh2-connected.png');
  // Actual font/fit resize drives the existing FIFO resize service path.
  const screenRef = {connection_id:connection.connection_id,generation:connection.generation};
  const oldScreen = await ui.invoke('service_screen',{connection:screenRef});
  let reflowText = 'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(oldScreen.cols*2/26)).slice(0,oldScreen.cols*2-4)+'\r\nREFLOW_END';
  await control({op:'push',text:'\x1bc\x1b[3J'+reflowText});
  await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.endsWith('REFLOW_END'))`);
  const verifyReflow = async font => {
    await ui.fill('字号',font);
    let screen;
    for(let attempt=0;attempt<100;attempt++) {
      await delay(50);
      screen = await ui.invoke('service_screen',{connection:screenRef});
      if(font==='28' ? screen.cols < oldScreen.cols : screen.cols===oldScreen.cols) break;
    }
    assert.ok(font==='28' ? screen.cols < oldScreen.cols : screen.cols===oldScreen.cols,'real font fit must resize service');
    assert.equal(screen.parser,'vt100-0.18.1+local.4');assert.equal(screen.resize_reflow,true);
    const {default:{Terminal}} = await import('@xterm/headless');
    const reference = new Terminal({cols:oldScreen.cols,rows:oldScreen.rows,scrollback:512,allowProposedApi:true});
    await new Promise(resolve=>reference.write(reflowText,resolve));reference.resize(screen.cols,screen.rows);
    const b=reference.buffer.active;
    const rows=Array.from({length:reference.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true,0,reference.cols)??'');
    while(rows.at(-1)==='') rows.pop();
    assert.equal(screen.contents,rows.join('\n'));
    assert.deepEqual([screen.cursor_row,screen.cursor_col],[b.cursorY,b.cursorX]);reference.dispose();
    await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent===${JSON.stringify(screen.contents)})`);
    await ui.click('服务端屏幕');
    await ui.waitFor(`document.querySelector('[aria-label="服务端屏幕快照"]')?.textContent===${JSON.stringify(screen.contents)}`);
  };
  await verifyReflow('28');await ui.screenshot('desktop-ssh2-reflow-synthetic.png');await verifyReflow('20');
  // A wide character arriving with exactly one column left must remain part
  // of the same logical line through real font/fit/FIFO resize operations.
  reflowText = 'a'.repeat(oldScreen.cols-1)+'中中文\r\nREFLOW_END';
  await control({op:'push',text:'\x1bc\x1b[3J'+reflowText});
  await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('中中') && document.querySelector('[aria-label="屏幕快照"]')?.textContent.endsWith('REFLOW_END'))`);
  await verifyReflow('28');await ui.screenshot('desktop-ssh2-wide-reflow-synthetic.png');await verifyReflow('20');


  // Real WebView/IPC and a separate locked reference observe each switch.
  for (const mode of [47, 1047, 1049]) {
    const {default:{Terminal}} = await import('@xterm/headless');
    const reference = new Terminal({cols:oldScreen.cols,rows:oldScreen.rows,scrollback:512,allowProposedApi:true});
    try {
      const checkAlternate = async () => {
        const b=reference.buffer.active;
        const rows=Array.from({length:reference.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true,0,reference.cols)??'');
        while(rows.at(-1)==='') rows.pop();
        const expected=rows.join('\n');
        let screen;
        for(let attempt=0;attempt<100;attempt++) {
          screen=await ui.invoke('service_screen',{connection:screenRef});
          if(screen.contents===expected && screen.alternate===(b.type==='alternate') && screen.cursor_row===b.cursorY && screen.cursor_col===b.cursorX) break;
          await delay(50);
        }
        assert.equal(screen.contents,expected,`mode ${mode} service contents`);
        assert.equal(screen.alternate,b.type==='alternate');
        assert.deepEqual([screen.cursor_row,screen.cursor_col],[b.cursorY,b.cursorX]);
        assert.equal(screen.parser,'vt100-0.18.1+local.4');
        await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),(document.querySelector('[aria-label="屏幕快照"]')?.textContent??'')===${JSON.stringify(expected)})`);
        await ui.click('服务端屏幕');
        await ui.waitFor(`document.querySelector('[aria-label="服务端屏幕快照"]')?.textContent===${JSON.stringify(expected || '空屏幕')}`);
      };
      for(const text of ['\x1bcnormal\x1b[3;4H', `\x1b[?${mode}h中A`, `\x1b[?${mode}hB`, `\x1b[?${mode}l`, `\x1b[?${mode}h`]) {
        await control({op:'push',text});
        await new Promise(resolve=>reference.write(text,resolve));
        await checkAlternate();
      }
      for(const font of ['28','20']) {
        await ui.fill('字号',font);
        let screen;
        for(let attempt=0;attempt<100;attempt++) {
          screen=await ui.invoke('service_screen',{connection:screenRef});
          if(font==='28'?screen.cols<oldScreen.cols:screen.cols===oldScreen.cols) break;
          await delay(50);
        }
        assert.ok(font==='28'?screen.cols<oldScreen.cols:screen.cols===oldScreen.cols);
        reference.resize(screen.cols,screen.rows);
        await checkAlternate();
      }
      const exit=`\x1b[?${mode}l!`;
      await control({op:'push',text:exit});
      await new Promise(resolve=>reference.write(exit,resolve));
      await checkAlternate();
      if(mode===1049) await ui.screenshot('desktop-ssh2-alternate-lifecycle-synthetic.png');
    } finally { reference.dispose(); }
  }

  await ui.click('exec 任务');
  const runExec = async (command, end, timeout=30000, limit=1048576) => {
    const previous=await ui.evaluate(`document.querySelector('[aria-label="exec 任务列表"]').value`);
    await ui.fill('exec 命令',command);await ui.fill('exec 超时毫秒',timeout);await ui.fill('exec 输出上限',limit);
    await ui.click('启动 exec 任务');
    await ui.waitFor(`document.querySelector('[aria-label="exec 命令"]').value === ''`);
    await ui.waitFor(`document.querySelector('[aria-label="exec 任务列表"]').value !== ${JSON.stringify(previous)} && document.querySelector('[aria-label="exec 任务状态"]')?.textContent.startsWith(document.querySelector('[aria-label="exec 任务列表"]').value) && document.querySelector('[aria-label="exec 任务状态"]').textContent.includes(${JSON.stringify(end)})`);
    return ui.evaluate(`document.querySelector('[aria-label="exec 任务列表"]').value`);
  };
  const failedTask=await runExec('fail','COMPLETED');
  await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]').textContent.includes('退出码 7')`);
  await ui.waitFor(`document.querySelector('[aria-label="exec 输出"]').textContent.includes('failure')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="exec 输出"] [data-stream="stderr"]').textContent.includes('err|')`),true);
  await ui.click('屏幕快照');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]').textContent.includes('failure')`),false,'exec output isolated from shell');
  await ui.screenshot('desktop-ssh2-exec.png');
  await runExec('signal','REMOTE_SIGNAL');await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]').textContent.includes('信号 TERM')`);
  await runExec('no-status','MISSING_EXIT_STATUS');
  await runExec('no-ack','TIMEOUT',350);
  await ui.waitFor(`document.querySelector('[aria-label="exec 输出"]').textContent.includes('early|')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="exec 任务状态"]').textContent.includes('退出码 未提供')`),true);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="exec 任务状态"]').textContent.includes('未观察到接受')`),true,'missing ack is not a rejection');
  await runExec('utf8','COMPLETED');
  await ui.waitFor(`Array.from(document.querySelectorAll('[aria-label="exec 输出"] [data-stream="stdout"]')).map(item=>item.textContent).join('').includes('中') && Array.from(document.querySelectorAll('[aria-label="exec 输出"] [data-stream="stderr"]')).map(item=>item.textContent).join('').includes('测')`);
  await ui.fill('exec 命令','stall');await ui.fill('exec 超时毫秒',30000);await ui.click('启动 exec 任务');
  await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]')?.textContent.includes('RUNNING')`);
  await ui.click('取消选中 exec 任务');
  await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]')?.textContent.includes('CANCELLED')`);
  await runExec('big','COMPLETED');
  await ui.waitFor(`document.querySelector('.exec-panel [role="alert"]')?.textContent.includes('输出缺口')`);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="exec 输出"]').textContent.length`))<=65536);
  await runExec('overflow','OUTPUT_LIMIT',30000,65536);
  await ui.waitFor(`document.querySelector('.exec-panel').textContent.includes('总输出上限')`);
  const beforeLookup=(await control({op:'metrics'})).exec_calls.length;
  await ui.fill('查询 exec 任务 ID',failedTask);await ui.click('查询 exec 任务');
  await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]')?.textContent.startsWith(${JSON.stringify(failedTask)})`);
  assert.equal((await control({op:'metrics'})).exec_calls.length,beforeLookup,'query cannot rerun a command');
  for(let index=0;index<70;index++) await runExec('fail','COMPLETED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="exec 任务列表"]').options.length`),65,'page retains 64 records plus placeholder');
  const beforeExpiredLookup=(await control({op:'metrics'})).exec_calls.length;
  await ui.fill('查询 exec 任务 ID',failedTask);await ui.click('查询 exec 任务');
  await ui.waitFor(`document.querySelector('.exec-panel [role="status"]').textContent.includes('保留窗口')`);
  assert.equal((await control({op:'metrics'})).exec_calls.length,beforeExpiredLookup,'expired query cannot rerun a command');
  await ui.click('exec 任务');

  await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await ui.command('Input.insertText',{text:'x'.repeat(65537)});
  await ui.waitFor(`document.querySelector('.status').textContent.includes('编码字节上限')`);
  await delay(400);
  assert.equal(await ui.evaluate(`document.querySelector('.status').textContent.includes('编码字节上限')`),true,'read polling must not overwrite rejected-input feedback');
  assert.equal(Buffer.from((await control({op:'metrics'})).received.flat()).toString(),'firstsecond','oversized paste is not sent');

  await control({op:'end'}); await state('DISCONNECTED');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]').textContent.includes('shell 退出码 7')`);
  // Corrupt the remembered public pin to exercise an actual changed-key GUI decision.
  const database=new DatabaseSync(path.join(directory,'config.sqlite'));
  database.prepare('UPDATE host_keys SET key=?').run(Buffer.from('synthetic changed remembered key')); database.close();
  await ui.click('显式重连 SSH2'); await waitButton('拒绝 SSH2 主机');
  await ui.waitFor(`document.querySelector('.ssh-panel').textContent.includes('主机密钥已变化')`);
  await ui.screenshot('desktop-ssh2-changed-key.png');
  const before=(await control({op:'metrics'})).attempts;
  await ui.click('拒绝 SSH2 主机'); await state('FAILED'); assert.equal((await control({op:'metrics'})).attempts,before);
  await ui.click('显式重连 SSH2');await waitButton('拒绝 SSH2 主机');
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);await ui.click('信任本次 SSH2 主机');
  await waitButton('提交本次 SSH2 密码');await ui.fill('SSH2 临时密码',server.password);await ui.click('提交本次 SSH2 密码');await state('CONNECTED');
  await ui.click('关闭 SSH2 连接');await state('DISCONNECTED');
  await choose(keyProfile); await waitButton('使用保存的 SSH2 凭据');await ui.click('使用保存的 SSH2 凭据');await state('CONNECTED');
  await control({op:'disconnect'});await state('FAILED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH2 状态"]').textContent.includes('shell 退出码')`),false,'disconnect cannot invent status');
  await choose(keyboard);await ui.waitFor(`document.querySelector('[aria-label="SSH2 认证回答 1"]')?.type === 'password'`);
  await ui.fill('SSH2 认证回答 1',server.password);await ui.click('提交 SSH2 认证回答');await state('CONNECTED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH2 认证回答 1"]') === null`),true);
  connection=(await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
  await ui.click('exec 任务');
  const reloadTask=await runExec('stall','RUNNING');
  const beforeTaskReload=(await control({op:'metrics'})).exec_calls.length;
  const pid=(await ui.invoke('service_status')).pid;
  const beforeReload=(await control({op:'metrics'})).sizes.at(-1);
  await ui.evaluate(`window.__sshReloadProbe = true`);
  await ui.command('Page.reload'); await ui.waitFor(`window.__sshReloadProbe === undefined && document.querySelector('footer')?.textContent.includes('服务 ')`);
  assert.equal((await ui.invoke('service_status')).pid,pid);
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value === ${JSON.stringify(connection.connection_id)})`);
  await ui.fill('会话',connection.connection_id);
  for(let attempt=0;attempt<100;attempt++){const size=(await control({op:'metrics'})).sizes.at(-1);if(JSON.stringify(size)!==JSON.stringify(beforeReload))break;await delay(50);}
  assert.notDeepEqual((await control({op:'metrics'})).sizes.at(-1),beforeReload,'reload/new selection must synchronize the fresh terminal dimensions');
  assert.ok((await ui.invoke('service_list')).some(item=>item.connection_id===connection.connection_id && item.generation===connection.generation && item.state==='CONNECTED'));
  await ui.click('exec 任务');
  await ui.fill('查询 exec 任务 ID',reloadTask);await ui.click('查询 exec 任务');
  await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]')?.textContent.includes('RUNNING')`);
  assert.equal((await control({op:'metrics'})).exec_calls.length,beforeTaskReload,'reload/query cannot restart exec');
  await ui.click('取消选中 exec 任务');await ui.waitFor(`document.querySelector('[aria-label="exec 任务状态"]')?.textContent.includes('CANCELLED')`);
  await ui.click('SSH2 连接');await state('CONNECTED');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='移除连接记录').disabled`),true);
  await ui.click('关闭 SSH2 连接');await state('DISCONNECTED');
  let retained=await ui.invoke('service_list');
  // Hold one real list response while the real UI removes its first entry.
  // The next metadata lookup must see actual NotFound, then refresh the list.
  assert.ok(retained.length>=2);
  const removedDuringPoll=retained[0];
  const currentBeforeRace=retained[1];
  await ui.fill('会话',currentBeforeRace.connection_id);
  await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='服务端屏幕').click(),document.querySelector('[aria-label="服务端屏幕快照"]')?.previousElementSibling?.textContent.includes(${JSON.stringify(currentBeforeRace.connection_id)}))`);
  await ui.evaluate(`(() => {
    const original=window.fetch;
    const hook={original,held:0,notFound:0,release:null};window.__listRemovalRace=hook;
    window.fetch=async function(input,init){
      const response=await original.call(this,input,init);
      const command=new URL(String(input)).pathname;
      if(command==='/service_list' && hook.held===0){
        hook.held++;
        await new Promise(resolve=>{hook.release=resolve;});
      }
      if(command==='/ssh_request' && response.headers.get('Tauri-Response')==='error' && (await response.clone().text()).includes('NotFound'))hook.notFound++;
      return response;
    };
    if(window.fetch===original)throw new Error('fetch hook did not install');
  })()`);
  try {
    await ui.waitFor('window.__listRemovalRace.held===1');
    await ui.fill('会话',removedDuringPoll.connection_id);
    await ui.waitFor(`document.querySelector('[aria-label="SSH2 目标"]')?.textContent.includes(${JSON.stringify(removedDuringPoll.connection_id)})`);
    await waitButton('移除连接记录');
    await ui.click('移除连接记录');
    await ui.waitFor(`document.querySelector('.ssh-panel [role="status"]')?.textContent.includes('已移除')`);
    await ui.evaluate('window.__listRemovalRace.release()');
    await ui.waitFor(`!Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value===${JSON.stringify(removedDuringPoll.connection_id)})`);
    const race=await ui.evaluate('({held:window.__listRemovalRace.held,notFound:window.__listRemovalRace.notFound})');
    assert.equal(race.held,1);assert.ok(race.notFound>=1,'actual removed-target metadata request must reject');
    assert.equal(await ui.evaluate(`document.querySelector('.status').textContent.includes('会话服务不可用')`),false);
    console.log('List/removal IPC race checkpoint:',JSON.stringify(race));
  } finally {
    await ui.evaluate('window.__listRemovalRace.release?.();window.fetch=window.__listRemovalRace.original;delete window.__listRemovalRace');
  }
  retained=retained.filter(item=>item.connection_id!==removedDuringPoll.connection_id);
  for(const item of retained){
    await ui.fill('会话',item.connection_id);
    await ui.waitFor(`document.querySelector('[aria-label="SSH2 目标"]')?.textContent.includes(${JSON.stringify(item.connection_id)})`);
    await waitButton('移除连接记录');await ui.click('移除连接记录');
    await ui.waitFor(`!Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value===${JSON.stringify(item.connection_id)})`);
  }
  await ui.waitFor(`document.querySelector('.status').textContent.includes('尚无活动连接')`);
  assert.equal((await ui.invoke('service_list')).length,0);
  await choose(password);await waitButton('提交本次 SSH2 密码');
  await ui.fill('SSH2 临时密码',server.password);await ui.click('提交本次 SSH2 密码');await state('CONNECTED');
  const replacement=(await ui.invoke('service_list'))[0];
  assert.notEqual(replacement.connection_id,connection.connection_id);
  await ui.click('关闭 SSH2 连接');await state('DISCONNECTED');await ui.click('移除连接记录');
  await ui.waitFor(`document.querySelector('.status').textContent.includes('尚无活动连接')`);
  assert.equal((await ui.invoke('service_list')).length,0);
  // P11.5: real WebView text input, frozen metadata, split legacy exec streams and reload.
  const legacySnapshot = async text => {
    for(let attempt=0;attempt<200;attempt++) {
      await ui.click('屏幕快照');
      if(await ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes(${JSON.stringify(text)})`)) return;
      await delay(50);
    }
    throw new Error('legacy terminal snapshot did not contain expected synthetic text');
  };
  for (const [encoding, text, raw] of [['gbk','中文',[214,208,206,196]], ['gb18030','中𐀀',[214,208,144,48,129,48]]]) {
    const legacy = {id:crypto.randomUUID(),folder_id:null,name:`synthetic ${encoding}`,settings:{...password.settings,encoding}};
    assert.equal((await ui.invoke('config_request',{request:{op:'save_profile',profile:legacy,credential:{action:'keep'}}})).result,'saved_profile');
    await ui.click('刷新 SSH2 配置');
    await ui.waitFor(`Array.from(document.querySelector('[aria-label="SSH2 配置"]').options).some(o=>o.value===${JSON.stringify(legacy.id)})`);
    const beforeLegacySizes=(await control({op:'metrics'})).sizes.length;
    await choose(legacy);await waitButton('提交本次 SSH2 密码');
    await ui.fill('SSH2 临时密码',server.password);await ui.click('提交本次 SSH2 密码');await state('CONNECTED');
    const active = (await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
    const scope = {connection_id:active.connection_id,generation:active.generation};
    const getStatus = () => ui.invoke('ssh_request',{request:{op:'status',connection:scope}});
    assert.equal((await getStatus()).encoding,encoding);
    // Change the Profile while keeping the generation alive; only a future restart takes it.
    assert.equal((await ui.invoke('config_request',{request:{op:'save_profile',profile:{...legacy,settings:{...legacy.settings,encoding:'utf8'}},credential:{action:'keep'}}})).result,'saved_profile');
    await ui.waitFor(`document.querySelector('footer [aria-label="活动编码"]')?.textContent===${JSON.stringify('编码：'+encoding.toUpperCase())}`);
    const beforeBytes=(await control({op:'metrics'})).received.flat().length;
    for(let attempt=0;attempt<100 && (await control({op:'metrics'})).sizes.length<beforeLegacySizes+2;attempt++) await delay(50);
    assert.ok((await control({op:'metrics'})).sizes.length>=beforeLegacySizes+2,'selected terminal has synchronized dimensions');
    await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
    await ui.command('Input.insertText',{text});
    await ui.waitFor(`document.querySelector('.input-status output').textContent.includes('发送管线')`);
    assert.deepEqual((await control({op:'metrics'})).received.flat().slice(beforeBytes),raw);
    for (const byte of raw) { await control({op:'push_bytes',bytes:[byte]});await delay(180); }
    await legacySnapshot(text+text);
    const beforeCalls=(await control({op:'metrics'})).exec_calls.length;
    if (!await ui.evaluate(`Boolean(document.querySelector('[aria-label="exec 命令"]'))`)) await ui.click('exec 任务');
    const legacyTask=await runExec(text,'COMPLETED');
    await ui.waitFor(`Array.from(document.querySelectorAll('[aria-label="exec 输出"] [data-stream="stdout"]')).map(x=>x.textContent).join('')===${JSON.stringify(text)} && Array.from(document.querySelectorAll('[aria-label="exec 输出"] [data-stream="stderr"]')).map(x=>x.textContent).join('')===${JSON.stringify(text)}`);
    assert.deepEqual((await control({op:'metrics'})).exec_calls.slice(beforeCalls),[raw]);
    assert.equal((await getStatus()).encoding,encoding);
    if(encoding==='gbk') {
      await ui.fill('exec 命令','𐀀');await ui.click('启动 exec 任务');
      await ui.waitFor(`document.querySelector('.exec-panel [role="status"]').textContent.includes('无法用连接编码表示')`);
      assert.equal((await control({op:'metrics'})).exec_calls.length,beforeCalls+1);
      await runExec('gbk-tail','COMPLETED');
      await ui.waitFor(`document.querySelector('[aria-label="exec 输出"]').textContent==='�' && document.querySelector('.exec-panel [role="alert"]').textContent.includes('U+FFFD')`);
    }
    const callsBeforeReload=(await control({op:'metrics'})).exec_calls.length;
    await ui.evaluate(`window.__legacyReloadProbe=true`);await ui.command('Page.reload');
    await ui.waitFor(`window.__legacyReloadProbe===undefined && document.querySelector('footer')?.textContent.includes('服务 ') && Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(scope.connection_id)})`);
    await ui.fill('会话',scope.connection_id);
    await legacySnapshot(text+text);
    assert.equal((await getStatus()).encoding,encoding);
    assert.equal((await control({op:'metrics'})).exec_calls.length,callsBeforeReload,'reload does not replay');
    await ui.click('exec 任务');await ui.fill('查询 exec 任务 ID',legacyTask);await ui.click('查询 exec 任务');
    await ui.waitFor(`Array.from(document.querySelectorAll('[aria-label="exec 输出"] [data-stream="stdout"]')).map(x=>x.textContent).join('')===${JSON.stringify(text)} && Array.from(document.querySelectorAll('[aria-label="exec 输出"] [data-stream="stderr"]')).map(x=>x.textContent).join('')===${JSON.stringify(text)}`);
    assert.equal((await control({op:'metrics'})).exec_calls.length,callsBeforeReload,'legacy result query does not rerun');
    await ui.click('SSH2 连接');await state('CONNECTED');
    if(encoding==='gbk') {
      const beforeRejected=(await control({op:'metrics'})).received.flat().length;
      await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);await ui.command('Input.insertText',{text:'𐀀'});
      await ui.waitFor(`document.querySelector('.status').textContent.includes('无法用连接编码表示')`);
      assert.equal((await control({op:'metrics'})).received.flat().length,beforeRejected);
    }
    await ui.screenshot(`desktop-ssh-${encoding}-synthetic.png`);
    await ui.click('关闭 SSH2 连接');await state('DISCONNECTED');
    await ui.click('显式重连 SSH2');await waitButton('提交本次 SSH2 密码');
    await ui.fill('SSH2 临时密码',server.password);await ui.click('提交本次 SSH2 密码');await state('CONNECTED');
    const restarted=(await ui.invoke('service_list')).find(item=>item.connection_id===scope.connection_id);
    assert.equal(restarted.generation,scope.generation+1);
    assert.equal((await ui.invoke('ssh_request',{request:{op:'status',connection:{connection_id:restarted.connection_id,generation:restarted.generation}}})).encoding,'utf8');
    const staleText=await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('ssh_request',${JSON.stringify({request:{op:'write_text',connection:scope,request_id:crypto.randomUUID(),text:'stale'}})}).then(()=>null,e=>String(e))`);
    assert.equal(staleText,'StaleGeneration');
    if (encoding === 'gb18030') {
      // P11.6: actual SSH bytes through the shared dispatcher, plus system clipboard.
      await control({op:'push',text:'\r\nCOPY_中文_123\r\n'});
      await legacySnapshot('COPY_中文_123');
      const pasteEvent=text=>ui.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);
      let before=(await control({op:'metrics'})).received.flat().length;
      await pasteEvent('SSH甲\r\nSSH乙\n');await ui.waitFor(`!!document.querySelector('[aria-label="粘贴确认"]')`);
      await delay(150);assert.equal((await control({op:'metrics'})).received.flat().length,before);
      await ui.click('确认发送粘贴');
      for(let i=0;i<100 && (await control({op:'metrics'})).received.flat().length===before;i++)await delay(30);
      assert.equal(Buffer.from((await control({op:'metrics'})).received.flat().slice(before)).toString(),'SSH甲\r\nSSH乙\n');
      before=(await control({op:'metrics'})).received.flat().length;
      await ui.click('查找终端');await ui.fill('终端查找文字','COPY_中文_123');await ui.click('下一个匹配');
      await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent.includes('1 / 1')`);
      await ui.command('Page.bringToFront');await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
      const ctrlC=async()=>{await ui.command('Input.dispatchKeyEvent',{type:'keyDown',modifiers:2,key:'c',code:'KeyC',windowsVirtualKeyCode:67});await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',windowsVirtualKeyCode:67});};
      await ctrlC();await ui.waitFor(`document.querySelector('[aria-label="剪贴板状态"]').textContent==='终端选区已复制'`);
      assert.equal((await control({op:'metrics'})).received.flat().length,before,'Ctrl+C with selection copies without interrupting');
      const clickPaste=async()=>{
      const pasteButton=await ui.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='粘贴到终端');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...pasteButton});
      await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...pasteButton});await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...pasteButton});
      };
      const lateRead=await ui.interceptIpc({command:'terminal_clipboard_read',op:undefined,mode:'delay',delayMs:700});
      try {
        await clickPaste();for(let i=0;i<100 && !(await lateRead.count());i++)await delay(20);
        assert.equal(await lateRead.count(),1,'real native clipboard response must be delayed once');
        await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);await ui.command('Input.insertText',{text:'z'});await delay(850);
        assert.equal(Buffer.from((await control({op:'metrics'})).received.flat().slice(before)).toString(),'z','typed takeover discards late native read');
      } finally { await lateRead.restore(); }
      before=(await control({op:'metrics'})).received.flat().length;
      await clickPaste();
      for(let i=0;i<100 && (await control({op:'metrics'})).received.flat().length===before;i++)await delay(30);
      assert.equal(Buffer.from((await control({op:'metrics'})).received.flat().slice(before)).toString(),'COPY_中文_123','system clipboard read uses the actual copied selection');
      before=(await control({op:'metrics'})).received.flat().length;
      await ui.click('关闭查找');await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);await ctrlC();
      for(let i=0;i<100 && (await control({op:'metrics'})).received.flat().length===before;i++)await delay(30);
      assert.deepEqual((await control({op:'metrics'})).received.flat().slice(before),[3],'Ctrl+C without selection preserves SSH interrupt byte');
    }

    await ui.click('关闭 SSH2 连接');await state('DISCONNECTED');await ui.click('移除连接记录');
    await ui.waitFor(`document.querySelector('.status').textContent.includes('尚无活动连接')`);
  }
  await ui.close();ui=null;
  console.log('PASS SSH2 native WebView: trust/reject/changed key, wrong/temporary password, DPAPI key, keyboard challenge, FIFO input/resize, bounded exec/exit/signal/timeout/cancel/gaps, exit/disconnect, legacy GBK/GB18030 strict text and split exec streams, frozen codec/reload without replay');
} catch (error) {
  console.error('SSH status at failure:', await ui?.evaluate(`JSON.stringify({ssh:document.querySelector('[aria-label="SSH2 状态"]')?.textContent,message:document.querySelector('.ssh-panel [role="status"]')?.textContent,main:document.querySelector('.status')?.textContent,clipboard:document.querySelector('[aria-label="剪贴板状态"]')?.textContent})`));
  if(ui)console.error('authoritative connections:',await ui.invoke('service_list').catch(()=> 'unavailable'));
  throw error;
} finally {
  await ui?.close(); fixture.stdin.end();if(fixture.exitCode===null)fixture.kill();
  for(let attempt=0;attempt<100 && fixture.exitCode===null && fixture.signalCode===null;attempt++)await delay(50);
  assert.ok(fixture.exitCode!==null || fixture.signalCode!==null);
  const target=path.resolve(directory); assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-ssh-ui-'));
  await rm(target,{recursive:true,force:true});
}
