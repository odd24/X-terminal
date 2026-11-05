import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-navigation-ui-中文-'));
const fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
let ui;
try {
  const server = await Promise.race([lines.next().then(item => JSON.parse(item.value)), delay(10000).then(() => { throw new Error('fixture startup timeout'); })]);
  ui = await launchDesktop(directory, { fixture: true });
  const folder = { id: crypto.randomUUID(), parent_id: null, name: '合成会话组' };
  await ui.invoke('config_request', { request: { op: 'save_folder', folder } });
  const profile = { id: crypto.randomUUID(), folder_id: folder.id, name: '同配置多实例 中文', settings: { protocol: 'ssh2', host: '127.0.0.1', port: server.port, username: 'synthetic', auth: 'password', encoding: 'utf8' } };
  await ui.invoke('config_request', { request: { op: 'save_profile', profile, credential: { action: 'keep' } } });
  await ui.click('刷新会话树');
  await ui.fill('搜索会话配置', '中文');
  const treeButton = `Array.from(document.querySelectorAll('.session-tree-list button')).find(button=>button.firstChild.textContent===${JSON.stringify(profile.name)})`;
  await ui.waitFor(`!!(${treeButton})`);
  await ui.evaluate(`(${treeButton}).click()`);
  assert.equal((await ui.invoke('service_list')).length, 0, 'single click only selects Profile');
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="配置详情"]').textContent`)).includes(profile.name));
  await ui.evaluate(`(${treeButton}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await ui.waitFor(`document.querySelectorAll('[role="tab"]').length===1`);
  const [first] = await ui.invoke('service_list');
  await ui.click('连接选中配置');
  await ui.waitFor(`document.querySelectorAll('[role="tab"]').length===2`);
  const second = (await ui.invoke('service_list')).find(item => item.connection_id !== first.connection_id);
  assert.notEqual(first.connection_id, second.connection_id);
  await ui.fill('搜索会话配置', '不存在的名称');
  assert.equal(await ui.evaluate(`document.querySelectorAll('.session-tree-list button').length`), 0);
  assert.equal((await ui.invoke('service_list')).length, 2, 'search cannot change connections');
  await ui.fill('搜索会话配置', '');
  // Use the full immutable identity from the accessible tab title.
  await ui.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(item=>item.title.includes(${JSON.stringify(first.connection_id)})).click()`);
  await ui.waitFor(`document.querySelector('[aria-label="会话"]').value===${JSON.stringify(first.connection_id)}`);
  await ui.click('标签右移');
  assert.equal(await ui.evaluate(`document.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected')`), 'true');
  await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(item=>item.getAttribute('aria-label')===${JSON.stringify('关闭标签 ' + first.connection_id)}).click()`);
  await ui.click('取消关闭标签');
  assert.equal((await ui.invoke('service_list')).find(item=>item.connection_id===first.connection_id).generation, first.generation);
  await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(item=>item.getAttribute('aria-label')===${JSON.stringify('关闭标签 ' + first.connection_id)}).click()`);
  await ui.click('保留连接隐藏标签');
  await ui.waitFor(`document.querySelectorAll('[role="tab"]').length===1`);
  assert.equal((await ui.invoke('service_list')).length, 2, 'hiding never forgets or disconnects');
  await ui.fill('会话', first.connection_id);
  await ui.waitFor(`document.querySelectorAll('[role="tab"]').length===2`);
  await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(item=>item.getAttribute('aria-label')===${JSON.stringify('关闭标签 ' + first.connection_id)}).click()`);
  await ui.click('关闭连接并隐藏标签');
  for (let attempt=0; attempt<100; attempt++) {
    if (['DISCONNECTED','FAILED'].includes((await ui.invoke('service_list')).find(item=>item.connection_id===first.connection_id).state)) break;
    await delay(50);
  }
  assert.ok(['DISCONNECTED','FAILED'].includes((await ui.invoke('service_list')).find(item=>item.connection_id===first.connection_id).state));
  assert.equal((await ui.invoke('service_list')).find(item=>item.connection_id===second.connection_id).generation, second.generation);
  await ui.click('退出桌面');
  await ui.waitFor(`!!document.querySelector('[aria-label="退出桌面确认"]')`);
  await ui.click('取消退出');
  assert.equal(ui.app.exitCode, null);
  await ui.click('SSH2 连接'); // fold authentication tool, leaving the terminal dominant
  for (let index=0; index<11; index++) { await ui.click('新建合成会话'); await delay(200); }
  await ui.waitFor(`document.querySelectorAll('[role="tab"]').length===12`);
  assert.equal(await ui.evaluate(`document.querySelector('[role="tablist"]').scrollWidth>document.querySelector('[role="tablist"]').clientWidth`), true);
  await ui.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await ui.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const selectedId = await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`);
  await ui.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(item=>item.getAttribute('aria-selected')==='true').focus()`);
  await ui.command('Input.dispatchKeyEvent', { type:'keyDown', key:'Home', code:'Home', windowsVirtualKeyCode:36 });
  await ui.command('Input.dispatchKeyEvent', { type:'keyUp', key:'Home', code:'Home', windowsVirtualKeyCode:36 });
  assert.equal(await ui.evaluate(`document.querySelector('[role="tab"]').getAttribute('aria-selected')`),'true');
  await ui.fill('会话',selectedId);
  const hiddenTarget = (await ui.invoke('service_list')).find(item=>item.connection_id===selectedId);
  await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(item=>item.getAttribute('aria-label')===${JSON.stringify('关闭标签 '+selectedId)}).click()`);
  await ui.click('保留连接隐藏标签');
  await ui.invoke('fixture_append',{connection:{connection_id:hiddenTarget.connection_id,generation:hiddenTarget.generation},bytes:[...Buffer.from('BACKGROUND-HIDDEN-CONTINUES')]});
  await ui.fill('会话',selectedId);
  for(let attempt=0;attempt<100;attempt++) {
    await ui.click('屏幕快照');
    if(await ui.evaluate(`document.querySelector('pre[aria-label="屏幕快照"]')?.textContent.includes('BACKGROUND-HIDDEN-CONTINUES')`))break;
    await delay(50);
  }
  assert.equal(await ui.evaluate(`document.querySelector('pre[aria-label="屏幕快照"]')?.textContent.includes('BACKGROUND-HIDDEN-CONTINUES')`),true);
  await ui.click('关闭屏幕快照');
  await ui.fill('导航宽度',320);
  assert.equal(await ui.evaluate(`Math.round(document.querySelector('.session-sidebar').getBoundingClientRect().width)`),320);
  await ui.screenshot('desktop-navigation-native.png');
  await ui.click('会话导航');
  assert.equal(await ui.evaluate(`getComputedStyle(document.querySelector('.session-sidebar')).display`), 'none');
  const dimensions = await ui.evaluate(`(()=>{const rect=document.querySelector('.terminal').getBoundingClientRect();return {height:rect.height,width:rect.width,window:innerHeight}})()`);
  assert.ok(dimensions.height>dimensions.window/2, 'terminal occupies most of the native window height');
  await ui.command('Page.reload');
  await ui.waitFor(`document.querySelectorAll('[role="tab"]').length===13`);
  assert.equal((await ui.invoke('service_list')).length, 13, 'reload reopens views without recreating service connections');
  console.log('PASS navigation native WebView: Profile single/double click, same-Profile independent instances, search, tab selection/reorder/overflow, close cancel/hide/reopen/exact close, exit confirmation, terminal-first native layout and reload service identity; synthetic only');
} finally {
  await ui?.close(); fixture.kill(); await delay(200);
  assert.ok(path.basename(directory).startsWith('shared-terminal-navigation-ui-中文-'));
  await rm(directory, { recursive: true, force: true });
}
