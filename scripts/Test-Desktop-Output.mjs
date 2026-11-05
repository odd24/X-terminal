import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-output-ui-'));
let ui;
try {
  ui = await launchDesktop(directory, { fixture: true });
  await ui.click('新建合成会话');
  await ui.waitFor(`document.querySelector('.status').textContent==='服务输出已同步'`);
  const [connection] = await ui.invoke('service_list');
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  await ui.click('服务端屏幕');await ui.waitFor(`document.querySelector('[aria-label="服务端屏幕快照"]')?.textContent.includes('中文宽字')`);
  const initialScreen=await ui.invoke('service_screen',{connection:ref});
  assert.equal(initialScreen.encoding,'utf-8');assert.equal(initialScreen.resize_reflow,true);
  assert.equal(initialScreen.parser,'vt100-0.18.1+local.2');
  const text=await ui.invoke('service_read_text',{connection:ref,cursor:1});
  assert.ok(text.events.map(event=>event.text).join('').includes('中文宽字'));
  assert.equal(text.truncated,false);assert.equal(text.completed,false);
  await ui.invoke('fixture_append', { connection: ref, bytes: [...Buffer.from('\r\n' + 'SEARCH中文😀'.repeat(30) + '\r\n' + Array.from({length:40},(_,i)=>`scroll-${i}\r\n`).join(''))] });
  await delay(500);
  await ui.click('查找终端');await ui.fill('终端查找文字','SEARCH中文😀SEARCH');
  await ui.click('下一个匹配');
  await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent.includes('1 / 15')`);
  await ui.click('下一个匹配');await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent.includes('2 / 15')`);
  await ui.click('上一个匹配');await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent.includes('1 / 15')`);
  await ui.screenshot('desktop-terminal-search-synthetic.png');
  await ui.fill('终端查找文字','absent-literal-.*');await ui.click('下一个匹配');
  await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent==='未找到'`);
  await ui.click('回到底部');await ui.click('关闭查找');
  await ui.invoke('fixture_append', { connection: ref, bytes: [...Buffer.from('\r\nPREFIX\x1b]0;')] });
  await delay(300);await ui.click('屏幕快照');
  await ui.waitFor(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('PREFIX')`);
  // Pause only the renderer's output polling; the native service continues receiving.
  await ui.evaluate(`window.__outputTimers=[];window.__outputTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>ms===100?(window.__outputTimers.push(()=>window.__outputTimeout(fn,0,...args)),0):window.__outputTimeout(fn,ms,...args)`);
  await delay(200);
  for (let index = 0; index < 5; index++) await ui.invoke('fixture_append', { connection: ref, bytes: Array(65536).fill(0) });
  const retained = await ui.invoke('service_read', { connection: ref, cursor: 1 });
  assert.equal(retained.truncated, true);
  await ui.evaluate(`window.setTimeout=window.__outputTimeout;window.__outputTimers.forEach(resume=>resume())`);
  await ui.waitFor(`document.querySelector('.status').textContent.includes('清屏并重置解析状态')`);
  await ui.invoke('fixture_append', { connection: ref, bytes: [...Buffer.from('SAFE_AFTER_GAP')] });
  // Retained data spans several pages. Capture repeatedly until the tail is rendered.
  try {
    await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('SAFE_AFTER_GAP'))`);
  } catch (error) {
    console.log(await ui.evaluate(`({status:document.querySelector('.status').textContent,snapshot:document.querySelector('[aria-label="屏幕快照"]')?.textContent,timers:window.__outputTimers.length})`));
    const tail=await ui.invoke('service_read',{connection:ref,cursor:retained.next_cursor});console.log({next:tail.next_cursor,events:tail.events.map(event=>({seq:event.seq,length:event.bytes.length,tail:event.bytes.slice(-30)}))});
    throw error;
  }
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]').textContent.includes('PREFIX')`), false);
  assert.equal(await ui.evaluate(`document.querySelector('.status').textContent.includes('输出缺口')`), true);
  const continuous=await ui.invoke('service_screen',{connection:ref});
  assert.equal(continuous.gap_bytes,0,'a slow raw reader loses retained history, not service input');
  assert.ok(continuous.contents.includes('PREFIX'),'service parser keeps continuous OSC state independently of renderer reset');
  assert.equal(continuous.contents.includes('SAFE_AFTER_GAP'),false);
  await ui.screenshot('desktop-output-gap-synthetic.png');
  await ui.invoke('fixture_append', { connection: ref, bytes: [...Buffer.from('\x1b]0;'), 0xe4] });
  await delay(300);
  const second = await ui.invoke('fixture_create');
  const secondRef = { connection_id: second.connection_id, generation: second.generation };
  await ui.invoke('fixture_append', { connection: secondRef, bytes: [...Buffer.from('SECOND_CONNECTION')] });
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value===${JSON.stringify(second.connection_id)})`);
  await ui.fill('会话', second.connection_id);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`),second.connection_id);
  try {
    await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('SECOND_CONNECTION'))`);
  } catch(error) {
    console.log('synthetic selection failure',await ui.evaluate(`({selected:document.querySelector('[aria-label="会话"]').value,status:document.querySelector('.status').textContent,snapshot:document.querySelector('[aria-label="屏幕快照"]')?.textContent})`));
    throw error;
  }
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]').textContent.includes('SAFE_AFTER_GAP')`), false);
  await ui.click('服务端屏幕');await ui.waitFor(`document.querySelector('[aria-label="服务端屏幕快照"]')?.textContent==='SECOND_CONNECTION'`);
  console.log('PASS native output gap and connection isolation: retained overflow during renderer pause; explicit gap, reset abandons incomplete OSC; tail and new connection visible; no device opened');
} finally {
  await ui?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('shared-terminal-output-ui-'));
  await rm(target, { recursive: true, force: true });
}
