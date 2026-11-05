import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-recovery-ui-中文-'));
const saveDirectory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-save-ui-中文-'));
let ui;
const request = value => ui.invoke('logging_request', { request: value });
const native = (action, target) => new Promise((resolve,reject) => {
  const child=spawn('pwsh',['-NoProfile','-File','scripts/lib/NativeSaveDialog.ps1','-TargetProcessId',String(ui.app.pid),'-Action',action,...(target?['-TargetPath',target]:[])],{windowsHide:true});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(output)));
});
const ref = connection => ({ connection_id: connection.connection_id, generation: connection.generation });
const file = (id, name) => path.join(directory, 'terminal-logs', id, name);
const textFile = id => file(id, '0000000000000001.text.jsonl');
async function releaseCheck(id) {
  for (let n=0;n<100;n++) {
    try { const handle = await open(textFile(id),'r+'); await handle.close(); return; } catch { await delay(30); }
  }
  throw new Error('recovery file handle must be released');
}
async function capture(target, chunks) {
  const started = await request({op:'start',connection:target,request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
  for (const text of chunks) await ui.invoke('fixture_append', {connection:target,bytes:[...Buffer.from(text)]});
  await request({op:'stop',connection:target,log_id:started.log_id});
  for (let n=0;n<300;n++) { const value = await request({op:'status',connection:target,log_id:started.log_id}); if(value.worker_finished){assert.equal(value.durable,true);return started;}await delay(20); }
  throw new Error('synthetic capture did not settle');
}
async function panel() {
  await ui.click('终端日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);
  await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true; document.querySelector('[aria-label="失败日志恢复工具"]').open=true`);
  await ui.waitFor(`!!document.querySelector('[aria-label="恢复读取面板"]')`);
  await ui.click('刷新恢复目录');
  await ui.waitFor(`!document.querySelector('[aria-label="恢复日志选择"]').disabled`);
}
async function select(id) {
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="恢复日志选择"]').options).some(o=>o.value===${JSON.stringify(id)})`);
  await ui.fill('恢复日志选择',id);
  await ui.waitFor(`!document.querySelector('[aria-label="恢复日志选择"]').disabled && document.querySelector('[aria-label="恢复日志目标"]')?.textContent.includes(${JSON.stringify(id)})`);
}
async function status(text) { await ui.waitFor(`document.querySelector('[aria-label="恢复读取状态"]')?.textContent.includes(${JSON.stringify(text)})`); }
try {
  ui = await launchDesktop(directory,{fixture:true});
  await ui.click('新建合成会话');
  const [connection] = await ui.invoke('service_list'); const target = ref(connection);
  const first = await capture(target,['FIRST中文\0\x1b[31m<img id="RECOVERY_LITERAL" src="x">\u202e','SECOND-visible','LAST-truncated']);
  const long = await capture(target,Array.from({length:9},(_,i)=>`ROW-${i}-`+'x'.repeat(4080)));
  const invalid = await capture(target,['preserve-bad-header']);
  await ui.close(); ui = undefined;
  // Only the newly created Chinese-prefixed fixture root is modified.
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('shared-terminal-recovery-ui-中文-'));
  await rm(file(first.log_id,'completion.json'));
  const firstText = await readFile(textFile(first.log_id));
  await writeFile(textFile(first.log_id),firstText.subarray(0,firstText.length-1));
  await writeFile(textFile(invalid.log_id),'bad header\n');
  const rawBefore = await readFile(file(first.log_id,'0000000000000001.rawlog'));
  const textBefore = await readFile(textFile(first.log_id));
  ui = await launchDesktop(directory,{fixture:true});
  assert.deepEqual(await ui.invoke('service_list'),[]);
  await ui.click('新建合成会话');
  const [active] = await ui.invoke('service_list');
  const before = await ui.invoke('service_read',{connection:ref(active),cursor:1});
  // Dedicated Tauri logging channel, with real service publication; the UI
  // recovery export/save controls are not inferred from this channel check.
  const exportId=crypto.randomUUID();
  const exportScope={connection:target,log_id:first.log_id,request_id:exportId};
  await request({op:'recovery_export_start',...exportScope});
  let exported;
  for(let n=0;n<200;n++){
    exported=await request({op:'recovery_export_status',...exportScope});
    assert.equal(exported.result,'recovery_export');assert.equal(exported.incomplete,true);
    if(exported.phase==='COMPLETED')break;
    assert.ok(['QUEUED','RUNNING','CANCELLING'].includes(exported.phase));await delay(20);
  }
  assert.equal(exported.phase,'COMPLETED');assert.equal(exported.recovered.recovered_records,2);
  assert.equal(exported.recovered.stop.kind,'TRUNCATED_RECORD');
  const recoveredBytes=await readFile(path.join(directory,'terminal-log-exports',exportId,'export.jsonl'));
  assert.equal(exported.bytes,recoveredBytes.length);
  assert.equal(exported.sha256,createHash('sha256').update(recoveredBytes).digest('hex'));
  const exportedRows=recoveredBytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(exportedRows[0].format,'shared-terminal-recovery-export');
  assert.equal(exportedRows.at(-1).type,'recovery_stopped');assert.equal(exportedRows.at(-1).incomplete,true);
  assert.ok(exportedRows.every(row=>row.type!=='verified'));
  assert.deepEqual(await request({op:'recovery_export_start',...exportScope}),exported);
  assert.deepEqual(await request({op:'recovery_export_cancel',...exportScope}),exported);
  await assert.rejects(request({op:'export_status',...exportScope}));
  const forbiddenSaveId=crypto.randomUUID();
  const saveResult=async op=>ui.evaluate(`window.__TAURI_INTERNALS__.invoke('export_save_request',${JSON.stringify({request:{op,scope:{...exportScope,mode:'NORMAL'},save_id:forbiddenSaveId}})}).then(()=>({ok:true}),error=>({error:String(error)}))`);
  assert.deepEqual(await saveResult('start'),{error:'InvalidArgument'},'ordinary save cannot accept a recovery source');
  assert.deepEqual(await saveResult('status'),{error:'NOT_FOUND'},'rejected source must not reserve a save job or open the picker');
  assert.deepEqual(await request({op:'recovery_export_status',...exportScope}),exported);
  const nativeScope={...exportScope,mode:'RECOVERY'};
  const saveId=crypto.randomUUID();
  const nativeSave=(op,scope=nativeScope,extra={})=>ui.invoke('export_save_request',{request:{op,scope,save_id:saveId,...extra}});
  assert.equal((await nativeSave('start')).phase,'CHOOSING');
  assert.equal((await nativeSave('start')).scope.mode,'RECOVERY');
  for(const op of ['start','status','cancel','confirm','open_directory']) {
    await assert.rejects(nativeSave(op,{...nativeScope,mode:'NORMAL'},op==='confirm'?{confirmation:crypto.randomUUID()}:{}));
  }
  assert.equal((await nativeSave('status')).cancel_requested,false,'cross-mode cancellation must not affect recovery save');
  await nativeSave('cancel');await native('cancel');
  for(let n=0;n<100;n++){if((await nativeSave('status')).phase==='CANCELLED')break;await delay(30);}
  assert.equal((await nativeSave('start')).phase,'CANCELLED','duplicate does not reopen a cancelled picker');
  assert.deepEqual(await request({op:'recovery_export_status',...exportScope}),exported);
  await panel();
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="恢复日志选择"]').value`),'','refresh must not choose target');
  await select(invalid.log_id);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='打开只读恢复').disabled`),true);
  await select(first.log_id);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复日志目标"]').textContent`)).includes(connection.connection_id));
  await ui.click('打开只读恢复'); await status('记录尾部截断');
  const firstPreview = await ui.evaluate(`document.querySelector('[aria-label="恢复日志内容"]').textContent`);
  assert.ok(firstPreview.includes('FIRST中文\\x00\\x1b[31m<img'));
  assert.ok(firstPreview.includes('SECOND-visible'));
  assert.ok(!firstPreview.includes('LAST-truncated'));
  assert.ok(firstPreview.includes('\\u202e'));
  assert.equal(await ui.evaluate(`!!document.getElementById('RECOVERY_LITERAL')`),false);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复分页范围"]').textContent`)).includes('2 条'));
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='读取恢复下一页').disabled`),true);
  await assert.rejects(open(textFile(first.log_id),'r+'));
  await ui.evaluate(`document.querySelector('[aria-label="恢复显示HEX"]').click()`);
  await ui.waitFor(`document.querySelector('[aria-label="恢复日志内容"]').textContent.includes('46 49 52 53 54')`);
  await ui.evaluate(`document.querySelector('[aria-label="恢复显示HEX"]').click()`);
  assert.deepEqual(await ui.invoke('service_read',{connection:ref(active),cursor:1}),before,'recovery must never append to active session');
  await ui.screenshot('desktop-recovery-prefix-synthetic.png');
  await ui.click('停止并关闭恢复读取'); await status('恢复读取已关闭'); await releaseCheck(first.log_id);
  await ui.waitFor(`document.activeElement?.textContent==='打开只读恢复'`);
  // Actual recovery export controls: lose the real Start response, then query
  // the same ID. No renderer-level invoke replacement or automatic restart.
  const exportKey='terminal-log-recovery-export-task-v1';
  const exportState=()=>ui.evaluate(`document.querySelector('[aria-label="恢复导出状态"]')?.textContent`);
  const exportReady=()=>ui.waitFor(`document.querySelector('[aria-label="恢复导出状态"]')?.textContent.includes('未完整前缀文件已保存到应用目录')`);
  const lostExport=await ui.interceptIpc({op:'recovery_export_start',mode:'error'});
  await ui.click('导出未完整恢复前缀');
  await ui.waitFor(`document.querySelector('[aria-label="恢复导出状态"]')?.textContent.includes('仅查询结果')`);
  assert.equal(await lostExport.count(),1);await lostExport.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复导出文件路径"]')`),false);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='导出未完整恢复前缀').disabled`),true);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='停止恢复导出').disabled`),true,'unknown outcome permits only status queries');
  const savedSlot=JSON.parse(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify(exportKey)})`));
  assert.equal(savedSlot.mode,'RECOVERY');assert.equal(savedSlot.log_id,first.log_id);
  assert.deepEqual(Object.keys(savedSlot).sort(),['connection','log_id','mode','request_id']);
  await ui.click('查询恢复导出结果');await exportReady();
  const guiScope={connection:savedSlot.connection,log_id:savedSlot.log_id,request_id:savedSlot.request_id};
  const guiReceipt=await request({op:'recovery_export_status',...guiScope});
  const guiPath=await ui.evaluate(`document.querySelector('[aria-label="恢复导出文件路径"]').value`);
  assert.equal(guiPath,path.join(directory,'terminal-log-exports',guiScope.request_id,'export.jsonl'));
  const guiBytes=await readFile(guiPath);
  assert.equal(guiReceipt.sha256,createHash('sha256').update(guiBytes).digest('hex'));assert.equal(guiReceipt.bytes,guiBytes.length);
  const guiRows=guiBytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(guiRows[0].incomplete,true);assert.equal(guiRows.at(-1).type,'recovery_stopped');
  assert.equal(guiRows.at(-1).recovered.recovered_records,2);assert.equal(guiRows.at(-1).recovered.stop.kind,'TRUNCATED_RECORD');
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复导出范围"]').textContent`)).includes('未完整'));
  // Recovery GUI uses its own ID-only slot and the real native picker. The
  // selected path is confined to a separate self-created save-test root.
  const saveKey='terminal-recovery-export-save-v1';
  const savedTask=async()=>JSON.parse(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify(saveKey)})`));
  const saveState=text=>ui.waitFor(`document.querySelector('[aria-label="恢复导出另存状态"]')?.textContent.includes(${JSON.stringify(text)})`);
  const saveRequest=(op,task,extra={})=>ui.invoke('export_save_request',{request:{op,...task,...extra}});
  const pickRecovery=async target=>{await ui.click('另存未完整恢复文件');await native('select',target);return savedTask();};
  const savedPath=path.join(saveDirectory,'未完整前缀.jsonl');
  const lostSave=await ui.interceptIpc({command:'export_save_request',op:'start',mode:'error'});
  const saved=await pickRecovery(savedPath);await saveState('保留原任务编号');
  assert.equal(await lostSave.count(),1);await lostSave.restore();
  assert.equal(saved.scope.mode,'RECOVERY');assert.equal(saved.scope.request_id,guiScope.request_id);
  assert.deepEqual(Object.keys(saved).sort(),['save_id','scope']);
  assert.equal(await ui.evaluate(`sessionStorage.getItem('terminal-export-save-v1')`),null,'recovery must not overwrite ordinary slot');
  for(const text of ['另存未完整恢复文件','恢复取消另存'])assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).disabled`),true);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复另存文件路径"]')`),false);
  await ui.click('恢复查询另存结果');await saveState('本次另存已完成');
  assert.deepEqual(await readFile(savedPath),guiBytes);
  assert.equal(createHash('sha256').update(await readFile(savedPath)).digest('hex'),guiReceipt.sha256);
  assert.equal((await saveRequest('start',saved)).phase,'COMPLETED');
  assert.equal((await saveRequest('cancel',saved)).phase,'COMPLETED','late cancel cannot undo publication');
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复导出另存状态"]').textContent`)).includes('未完整'));
  await ui.evaluate(`document.querySelector('[aria-label="恢复导出另存"]').scrollIntoView({block:'end'})`);
  await ui.screenshot('desktop-recovery-save-completed-synthetic.png');
  await ui.click('恢复打开保存目录');await native('explorer',saveDirectory);
  const replacement=path.join(saveDirectory,'保留原文件.jsonl');await writeFile(replacement,'original recovery-save target');
  const replaceTask=await pickRecovery(replacement);await saveState('等待明确替换确认');
  assert.equal(await readFile(replacement,'utf8'),'original recovery-save target');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='恢复确认替换并保存').disabled`),true);
  await select(long.log_id);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复另存固定目标"]').textContent`)).includes(first.log_id));
  await ui.evaluate(`document.querySelector('[aria-label="恢复确认替换保存文件"]').click()`);
  await ui.evaluate(`document.querySelector('[aria-label="恢复导出另存"]').scrollIntoView({block:'end'})`);
  await ui.screenshot('desktop-recovery-save-confirm-synthetic.png');
  await ui.click('恢复确认替换并保存');await saveState('本次另存已完成');
  const replaced=await saveRequest('status',replaceTask);
  assert.deepEqual(await readFile(replacement),guiBytes);assert.equal(await readFile(replaced.backup,'utf8'),'original recovery-save target');
  // A real reload while a confirmation exists does not restore consent or path.
  const reloadTask=await pickRecovery(replacement);await saveState('等待明确替换确认');
  await ui.evaluate(`document.querySelector('[aria-label="恢复确认替换保存文件"]').click()`);
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);await panel();
  await saveState('已恢复另存编号');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复另存文件路径"]') || !!document.querySelector('[aria-label="恢复确认替换保存文件"]')`),false);
  assert.deepEqual(await savedTask(),reloadTask);
  await ui.click('恢复查询另存结果');
  await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='恢复查询另存结果').disabled`);
  const reloaded=await saveRequest('status',reloadTask);
  assert.ok(['AWAITING_CONFIRMATION','CANCELLED'].includes(reloaded.phase));
  if(reloaded.phase==='AWAITING_CONFIRMATION') {
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="恢复确认替换保存文件"]').checked`),false);
    await ui.click('恢复取消另存');await saveState('另存已取消');
  }
  assert.deepEqual(await readFile(replacement),guiBytes);
  await ui.click('查询恢复导出结果');await exportReady();
  // A lost status must hide the previously confirmed destination and allow only query.
  const lostSaveStatus=await ui.interceptIpc({command:'export_save_request',op:'status',mode:'error'});
  await ui.click('恢复查询另存结果');await saveState('保留原任务编号');
  assert.equal(await lostSaveStatus.count(),1);await lostSaveStatus.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复另存文件路径"]')`),false);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='恢复取消另存').disabled`),true);
  await ui.click('恢复查询另存结果');await saveState('另存已取消');
  const tampered=Buffer.from(guiBytes);tampered[0]^=1;await writeFile(guiPath,tampered);
  const refused=path.join(saveDirectory,'源变化不发布.jsonl');await pickRecovery(refused);await saveState('另存失败');
  await assert.rejects(readFile(refused));await writeFile(guiPath,guiBytes);
  // Start's real reply arrives after the recovery panel has been collapsed.
  const lateSave=await ui.interceptIpc({command:'export_save_request',op:'start',delayMs:500});
  await ui.click('另存未完整恢复文件');await ui.waitFor(`window.__desktopIpcResponseTest.count===1`);
  const lateSaveTask=await savedTask();
  await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open=false`);
  await native('cancel');await delay(650);assert.equal(await lateSave.count(),1);await lateSave.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复导出另存"]')`),false);
  await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open=true`);
  await ui.waitFor(`!!document.querySelector('[aria-label="恢复导出另存"]')`);await ui.click('恢复查询另存结果');await saveState('另存已取消');
  assert.deepEqual(await savedTask(),lateSaveTask);
  await ui.click('查询恢复导出结果');await exportReady();
  assert.deepEqual(await readFile(savedPath),guiBytes);
  await ui.screenshot('desktop-recovery-save-synthetic.png');
  await ui.click('刷新恢复目录');
  await select(long.log_id);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复导出任务目标"]').textContent`)).includes(first.log_id),'selection cannot retarget completed task');
  await ui.screenshot('desktop-recovery-export-synthetic.png');
  // A real WebView reload restores only the recovery-mode ID and queries it.
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
  await panel();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复导出文件路径"]')`),false);
  assert.ok((await exportState()).includes('已恢复恢复导出编号'));
  await ui.click('查询恢复导出结果');await exportReady();
  assert.deepEqual(await request({op:'recovery_export_status',...guiScope}),guiReceipt);
  // A failed status response hides the old path until the same ID is queried.
  const lostStatus=await ui.interceptIpc({op:'recovery_export_status',mode:'error'});
  await ui.click('查询恢复导出结果');await ui.waitFor(`document.querySelector('[aria-label="恢复导出状态"]')?.textContent.includes('仅查询结果')`);
  assert.equal(await lostStatus.count(),1);await lostStatus.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复导出文件路径"]')`),false);
  await ui.click('查询恢复导出结果');await exportReady();
  // Real cleanup invalidates the artifact; query removes statistics and path.
  const cleanup={kind:'EXPORT',id:guiScope.request_id,preview_id:crypto.randomUUID()};
  const preview=await request({op:'cleanup_preview',...cleanup});
  const cleaned=await request({op:'cleanup_commit',...cleanup,confirmation:preview.confirmation});
  assert.equal(cleaned.report.directory_removed,true);assert.equal(cleaned.report.failure,null);
  await ui.click('查询恢复导出结果');await ui.waitFor(`document.querySelector('[aria-label="恢复导出状态"]')?.textContent.includes('不再可用')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复导出文件路径"]') || !!document.querySelector('[aria-label="恢复导出范围"]')`),false);
  assert.deepEqual(await readFile(savedPath),guiBytes,'managed cleanup must preserve the user-selected copy');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='另存未完整恢复文件').disabled`),true);
  // A late Start response after collapse must not resurrect UI or redirect a
  // cancellation. The same recovery ID remains queryable after reopening.
  await select(long.log_id);
  const lateExport=await ui.interceptIpc({op:'recovery_export_start',delayMs:500});
  await ui.click('导出未完整恢复前缀');await ui.waitFor(`window.__desktopIpcResponseTest.count===1`);
  const lateSlot=JSON.parse(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify(exportKey)})`));
  await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open=false`);
  await ui.waitFor(`!document.querySelector('[aria-label="恢复读取面板"]')`);
  await delay(650);assert.equal(await lateExport.count(),1);await lateExport.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复导出文件路径"]')`),false);
  await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open=true`);
  await ui.waitFor(`!!document.querySelector('[aria-label="恢复读取面板"]')`);
  await ui.click('查询恢复导出结果');
  await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='查询恢复导出结果').disabled`);
  const lateInfo=await request({op:'recovery_export_status',connection:lateSlot.connection,log_id:lateSlot.log_id,request_id:lateSlot.request_id});
  assert.ok(['COMPLETED','CANCELLED'].includes(lateInfo.phase));
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复导出任务目标"]').textContent`)).includes(lateSlot.request_id));
  await ui.click('刷新恢复目录');
  await select(long.log_id); await ui.click('打开只读恢复'); await status('本页前缀已验证');
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复日志内容"]').textContent`)).includes('ROW-0-'));
  await ui.click('读取恢复下一页');
  await ui.waitFor(`document.querySelector('[aria-label="恢复日志内容"]')?.textContent.includes('ROW-2-')`);
  assert.ok(!(await ui.evaluate(`document.querySelector('[aria-label="恢复日志内容"]').textContent`)).includes('ROW-0-'),'page replaces previous data');
  await ui.click('停止并关闭恢复读取'); await status('恢复读取已关闭');
  await ui.click('打开只读恢复'); await status('本页前缀已验证');
  const priorPage = await ui.evaluate(`document.querySelector('[aria-label="恢复日志内容"]').textContent`);
  const lostRead = await ui.interceptIpc({op:'recovery_read',mode:'error'});
  await ui.click('读取恢复下一页'); await status('未自动重开');
  assert.equal(await lostRead.count(),1); await lostRead.restore(); await releaseCheck(long.log_id);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="恢复日志内容"]').textContent`),priorPage,'lost reply cannot advance displayed data');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='读取恢复下一页').disabled`),true);
  // Real IPC read response delay: cancellation discards data and releases handles.
  const delayedRead = await ui.interceptIpc({op:'recovery_read',delayMs:500});
  await ui.click('打开只读恢复');
  await ui.waitFor(`window.__desktopIpcResponseTest.count===1`);
  await ui.click('停止并关闭恢复读取'); await status('恢复读取已关闭');
  await delay(650); assert.equal(await delayedRead.count(),1); await delayedRead.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复日志内容"]')`),false);
  await releaseCheck(long.log_id);
  // Open succeeded remotely, reply lost: catch closes original ID, no automatic reopen.
  const lostOpen = await ui.interceptIpc({op:'recovery_open',mode:'error'});
  await ui.click('打开只读恢复'); await status('未自动重开');
  assert.equal(await lostOpen.count(),1); await lostOpen.restore(); await releaseCheck(long.log_id);
  const delayedOpen = await ui.interceptIpc({op:'recovery_open',delayMs:500});
  await ui.click('打开只读恢复'); await ui.waitFor(`window.__desktopIpcResponseTest.count===1`);
  await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open=false`);
  await ui.waitFor(`!document.querySelector('[aria-label="恢复读取面板"]')`);
  await delay(650); assert.equal(await delayedOpen.count(),1); await delayedOpen.restore(); await releaseCheck(long.log_id);
  await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open=true`);
  await ui.waitFor(`!!document.querySelector('[aria-label="恢复读取面板"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="恢复日志选择"]').value`),'');
  await ui.click('刷新恢复目录'); await select(long.log_id); await ui.click('打开只读恢复'); await status('本页前缀已验证');
  for(let n=0;n<6;n++) {
    const done = await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='读取恢复下一页').disabled`);
    if(done)break;
    const old = await ui.evaluate(`document.querySelector('[aria-label="恢复分页范围"]').textContent`);
    await ui.click('读取恢复下一页');
    await ui.waitFor(`!document.querySelector('[aria-label="恢复日志选择"]').disabled && document.querySelector('[aria-label="恢复分页范围"]').textContent!==${JSON.stringify(old)}`);
  }
  await status('已到可见文件结尾');
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="恢复读取状态"]').textContent`)).includes('不代表日志完整'));
  await ui.screenshot('desktop-recovery-end-synthetic.png');
  // The known malformed fixture is explicitly deleted through the real cleanup
  // UI; its receipt invalidates old recovery caches and releases the other read.
  await ui.evaluate(`document.querySelector('[aria-label="日志清理工具"]').open=true`);
  await ui.fill('清理类别','LOG'); await ui.click('刷新清理目录');
  await ui.waitFor(`!document.querySelector('[aria-label="清理目标选择"]').disabled && Array.from(document.querySelector('[aria-label="清理目标选择"]').options).some(o=>o.value===${JSON.stringify(invalid.log_id)})`);
  await ui.fill('清理目标选择',invalid.log_id); await ui.click('预览清理文件');
  await ui.waitFor(`document.querySelector('[aria-label="日志清理状态"]')?.textContent.includes('文件清单已锁定')`);
  await ui.evaluate(`document.querySelector('[aria-label="确认清理文件"]').click()`);
  await ui.click('确认删除清单文件');
  await ui.waitFor(`document.querySelector('[aria-label="日志清理状态"]')?.textContent.includes('清理完成')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="恢复日志内容"]')`),false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="失败日志恢复工具"]').open`),false);
  await releaseCheck(long.log_id);
  await ui.click('关闭日志面板'); await releaseCheck(long.log_id);
  assert.deepEqual(await readFile(file(first.log_id,'0000000000000001.rawlog')),rawBefore);
  assert.deepEqual(await readFile(textFile(first.log_id)),textBefore);
  assert.deepEqual(await ui.invoke('service_read',{connection:ref(active),cursor:1}),before);
  console.log('PASS recovery native WebView: independent old-service target, missing marker/corrupt tail prefix, rejected header, text/HEX and escaped markup, bounded replacement pages, explicit incomplete end, stop/focus, GUI incomplete export and native recovery save/real picker/fingerprint/explicit backup/reload consent/lost responses/late collapse, lost Start/Status query-only recovery, reload IDs, removed paths, delayed export collapse, real lost/delayed reader responses and late close release; synthetic only');
} catch (error) {
  if(ui){console.error(await ui.evaluate(`({status:document.querySelector('[aria-label="恢复读取状态"]')?.textContent,range:document.querySelector('[aria-label="恢复分页范围"]')?.textContent,export:document.querySelector('[aria-label="恢复导出状态"]')?.textContent})`));await ui.screenshot('desktop-recovery-failure-synthetic.png');}
  throw error;
} finally {
  await ui?.close();
  const target = path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-recovery-ui-中文-'));
  await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  const saveRoot=path.resolve(saveDirectory);assert.equal(path.dirname(saveRoot),path.resolve(tmpdir()));assert.ok(path.basename(saveRoot).startsWith('shared-terminal-save-ui-中文-'));
  await rm(saveRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
