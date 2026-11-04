import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-cleanup-ui-中文-'));
const key='terminal-log-cleanup-task-v1';
let ui;
const request=value=>ui.invoke('logging_request',{request:value});
const disabled=label=>ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).disabled`);
const scope=async()=>JSON.parse(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify(key)})`));
const state=text=>ui.waitFor(`document.querySelector('[aria-label="日志清理状态"]')?.textContent.includes(${JSON.stringify(text)})`);
const check=()=>ui.evaluate(`document.querySelector('[aria-label="确认清理文件"]').click()`);
async function panel() {
  await ui.click('终端日志');await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);
  await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true;document.querySelector('[aria-label="日志清理工具"]').open=true`);
}
async function select(kind,id) {
  await ui.waitFor(`!document.querySelector('[aria-label="清理类别"]').disabled`);
  await ui.fill('清理类别',kind);await ui.click('刷新清理目录');
  await ui.waitFor(`!document.querySelector('[aria-label="清理目标选择"]').disabled&&Array.from(document.querySelector('[aria-label="清理目标选择"]').options).some(o=>o.value===${JSON.stringify(id)})`);
  await ui.fill('清理目标选择',id);await ui.click('预览清理文件');
}
async function preview(kind,id) { await select(kind,id);await state('文件清单已锁定');assert.equal(await disabled('确认删除清单文件'),true); }
async function capture(connection,text) {
  const log=await request({op:'start',connection,request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
  await ui.invoke('fixture_append',{connection,bytes:[...Buffer.from(text)]});await request({op:'stop',connection,log_id:log.log_id});
  for(let n=0;n<300;n++){const info=await request({op:'status',connection,log_id:log.log_id});if(info.worker_finished){assert.equal(info.durable,true);return log;}await delay(20);}
  throw new Error('capture did not settle');
}
try {
  ui=await launchDesktop(directory,{fixture:true});await ui.click('新建合成会话');await ui.waitFor(`document.querySelector('.status')?.textContent==='服务输出已同步'`);
  const [c]=await ui.invoke('service_list');const connection={connection_id:c.connection_id,generation:c.generation};
  const log=await capture(connection,'synthetic 中文 <img id="CLEANUP_LITERAL">\r\n');
  const second=await capture(connection,'keep this independent source');
  const logPath=path.join(directory,'terminal-logs',log.log_id);const keepPath=path.join(directory,'terminal-logs',second.log_id);
  const original=await readFile(path.join(logPath,'0000000000000001.rawlog'));
  await panel();await ui.click('刷新历史目录');
  await ui.waitFor(`!document.querySelector('[aria-label="历史日志选择"]').disabled`);
  await ui.fill('历史日志选择',log.log_id);await ui.click('打开历史日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="历史日志内容"]')`);
  // An existing browser pin is not silently closed to make deletion succeed.
  await select('LOG',log.log_id);await state('目标正在使用');
  assert.deepEqual(await readFile(path.join(logPath,'0000000000000001.rawlog')),original);
  await ui.click('查询清理结果');await state('没有该清理预览');
  await ui.click('关闭历史读取');await ui.waitFor(`!document.querySelector('[aria-label="历史日志内容"]')`);
  await preview('LOG',log.log_id);
  const first=await scope();assert.equal(first.id,log.log_id);assert.equal(first.kind,'LOG');
  assert.deepEqual(Object.keys(first).sort(),['id','kind','preview_id']);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="清理目标选择"]').disabled`),true);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="清理文件清单"]').textContent.includes('completion.json')`),true);
  assert.equal(await ui.evaluate(`!!document.getElementById('CLEANUP_LITERAL')`),false);
  await check();assert.equal(await disabled('确认删除清单文件'),false);
  await ui.screenshot('desktop-cleanup-preview-synthetic.png');
  await ui.click('取消清理预览');await state('预览已取消');assert.equal(await disabled('确认删除清单文件'),true);
  assert.deepEqual(await readFile(path.join(logPath,'0000000000000001.rawlog')),original);
  // Status recovery after reload never restores the approval checkbox.
  await preview('LOG',log.log_id);await check();
  const restored=await scope();await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);await panel();
  await state('已恢复清理编号');assert.equal(await disabled('确认删除清单文件'),true);
  await ui.click('查询清理结果');await state('文件清单已锁定');assert.deepEqual(await scope(),restored);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="确认清理文件"]').checked`),false);
  await check();
  // Real lease expiry, while the normal desktop heartbeat keeps IPC alive.
  for(let n=0;n<7;n++){await delay(5000);await ui.invoke('service_status');}
  await state('预览已到期');assert.equal(await disabled('确认删除清单文件'),true);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="确认清理文件"]').checked`),false);
  assert.deepEqual(await readFile(path.join(logPath,'0000000000000001.rawlog')),original);
  await ui.screenshot('desktop-cleanup-expired-synthetic.png');
  // New unknown namespace entries invalidate the real pinned snapshot.
  await preview('LOG',log.log_id);await writeFile(path.join(logPath,'synthetic-unknown.txt'),'keep');await check();await ui.click('确认删除清单文件');
  await state('文件集合已变化');assert.equal(await ui.evaluate(`document.querySelector('[aria-label="清理实际结果"]').textContent.includes('已删除 0 个文件')`),true);
  assert.deepEqual(await readFile(path.join(logPath,'0000000000000001.rawlog')),original);
  await ui.screenshot('desktop-cleanup-changed-synthetic.png');await rm(path.join(logPath,'synthetic-unknown.txt'));
  // Lose an actual successful commit reply; query the original receipt only.
  await preview('LOG',log.log_id);const lost=await ui.interceptIpc({op:'cleanup_commit',mode:'error'});await check();await ui.click('确认删除清单文件');
  await state('保留原编号');assert.equal(await lost.count(),1);assert.equal(await disabled('确认删除清单文件'),true);await lost.restore();
  await assert.rejects(readdir(logPath));await mkdir(logPath);await writeFile(path.join(logPath,'synthetic-sentinel.txt'),'new directory must survive');
  await ui.click('查询清理结果');await state('清理完成');
  assert.equal(await readFile(path.join(logPath,'synthetic-sentinel.txt'),'utf8'),'new directory must survive');
  await ui.click('查询清理结果');await state('清理完成');
  assert.equal((await request({op:'status',connection,log_id:log.log_id})).phase,'REMOVED');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="历史日志目标"]')`),false,'removed selection is cleared rather than redirected');
  assert.ok((await readdir(keepPath)).includes('completion.json'));
  // Export cleanup addresses its own UUID and leaves the source untouched.
  const exported={connection,log_id:second.log_id,request_id:crypto.randomUUID()};await request({op:'export_start',...exported});
  for(let n=0;n<300;n++){const result=await request({op:'export_status',...exported});if(result.phase==='COMPLETED')break;assert.notEqual(result.phase,'FAILED');await delay(20);}
  await preview('EXPORT',exported.request_id);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="清理文件清单"]').textContent.includes('export.jsonl')`),true);
  await check();await ui.click('确认删除清单文件');await state('清理完成');
  assert.equal((await request({op:'export_status',...exported})).phase,'REMOVED');assert.ok((await readdir(keepPath)).includes('completion.json'));
  await ui.screenshot('desktop-cleanup-applied-synthetic.png');
  // A response arriving after panel close cannot approve or leave a pinned lease.
  const delayed=await ui.interceptIpc({op:'cleanup_preview',delayMs:700});await select('LOG',second.log_id);
  await ui.click('关闭日志面板');await delay(1000);assert.equal(await delayed.count(),1);await delayed.restore();
  await panel();await ui.click('查询清理结果');await state('预览已取消');
  assert.ok((await readdir(keepPath)).includes('completion.json'));
  const before=await ui.invoke('service_read',{connection,cursor:1});await ui.invoke('fixture_append',{connection,bytes:[...Buffer.from('terminal continues')]});
  const after=await ui.invoke('service_read',{connection,cursor:1});assert.ok(after.next_cursor>before.next_cursor);assert.ok(after.events.flatMap(event=>event.bytes).length>before.events.flatMap(event=>event.bytes).length);
  console.log('PASS desktop cleanup: pins/cancel/reload/expiry/changed/uncertain commit/independent targets/late close/terminal continuity (synthetic only)');
} finally { if(ui)await ui.close();await rm(directory,{recursive:true,force:true}); }
