import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

let directory,saveDirectory,ui,fixture,stall;const sockets=new Set();const loggingOnly=process.argv.includes('--logging-only');
const wait=async(check,label,attempts=300)=>{for(let i=0;i<attempts;i++){if(await check())return;await delay(100);}throw new Error(`Timed out: ${label}`);};
try {
 scenario: {
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-quick-ssh-ui-中文-'));
  saveDirectory=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));const output=path.join(saveDirectory,'文本日志');await mkdir(output);
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
  const next=async()=>{let timer;try{return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
  const server=await next(),control=async request=>{fixture.stdin.write(JSON.stringify(request)+'\n');return next();};
  ui=await launchDesktop(directory,{fixture:true});
  const ssh=request=>ui.invoke('ssh_request',{request}),logging=request=>ui.invoke('logging_request',{request});
  const configuration=()=>ui.invoke('config_request',{request:{op:'page',revision:null,offset:0,folders:false}});
  const native=async(action,target)=>new Promise((resolve,reject)=>{const child=spawn('pwsh',['-NoProfile','-File','scripts/lib/NativeSaveDialog.ps1','-TargetProcessId',String(ui.app.pid),'-Action',action,...(target?['-TargetPath',target]:[])],{windowsHide:true});let text='';child.stdout.on('data',d=>text+=d);child.stderr.on('data',d=>text+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve(text):reject(new Error(text)));});
  const show=()=>ui.click('连接服务器');
  const fill=async(port=server.port)=>{await ui.fill('SSH服务器','127.0.0.1');await ui.fill('SSH用户名','synthetic');await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='高级连接设置').parentElement.open=true`);await ui.fill('SSH端口',port);};
  const connected=()=>wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('已连接')`),'quick SSH connected');
  const current=async()=>{const list=await ui.invoke('service_list');const selected=await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`);const c=list.find(c=>c.connection_id===selected);return {connection_id:c.connection_id,generation:c.generation};};
  assert.equal((await configuration()).profiles.length,0);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='连接服务器').getBoundingClientRect().height>0`),true);
  assert.equal(await ui.evaluate(`document.querySelector('.tools-menu').open`),false);
  await show();await fill();assert.equal(await ui.evaluate(`document.querySelector('[aria-label="保存SSH连接"]').checked`),false);
  await ui.fill('SSH登录密码',server.password);await ui.click('连接');
  await ui.waitFor(`!!document.querySelector('[aria-label="快速连接核对指纹"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').checked`),false);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='信任并继续登录').disabled`),true);
  assert.equal((await control({op:'metrics'})).attempts,0);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH快速连接"] .fingerprint').textContent`),server.pin);
  await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').click()`);await ui.click('信任并继续登录');await connected();
  const first=await current();
  assert.equal((await configuration()).profiles.length,0,'temporary quick connection must not secretly persist a Profile');
  assert.equal((await ui.invoke('config_request',{request:{op:'credentials_page',revision:null,offset:0}})).entries.length,0);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH登录密码"]').value`),'');
  await wait(async()=>await ui.evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`),'terminal receives focus');
  await ui.command('Input.insertText',{text:'S1中文'});await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  await wait(async()=>Buffer.from((await control({op:'metrics'})).received.flat()).toString().includes('S1中文\r'),'real terminal input reaches same actor');
  // Real paste event / preview, rather than a direct service write.
  await ui.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify('PASTE一\nPASTE二')});document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  await ui.waitFor(`!!document.querySelector('[aria-label="粘贴确认"]')`);await ui.click('确认发送粘贴');
  await wait(async()=>Buffer.from((await control({op:'metrics'})).received.flat()).toString().includes('PASTE一\nPASTE二'),'pasted text is exact');
  await ui.click('收起连接窗口');await ui.click('终端日志');await ui.click('开始记录终端');
  let log;await wait(async()=>{log=(await logging({op:'list',connection:first})).logs.find(l=>l.active);return log?.phase==='RECORDING';},'logging started');
  const marker='SSH日志 中文\r\n第二行\r\n';await control({op:'push',text:marker});
  await wait(async()=>{const r=await logging({op:'status',connection:first,log_id:log.log_id});return r.written_raw_bytes>=Buffer.byteLength(marker);},'actual output written');
  await ui.click('停止记录终端');await wait(async()=>{const r=await logging({op:'status',connection:first,log_id:log.log_id});return r.phase==='STOPPED'&&r.durable&&r.worker_finished;},'log stop and sync');
  await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='查看日志').disabled`);await ui.click('查看日志');await ui.waitFor(`document.querySelector('[aria-label="本次日志文本"]')?.textContent.includes('SSH日志 中文')`);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="基础日志保存目录"]').textContent`)).includes(directory));
  await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存日志').disabled`);
  const selected=path.join(output,'SSH通信记录.log');await ui.click('保存日志');await native('select',selected);
  await ui.waitFor(`document.querySelector('[aria-label="文本导出另存状态"]')?.textContent.includes('本次另存已完成')`);
  const textScope=JSON.parse(await ui.evaluate(`sessionStorage.getItem('terminal-text-log-task-v1')`));
  const prepared=await logging({op:'text_export_status',...textScope});assert.equal(prepared.phase,'COMPLETED');
  assert.equal((await logging({op:'text_export_start',...textScope})).sha256,prepared.sha256);
  await assert.rejects(logging({op:'export_status',...textScope}));await assert.rejects(logging({op:'recovery_export_status',...textScope}));
  const managed=await readFile(path.join(directory,'terminal-log-exports',textScope.request_id,'export.jsonl'));
  const managedText=managed.toString('utf8');assert.ok(managedText.includes(marker));assert.ok(managedText.startsWith('# 终端通信日志 UTF-8'));
  assert.ok(!managedText.includes(server.password),'authentication form secret is not logged');
  assert.equal(createHash('sha256').update(managed).digest('hex'),prepared.sha256);
  assert.deepEqual(await readFile(selected),managed);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='查询保存结果')`),false,'normal save has no query task controls');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="文本另存固定目标"]').closest('details').open`),false,'internal task identifiers stay folded');
  await ui.click('保存日志');await native('select',selected);await ui.waitFor(`!!document.querySelector('[aria-label="文本确认替换保存文件"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="文本确认替换保存文件"]').checked`),false);assert.deepEqual(await readFile(selected),managed);await ui.click('取消保存');await ui.waitFor(`document.querySelector('[aria-label="文本导出另存状态"]')?.textContent.includes('另存已取消')`);assert.deepEqual(await readFile(selected),managed);
  await ui.click('保存日志');await native('select',selected);await ui.waitFor(`!!document.querySelector('[aria-label="文本确认替换保存文件"]')`);await ui.evaluate(`document.querySelector('[aria-label="文本确认替换保存文件"]').click()`);await ui.click('确认替换并保存');await ui.waitFor(`document.querySelector('[aria-label="文本导出另存状态"]')?.textContent.includes('本次另存已完成')`);
  const backup=await ui.evaluate(`document.querySelector('[aria-label="文本另存原文件备份"]').value`);assert.deepEqual(await readFile(backup),managed);assert.deepEqual(await readFile(selected),managed);
  const saveLost=await ui.interceptIpc({command:'export_save_request',op:'start',mode:'error'});await ui.click('保存日志');await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='查询保存结果')`);assert.equal(await saveLost.count(),1);await saveLost.restore();
  const queriedFile=path.join(output,'应答丢失后只查.log');await native('select',queriedFile);const originalSave=JSON.parse(await ui.evaluate(`sessionStorage.getItem('terminal-text-log-save-v1')`));await ui.click('查询保存结果');await ui.waitFor(`document.querySelector('[aria-label="文本导出另存状态"]')?.textContent.includes('本次另存已完成')`);assert.deepEqual(await readFile(queriedFile),managed);assert.equal(JSON.parse(await ui.evaluate(`sessionStorage.getItem('terminal-text-log-save-v1')`)).save_id,originalSave.save_id);
  await ui.screenshot('P12.1-quick-ssh-logging.png');
  if(loggingOnly){await writeFile('artifacts/P12.1-simple-log-result.json',JSON.stringify({result:'PASS',oneClickSave:true,textBytes:managed.length,sha256:prepared.sha256,nativeFileExact:true,overwriteDefaultOff:true,cancelPreservesFile:true,backupExact:true,realFetchLostSaveReply:1,queryRetainsSaveId:true,internalIdsFolded:true},null,2)+'\n');console.log('PASS simple SSH log: one Save action to actual native picker, exact UTF8 file, explicit replacement/cancel/backup, real lost save reply original query, internal task IDs folded');break scenario;}
  await ui.click('关闭日志面板');await show();await connected();await ui.click('断开连接');await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('连接已断开')`),'disconnect');
  await ui.click('重新连接');await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='提交本次登录信息')`);
  await ui.fill('SSH登录密码','wrong-synthetic-password');await ui.click('提交本次登录信息');await ui.waitFor(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.includes('未被服务器接受')`);
  await ui.fill('SSH登录密码',server.password);await ui.click('提交本次登录信息');await connected();
  const restarted=await current();assert.equal(restarted.connection_id,first.connection_id);assert.equal(restarted.generation,first.generation+1);
  await ui.click('断开连接');await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('连接已断开')`),'disconnected before key');
  await ui.fill('SSH登录方式','public_key');await fill();await ui.fill('SSH密钥文件',server.key_path);await ui.fill('SSH密钥口令',server.password);
  const before=(await ui.invoke('service_list')).length;
  const lost=await ui.interceptIpc({command:'ssh_request',op:'quick_start',mode:'error'});await ui.click('连接');await ui.waitFor(`document.querySelector('[aria-label="SSH快速提示"]')?.textContent.includes('结果不明')`);assert.equal(await lost.count(),1);await lost.restore();
  await ui.click('查询本次连接');await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='提交本次登录信息')`);await ui.fill('SSH密钥口令',server.password);await ui.click('提交本次登录信息');await connected();
  assert.equal((await ui.invoke('service_list')).length,before+1,'lost reply query never creates a second connection');assert.equal((await configuration()).profiles.length,0);
  assert.equal((await ui.invoke('config_request',{request:{op:'credentials_page',revision:null,offset:0}})).entries.length,0,'temporary encrypted key is not saved to Vault');
  await ui.click('断开连接');await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('连接已断开')`),'key disconnected');
  await ui.fill('SSH登录方式','password');await ui.fill('SSH登录密码',server.password);await ui.evaluate(`document.querySelector('[aria-label="保存SSH连接"]').click()`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="记住SSH凭据"]').checked`),false);await ui.click('连接');await connected();
  const profiles=(await configuration()).profiles;assert.equal(profiles.length,1);assert.equal(profiles[0].credential_ref,null);
  await ui.click('断开连接');await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('连接已断开')`),'saved disconnected');
  await ui.click('收起连接窗口');await show();await ui.waitFor(`document.querySelector('[aria-label="快速连接已保存"]')?.options.length===2`);await ui.fill('快速连接已保存',profiles[0].id);await ui.fill('SSH登录密码',server.password);await ui.click('连接');await connected();
  await ui.screenshot('P12.1-quick-ssh-connected.png');
  // Own loopback stall: cancellation and timeout exercise real transport futures.
  await ui.click('断开连接');await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('连接已断开')`),'saved connection closed');
  stall=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>stall.listen(0,'127.0.0.1',resolve));
  await ui.fill('快速连接已保存','');await fill(stall.address().port);await ui.click('连接');await wait(()=>sockets.size>0,'stall socket accepted');await ui.click('取消连接');
  await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.startsWith('连接已断开')`),'pending connection cancelled');
  // Production handshake includes 15s transport + 120s human identity decision.
  await ui.click('连接');await wait(async()=>await ui.evaluate(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.includes('连接超时')`),'transport timeout feedback',1550);
  // Replace only the owned fixture at its owned port: actual host identity change.
  fixture.kill();await new Promise(resolve=>fixture.once('exit',resolve));
  const changedDirectory=path.join(directory,'changed-host');await mkdir(changedDirectory);
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[changedDirectory,String(server.port)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const changedLines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
  const changed=JSON.parse((await changedLines.next()).value);assert.notEqual(changed.pin,server.pin);
  await fill(server.port);await ui.fill('SSH登录密码',changed.password);await ui.click('连接');await ui.waitFor(`document.querySelector('[aria-label="SSH快速连接"]')?.textContent.includes('服务器指纹已变化')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').checked`),false);await ui.click('拒绝连接');await ui.waitFor(`document.querySelector('[aria-label="SSH快速状态"]')?.textContent.includes('未信任此服务器')`);
  await writeFile('artifacts/P12.1-quick-ssh-result.json',JSON.stringify({result:'PASS',first,restarted,temporaryProfiles:0,temporaryCredentials:0,encryptedKey:true,realFetchLostReply:1,paste:true,textExport:{bytes:managed.length,sha256:prepared.sha256,userFileExact:true},savedConnection:true,scope:'synthetic loopback SSH; actual user server/real DPI/serial not tested'},null,2)+'\n');
  console.log('PASS quick SSH: visible entry/no saved Profile, single-flow host/password/key auth, terminal focus and exact Chinese input/paste, reconnect and wrong-password recovery, lost Start reply original query, optional save, live capture/readable text/real native save; synthetic only');
 }
} catch(error){
  if(ui){await ui.screenshot('P12.1-quick-ssh-failure.png').catch(()=>{});await writeFile('artifacts/P12.1-quick-ssh-failure.txt',await ui.evaluate(`document.body.innerText`).catch(String));}throw error;
} finally {
  await ui?.close();fixture?.kill();if(fixture&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(resolve=>fixture.once('exit',resolve));
  for(const socket of sockets)socket.destroy();if(stall)await new Promise(resolve=>stall.close(resolve));
  for(const [value,prefix] of [[directory,'shared-terminal-quick-ssh-ui-中文-'],[saveDirectory,'shared-terminal-save-ui-中文-']])if(value){const target=path.resolve(value);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith(prefix));await rm(target,{recursive:true,force:true});}
}
