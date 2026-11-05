import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-export-ui-中文-'));
const key='terminal-log-export-task-v1';
let ui;
const request=value=>ui.invoke('logging_request',{request:value});
const ref=connection=>({connection_id:connection.connection_id,generation:connection.generation});
const savedPath=id=>path.join(directory,'terminal-log-exports',id,'export.jsonl');
const snapshot=()=>ui.evaluate(`({state:document.querySelector('[aria-label="日志导出状态"]')?.textContent,target:document.querySelector('[aria-label="导出任务目标"]')?.textContent,path:document.querySelector('[aria-label="日志导出文件路径"]')?.value})`);
async function capture(connection,parts) {
  const log=await request({op:'start',connection,request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
  for(const bytes of parts) await ui.invoke('fixture_append',{connection,bytes:[...bytes]});
  await request({op:'stop',connection,log_id:log.log_id});
  for(let n=0;n<300;n++){const info=await request({op:'status',connection,log_id:log.log_id});if(info.worker_finished){assert.equal(info.durable,true);return log;}await delay(20);}
  throw new Error('capture did not settle');
}
async function history(id) {
  await ui.click('终端日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);
  await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true`);
  await ui.click('刷新历史目录');await choose(id);
}
async function choose(id) {
  await ui.waitFor(`!document.querySelector('[aria-label="历史日志选择"]').disabled&&Array.from(document.querySelector('[aria-label="历史日志选择"]').options).some(option=>option.value===${JSON.stringify(id)})`);
  await ui.fill('历史日志选择',id);
  await ui.waitFor(`document.querySelector('[aria-label="历史日志目标"]')?.textContent.includes(${JSON.stringify(id)})&&!document.querySelector('[aria-label="历史日志选择"]').disabled`);
}
async function scope() { return JSON.parse(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify(key)})`)); }
async function completed(id) {
  await ui.waitFor(`document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes('导出文件已保存到应用目录')&&document.querySelector('[aria-label="日志导出文件路径"]')?.value.includes(${JSON.stringify(id)})`);
  const location=await ui.evaluate(`document.querySelector('[aria-label="日志导出文件路径"]').value`);
  assert.equal(path.resolve(location),path.resolve(savedPath(id)));
  assert.equal(await ui.evaluate(`(() => {const input=document.querySelector('[aria-label="日志导出文件路径"]');input.focus();return input.readOnly&&document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length;})()`),true,'the complete path is keyboard-focusable and selected for copying');
  const bytes=await readFile(location);
  const receipt=await request({op:'export_status',...await scope()});
  assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'),'producer fingerprint matches the actual published bytes');
  const rows=bytes.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows[0].type,'header');assert.equal(rows.at(-1).type,'verified');
  return {bytes,rows};
}
async function count() { return (await readdir(path.join(directory,'terminal-log-exports'))).filter(name=>name!=='exports.lock').length; }
try {
  ui=await launchDesktop(directory,{fixture:true});
  await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='新建合成会话'&&!b.disabled)`);
  await ui.click('新建合成会话');await ui.waitFor(`document.querySelector('.status')?.textContent==='服务输出已同步'`);
  const [connection]=await ui.invoke('service_list');const target=ref(connection);
  const parts=[Buffer.from('中文😀\0\x1b[31m<img id="EXPORT_LITERAL">\r\n'),Buffer.from([0,255,13,10])];
  const first=await capture(target,parts);
  await ui.click('新建合成会话');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).filter(option=>option.value).length===2&&!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='新建合成会话').disabled`);
  const other=(await ui.invoke('service_list')).find(item=>item.connection_id!==target.connection_id);
  await ui.fill('会话',other.connection_id);
  const before=await ui.invoke('service_read',{connection:ref(other),cursor:1});
  await history(first.log_id);
  await ui.click('导出选中日志');
  const firstScope=await scope();assert.equal(firstScope.log_id,first.log_id);assert.deepEqual(firstScope.connection,target);
  const output=await completed(firstScope.request_id);
  assert.deepEqual(Buffer.concat(output.rows.slice(1,-1).map(row=>Buffer.from(row.raw.bytes))),Buffer.concat(parts));
  assert.equal(output.rows[0].available_from,first.text_cursor);
  assert.equal(await ui.evaluate(`!!document.getElementById('EXPORT_LITERAL')`),false);
  assert.equal(await count(),1);
  assert.deepEqual(await ui.invoke('service_read',{connection:ref(other),cursor:1}),before);
  assert.ok((await snapshot()).target.includes(target.connection_id));
  await ui.screenshot('desktop-export-synthetic.png');
  // Reload restores only the task ID; it never issues another start.
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
  await history(first.log_id);
  await ui.waitFor(`document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes('已恢复上次任务编号')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="日志导出文件路径"]')`),false);
  assert.equal(await count(),1);
  await ui.click('查询导出结果');assert.deepEqual((await completed(firstScope.request_id)).bytes,output.bytes);
  const second=await capture(target,[Buffer.from('second-log-only')]);
  await ui.click('刷新历史目录');await choose(second.log_id);
  assert.ok((await snapshot()).target.includes(first.log_id),'history selection cannot retarget an existing task');
  // Lose a real start reply after service submission, then recover by status.
  const lostReply=await ui.interceptIpc({op:'export_start',mode:'error'});
  await ui.click('导出选中日志');const secondScope=await scope();
  await ui.waitFor(`document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes('保留原任务编号')`);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='导出选中日志').disabled`),true);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="日志导出文件路径"]')`),false);
  assert.equal(await lostReply.count(),1);await lostReply.restore();
  await ui.click('查询导出结果');await completed(secondScope.request_id);assert.equal(await count(),2);
  await choose(first.log_id);
  assert.ok((await snapshot()).target.includes(second.log_id));
  const source=path.join(directory,'terminal-logs',first.log_id,'0000000000000001.text.jsonl');
  await writeFile(source,Buffer.concat([await readFile(source),Buffer.from('synthetic-bad-tail\n')]));
  await ui.click('导出选中日志');const failedScope=await scope();
  await ui.waitFor(`document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes('导出失败')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="日志导出文件路径"]')`),false);
  await assert.rejects(readFile(savedPath(failedScope.request_id)));
  assert.ok((await readdir(path.dirname(savedPath(failedScope.request_id)))).includes('export.partial'));
  assert.deepEqual(await readFile(savedPath(firstScope.request_id)),output.bytes);
  await ui.screenshot('desktop-export-failed-synthetic.png');
  await ui.close();ui=await launchDesktop(directory,{fixture:true});
  assert.deepEqual(await ui.invoke('service_list'),[]);
  await ui.evaluate(`sessionStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(firstScope))})`);
  await history(second.log_id);await ui.click('查询导出结果');
  await ui.waitFor(`document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes('本次服务没有该导出任务')`);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='导出选中日志').disabled`),false);
  await ui.click('导出选中日志');const restarted=await scope();
  assert.notEqual(restarted.request_id,firstScope.request_id);await completed(restarted.request_id);
  // Close while a real start response is delayed. The old promise cannot write
  // into a reopened panel; cancel is best effort and publication may have won.
  const lateReply=await ui.interceptIpc({op:'export_start',delayMs:300});
  await ui.click('导出选中日志');const closing=await scope();await ui.click('关闭日志面板');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="终端日志面板"]')`),false);
  await delay(400);
  assert.equal(await lateReply.count(),1);await lateReply.restore();
  await history(second.log_id);await ui.click('查询导出结果');
  await ui.waitFor(`['导出文件已保存','导出已停止'].some(text=>document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes(text))`);
  const result=await request({op:'export_status',...closing});
  assert.ok(['COMPLETED','CANCELLED'].includes(result.phase));
  if(result.phase==='COMPLETED') await completed(closing.request_id);else await assert.rejects(readFile(savedPath(closing.request_id)));
  assert.deepEqual(await readFile(savedPath(firstScope.request_id)),output.bytes);
  const cleanupScope=result.phase==='COMPLETED'?closing:restarted;
  if(result.phase!=='COMPLETED') {
    await ui.click('关闭日志面板');
    await ui.evaluate(`sessionStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(restarted))})`);
    await history(second.log_id);await ui.click('查询导出结果');await completed(restarted.request_id);
  }
  {
    const preview=await request({op:'cleanup_preview',kind:'EXPORT',id:cleanupScope.request_id,preview_id:crypto.randomUUID()});
    assert.equal(preview.phase,'PREVIEW');assert.equal(preview.files[0].name,'export.jsonl');
    const removed=await request({op:'cleanup_commit',kind:'EXPORT',id:cleanupScope.request_id,preview_id:preview.preview_id,confirmation:preview.confirmation});
    assert.equal(removed.report.directory_removed,true);
    await ui.waitFor(`document.querySelector('[aria-label="日志导出状态"]')?.textContent.includes('导出产物已整理')`);
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="日志导出文件路径"]')`),false);
    await ui.waitFor(`document.activeElement?.textContent==='查询导出结果'`);
    await assert.rejects(readFile(savedPath(cleanupScope.request_id)));
    await ui.screenshot('desktop-export-removed-synthetic.png');
  }
  console.log('PASS export native WebView: frozen independent target, real JSONL bytes/path/retained range, reload ID query without restart, lost real start reply recovered by status, corrupt source never claims saved, restart NotFound permits explicit fresh export, close/in-flight response cannot retarget or undo published files; cleanup invalidates saved paths; synthetic only');
} catch(error) {
  if(ui){console.error(await snapshot());console.error('export failure state:',await ui.evaluate(`JSON.stringify({main:document.querySelector('.status')?.textContent,selection:document.querySelector('[aria-label="会话"]')?.value,create:[...document.querySelectorAll('button')].filter(b=>b.textContent==='新建合成会话').map(b=>({disabled:b.disabled}))})`));console.error('export failure connections:',await ui.invoke('service_list').catch(()=> 'unavailable'));await ui.screenshot('desktop-export-failure-synthetic.png');}
  throw error;
} finally {
  await ui?.close();
  const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-export-ui-中文-'));
  await rm(target,{recursive:true,force:true});
}
