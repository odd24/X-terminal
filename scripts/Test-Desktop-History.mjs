import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-history-ui-'));
let ui;
const request = value => ui.invoke('logging_request', { request: value });
const ref = connection => ({ connection_id: connection.connection_id, generation: connection.generation });
const textPath = id => path.join(directory, 'terminal-logs', id, '0000000000000001.text.jsonl');
async function stopped(target, id) {
  await request({ op: 'stop', connection: target, log_id: id });
  for (let n = 0; n < 300; n++) { const value = await request({ op: 'status', connection: target, log_id: id });if(value.worker_finished){ assert.equal(value.durable,true);return; } await delay(20); }
  throw new Error('synthetic log did not stop');
}
async function history() {
  await ui.click('终端日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open`),false);
  await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true`);
  await ui.click('刷新历史目录');
}
async function select(id) {
  await ui.waitFor(`!document.querySelector('[aria-label="历史日志选择"]').disabled&&Array.from(document.querySelector('[aria-label="历史日志选择"]').options).some(option=>option.value===${JSON.stringify(id)})`);
  await ui.fill('历史日志选择',id);
  await ui.waitFor(`document.querySelector('[aria-label="历史日志目标"]').textContent.includes(${JSON.stringify(id)})`);
  await ui.waitFor(`!document.querySelector('[aria-label="历史日志选择"]').disabled`);
}
async function assertReleased(file) {
  for(let n=0;n<100;n++){try{const handle=await open(file,'r+');await handle.close();return;}catch{await delay(20);}}
  throw new Error('historical read handles must be released');
}
try {
  ui=await launchDesktop(directory,{fixture:true});
  await history();
  await ui.waitFor(`document.querySelector('[aria-label="历史读取状态"]')?.textContent.includes('尚无历史日志')`);
  await ui.click('关闭日志面板');
  await ui.click('新建合成会话');
  const [connection]=await ui.invoke('service_list');const target=ref(connection);
  await ui.waitFor(`document.querySelector('.status')?.textContent==='服务输出已同步'`);
  const first=await request({op:'start',connection:target,request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
  assert.equal(first.text_cursor,2);
  for(const text of ['prefix中','文😀tail\0\x1b[31m<img id="HISTORY_LITERAL" src="x">\u202eend']) await ui.invoke('fixture_append',{connection:target,bytes:[...Buffer.from(text)]});
  await stopped(target,first.log_id);
  await ui.click('新建合成会话');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).filter(option=>option.value).length===2&&!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='新建合成会话').disabled`);
  const other=(await ui.invoke('service_list')).find(item=>item.connection_id!==connection.connection_id);
  await ui.fill('会话',other.connection_id);
  const otherBefore=await ui.invoke('service_read',{connection:ref(other),cursor:1});
  await history();await select(first.log_id);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`),other.connection_id);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="历史日志目标"]').textContent`)).includes(connection.connection_id));
  await ui.click('打开历史日志');
  await ui.waitFor(`document.querySelector('[aria-label="历史分页范围"]')?.textContent.includes('保留范围全检通过')`);
  const preview=await ui.evaluate(`document.querySelector('[aria-label="历史日志内容"]').textContent`);
  assert.ok(preview.includes('prefix中'));assert.ok(preview.includes('文😀tail\\x00\\x1b[31m'));assert.ok(preview.includes('\\u202e'));
  assert.equal(await ui.evaluate(`!!document.getElementById('HISTORY_LITERAL')`),false,'log markup must remain text');
  await assert.rejects(open(textPath(first.log_id),'r+'));
  await ui.evaluate(`document.querySelector('[aria-label="历史显示HEX"]').click()`);
  await ui.waitFor(`document.querySelector('[aria-label="历史日志内容"]').textContent.includes('70 72 65 66 69 78')`);
  await ui.evaluate(`document.querySelector('[aria-label="历史显示HEX"]').click()`);
  await ui.fill('历史搜索内容','中文😀tail');await ui.click('搜索保留文本');
  await ui.waitFor(`document.querySelector('[aria-label="历史搜索状态"]')?.textContent.includes('搜索与结构校验完成')`);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="历史搜索结果"]').textContent`)).includes('文本 2–3'));
  const otherAfter=await ui.invoke('service_read',{connection:ref(other),cursor:1});assert.deepEqual(otherAfter,otherBefore,'history must not append to the active terminal');
  await ui.screenshot('desktop-history-synthetic.png');
  await ui.click('关闭历史读取');await assertReleased(textPath(first.log_id));
  await ui.click('关闭日志面板');
  const second=await request({op:'start',connection:target,request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
  for(let n=0;n<10;n++) await ui.invoke('fixture_append',{connection:target,bytes:Array(4096).fill(120)});
  await stopped(target,second.log_id);
  await history();await select(second.log_id);
  await ui.fill('历史搜索内容','x');await ui.click('搜索保留文本');
  await ui.waitFor(`document.querySelector('[aria-label="历史搜索状态"]').textContent.includes('累计匹配 40960 条')&&document.querySelector('[aria-label="历史搜索状态"]').textContent.includes('搜索与结构校验完成')`);
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="历史搜索状态"]').textContent`)).includes('结果列表上限 100 条'));
  assert.equal((await ui.evaluate(`document.querySelector('[aria-label="历史搜索结果"]').textContent`)).split('\n').length,100);
  // Delay real read responses to exercise cancellation while IPC is in flight;
  // every returned page still comes from the actual service and real files.
  const delayedRead=await ui.interceptIpc({op:'history_read',delayMs:200});
  await ui.fill('历史搜索内容','not-present');await ui.click('搜索保留文本');
  await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='停止历史搜索').disabled`);
  await ui.click('停止历史搜索');
  await ui.waitFor(`document.querySelector('[aria-label="历史搜索状态"]').textContent.includes('搜索已停止')`);
  assert.ok(await delayedRead.count()>0,'a real historical page response must have been delayed');await delayedRead.restore();
  await assertReleased(textPath(second.log_id));
  await ui.click('打开历史日志');await ui.waitFor(`!!document.querySelector('[aria-label="历史日志内容"]')`);
  await ui.waitFor(`document.querySelector('[aria-label="历史分页范围"]').textContent.includes(${JSON.stringify(`${second.text_cursor}–${second.text_cursor+3}`)})`);
  await ui.click('读取下一页');
  await ui.waitFor(`document.querySelector('[aria-label="历史分页范围"]').textContent.includes(${JSON.stringify(`${second.text_cursor+3}–${second.text_cursor+6}`)})`);
  await ui.click('关闭日志面板');await assertReleased(textPath(second.log_id));
  await ui.close();ui=await launchDesktop(directory,{fixture:true});
  assert.deepEqual(await ui.invoke('service_list'),[]);
  await history();await select(first.log_id);await ui.click('打开历史日志');
  await ui.waitFor(`document.querySelector('[aria-label="历史日志内容"]')?.textContent.includes('prefix中')`);
  await ui.click('关闭历史读取');await assertReleased(textPath(first.log_id));
  const bytes=await readFile(textPath(first.log_id));await writeFile(textPath(first.log_id),bytes.subarray(0,bytes.length-1));
  await ui.click('刷新历史目录');await select(first.log_id);await ui.click('打开历史日志');
  await ui.waitFor(`document.querySelector('[aria-label="历史读取状态"]')?.textContent.includes('不能确认范围完整')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="历史日志内容"]')`),false);
  await ui.screenshot('desktop-history-corrupt-synthetic.png');
  console.log('PASS historical native WebView: explicit independent scope, restart without live connection, text/HEX and escaped controls/markup, cross-record literal search, full-range 40960 match count with bounded display, in-flight cancellation, panel close releases files, corrupted tail never claims completion; synthetic only');
} catch(error) {
  if(ui) { console.error(await ui.evaluate(`({history:document.querySelector('[aria-label="历史读取状态"]')?.textContent,search:document.querySelector('[aria-label="历史搜索状态"]')?.textContent})`));await ui.screenshot('desktop-history-failure-synthetic.png'); }
  throw error;
} finally {
  await ui?.close();
  const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-history-ui-'));
  await rm(target,{recursive:true,force:true});
}
