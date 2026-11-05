import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-recovery-ui-中文-'));
let ui;
const request = value => ui.invoke('logging_request', { request: value });
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
  console.log('PASS recovery native WebView: independent old-service target, missing marker/corrupt tail prefix, rejected header, text/HEX and escaped markup, bounded replacement pages, explicit incomplete end, stop/focus, real lost/delayed IPC responses and late close release; synthetic only');
} catch (error) {
  if(ui){console.error(await ui.evaluate(`({status:document.querySelector('[aria-label="恢复读取状态"]')?.textContent,range:document.querySelector('[aria-label="恢复分页范围"]')?.textContent})`));await ui.screenshot('desktop-recovery-failure-synthetic.png');}
  throw error;
} finally {
  await ui?.close();
  const target = path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-recovery-ui-中文-'));
  await rm(target,{recursive:true,force:true});
}
