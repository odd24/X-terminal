import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const roots = [];
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-preferences-ui-中文-')); roots.push(directory);
let ui;
const message = text => ui.waitFor(`document.querySelector('[aria-label="桌面偏好状态"]')?.textContent.includes(${JSON.stringify(text)})`);
const call = request => ui.invoke('config_request', { request });
async function open(root=directory) { ui=await launchDesktop(root,{fixture:true}); await ui.click('外观'); await message('已读取'); }
const focus = () => ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
async function key(letter, shift=false) {
  await ui.command('Page.bringToFront');await focus(); const code=letter.toUpperCase().charCodeAt(0);
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',modifiers:shift?10:2,key:letter,code:'Key'+letter.toUpperCase(),windowsVirtualKeyCode:code});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:letter,code:'Key'+letter.toUpperCase(),windowsVirtualKeyCode:code});
}
async function toggle(label) { await ui.evaluate(`document.querySelector('[aria-label="${label}"]').click()`); }
try {
  await open();
  const seed=await call({op:'preferences'});await call({op:'save_preferences',revision:seed.revision,preferences:{...seed.preferences,right_click_paste:true}});await ui.click('重新读取偏好');await message('已读取');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="右键粘贴"]')`),false);
  await ui.fill('终端配色','black_green');
  await ui.fill('终端文字亮度',70);
  await ui.waitFor(`document.querySelector('.desktop-shell').style.getPropertyValue('--terminal-text-brightness')==='70%'`);
  await ui.fill('应用主题','light'); await ui.fill('终端等宽字体','cascadia'); await ui.fill('终端字号',22);
  await ui.waitFor(`document.querySelector('[aria-label="终端字号保存状态"]').textContent==='字号已自动保存'`);
  await ui.screenshot('terminal-font-size-control.png');
  await toggle('Ctrl+C选区复制'); await toggle('Ctrl+V粘贴');
  const expected={theme:'light',terminal_font:'cascadia',terminal_palette:'black_green',font_size:22,terminal_text_brightness:70,ctrl_c_copy:false,ctrl_v_paste:true,right_click_paste:true};
  assert.deepEqual((await call({op:'preferences'})).preferences,{...seed.preferences,right_click_paste:true,font_size:22},'automatic size changes do not persist other edited preferences');
  await ui.click('保存桌面偏好'); await message('已保存'); assert.deepEqual((await call({op:'preferences'})).preferences,expected);
  await ui.evaluate('window.__preferencesReloadMarker=true'); await ui.command('Page.reload');
  await ui.waitFor(`!window.__preferencesReloadMarker && !!document.querySelector('footer')`);
  await ui.click('外观'); await message('已读取');
  assert.equal(await ui.evaluate('document.documentElement.dataset.theme'),'light');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="字号"]').value`),'22');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端文字亮度"]').value`),'70');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端等宽字体"]').value`),'cascadia');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端配色"]').value`),'black_green');
  for(const [label,value] of [['Ctrl+C选区复制',false],['Ctrl+V粘贴',true]]) assert.equal(await ui.evaluate(`document.querySelector('[aria-label="${label}"]').checked`),value);
  await ui.click('关闭外观');await ui.click('新建合成会话'); await ui.waitFor(`document.querySelector('.status').textContent==='服务输出已同步'`);
  const [connection]=await ui.invoke('service_list'); const ref={connection_id:connection.connection_id,generation:connection.generation};
  const originalText=await ui.invoke('service_read_text',{connection:ref,cursor:1});
  const colors = () => ui.evaluate(`(()=>{const s=getComputedStyle(document.documentElement);const probe=document.createElement('span');probe.style.color=s.getPropertyValue('--terminal-foreground');document.body.append(probe);const foreground=getComputedStyle(probe).color;probe.remove();return {background:getComputedStyle(document.querySelector('.terminal')).backgroundColor,foreground,ui:s.backgroundColor,viewport:getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor};})()`);
  assert.deepEqual(await colors(),{background:'rgb(0, 0, 0)',foreground:'rgb(128, 255, 128)',ui:'rgb(238, 240, 243)',viewport:'rgb(0, 0, 0)'});
  const originalScreen=await ui.invoke('service_screen',{connection:ref});
  await ui.click('外观');await ui.fill('终端配色','black_white');
  assert.equal((await colors()).foreground,'rgb(238, 238, 238)');
  await ui.fill('应用主题','dark');
  assert.equal((await colors()).foreground,'rgb(238, 238, 238)');
  await ui.fill('终端配色','follow_theme');
  assert.equal((await colors()).background,'rgb(0, 0, 0)');
  await ui.fill('应用主题','light');
  assert.equal((await colors()).background,'rgb(255, 255, 255)');
  await ui.fill('终端配色','black_green');
  const currentScreen=await ui.invoke('service_screen',{connection:ref});
  assert.equal(currentScreen.contents,originalScreen.contents,'palette does not rewrite service screen');
  await ui.screenshot('desktop-palette-native.png');
  assert.deepEqual(await ui.invoke('service_read_text',{connection:ref,cursor:1}),originalText,'palette preserves derived text and source scope');
  const read=cursor=>ui.invoke('service_read',{connection:ref,cursor}); let cursor=(await read(1)).next_cursor;
  async function bytes(expectedBytes) {
    let result;
    for(let attempt=0;attempt<150;attempt++){result=await read(cursor);if(result.events.length)break;await delay(20);}
    assert.deepEqual(Buffer.from(result.events.flatMap(item=>item.bytes)),Buffer.from(expectedBytes)); cursor=result.next_cursor;
  }
  await ui.click('关闭外观');await ui.click('查找终端'); await ui.fill('终端查找文字','中文宽字'); await ui.click('下一个匹配');
  await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent.includes('1 / 1')`);
  await key('c'); await bytes([3]); // disabled selection-copy keeps terminal Ctrl+C
  await ui.click('下一个匹配'); await key('c',true); await ui.waitFor(`document.querySelector('[aria-label="剪贴板状态"]')?.textContent==='终端选区已复制'`);
  await delay(150); // Allow Windows clipboard publication to settle before the independent read action.
  const readHook=await ui.interceptIpc({command:'terminal_clipboard_read',op:undefined});
  try { await key('v'); await bytes(Buffer.from('中文宽字')); assert.equal(await readHook.count(),1); } finally { await readHook.restore(); }
  await ui.click('关闭查找');
  const terminal=await ui.evaluate(`(()=>{const r=document.querySelector('.terminal').getBoundingClientRect();return{x:r.x+30,y:r.y+30};})()`);
  // Click once to clear the search selection before testing the menu path.
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...terminal});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...terminal});
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...terminal});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...terminal});
  await ui.waitFor(`!!document.querySelector('[aria-label="终端日志菜单"]')`);assert.equal((await read(cursor)).events.length,0);await ui.click('粘贴');await bytes(Buffer.from('中文宽字'));
  // A disabled Ctrl+V is the terminal's literal control key, while Shift+V stays explicit paste.
  await ui.click('外观');await toggle('Ctrl+V粘贴');await ui.click('关闭外观'); await key('v'); await bytes([22]); await key('v',true); await bytes(Buffer.from('中文宽字'));

  assert.equal(await ui.evaluate(`document.querySelector('.terminal').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`),false);await ui.waitFor(`!!document.querySelector('[aria-label="终端日志菜单"]')`);await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  // Preference edits invalidate existing paste consent; no clipboard text is persisted.
  await ui.evaluate(`(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify('PENDING\n')});document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));})()`);
  await ui.waitFor(`!!document.querySelector('[aria-label="粘贴确认"]')`);
  await ui.click('外观');await ui.fill('应用主题','dark'); await ui.waitFor(`!document.querySelector('[aria-label="粘贴确认"]')`);
  assert.equal((await read(cursor)).events.length,0);
  await ui.click('重新读取偏好'); await message('已读取');
  assert.deepEqual((await call({op:'preferences'})).preferences,expected);
  // A stale revision is visible and requires an explicit read, without overwriting newer storage.
  const prior=await call({op:'preferences'});
  await call({op:'save_preferences',revision:prior.revision,preferences:{...expected,font_size:23}});
  await ui.click('保存桌面偏好'); await message('请重新读取核对');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存桌面偏好').disabled`),true);
  assert.equal((await call({op:'preferences'})).preferences.font_size,23);
  await ui.click('重新读取偏好'); await message('已读取');
  const lost=await ui.interceptIpc({command:'save_terminal_font_size',op:undefined,mode:'error'});
  try {
    await ui.fill('终端字号',24);
    await ui.waitFor(`document.querySelector('[aria-label="终端字号保存状态"]').textContent==='字号已自动保存'`);
    assert.equal(await lost.count(),1);
    await delay(300); assert.equal(await lost.count(),1,'unknown save is not retried');
    assert.equal((await call({op:'preferences'})).preferences.font_size,24);
  } finally { await lost.restore(); }
  await ui.click('重新读取偏好'); await message('已读取');
  const backup=(await call({op:'create_backup'})).artifact;
  await ui.fill('应用主题','dark');
  const lateSave=await ui.interceptIpc({command:'config_request',op:'save_preferences',mode:'hold'});
  try {
    await ui.click('保存桌面偏好');
    for(let attempt=0;attempt<100 && !(await lateSave.count());attempt++)await delay(10);
    assert.equal(await lateSave.count(),1);
    assert.equal((await call({op:'preferences'})).preferences.theme,'dark','manual change was committed before holding the response');
    assert.equal(await ui.evaluate('window.__desktopIpcResponseTest.releases.length'),1,'real save response must be held');
    await ui.click('关闭外观');await ui.click('连接配置');
    await ui.waitFor(`document.querySelector('[aria-label="配置状态"]')?.textContent.includes('已加载')`);
    await ui.waitFor(`document.querySelector('[aria-label="备份状态"]')?.textContent.includes('已加载')`);
    await ui.fill('已保存副本','backup:'+backup.id); await ui.click('预览选中备份');
    await ui.waitFor(`document.querySelector('[aria-label="备份状态"]').textContent.includes('备份验证完成')`);
    await toggle('确认恢复备份');
    assert.equal(await ui.evaluate('window.__desktopIpcResponseTest.releases.length'),1,'real save response must remain held at restore confirmation');
    assert.equal(await ui.evaluate(`!document.querySelector('[aria-label="外观设置"]')`),true,'appearance dialog was explicitly closed before opening configuration');
    await ui.click('替换当前配置');
    await ui.waitFor(`document.querySelector('[aria-label="备份状态"]').textContent.includes('当前配置已恢复')`);
    await ui.click('关闭配置');await ui.click('外观');await message('已读取'); await lateSave.release(); await delay(300);
    assert.equal(await lateSave.count(),1);
    assert.equal(await ui.evaluate('document.documentElement.dataset.theme'),'light','late manual save cannot undo restored theme');
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="字号"]').value`),'24','late old save reply cannot undo explicitly restored preferences');
    assert.equal((await call({op:'preferences'})).preferences.font_size,24);
    await ui.click('关闭配置');
  } finally { await lateSave.restore(); }
  await ui.evaluate(`document.querySelector('[aria-label="桌面偏好状态"]').scrollIntoView({block:'center'})`);
  await ui.screenshot('desktop-preferences-native.png');
  await ui.close();ui=null;
  await open();
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端文字亮度"]').value`),'70','brightness survives process restart');
  await ui.close();ui=null;
  // Convert only our stopped synthetic directory to the exact old schema-3 shape.
  const legacy = new DatabaseSync(path.join(directory,'config.sqlite'));
  const oldPreferences=JSON.parse(legacy.prepare('SELECT value FROM desktop_preferences WHERE id=1').get().value);
  assert.equal(oldPreferences.terminal_text_brightness,70);
  delete oldPreferences.terminal_text_brightness;
  delete oldPreferences.terminal_palette;
  legacy.prepare('UPDATE desktop_preferences SET value=? WHERE id=1').run(JSON.stringify(oldPreferences));
  assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n,0);assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM quick_commands').get().n,0);
  legacy.exec('DROP TABLE quick_commands; DROP TABLE workspaces; DELETE FROM schema_migrations WHERE version>3; PRAGMA user_version=3'); legacy.close();
  await open(); assert.equal(await ui.evaluate(`document.querySelector('[aria-label="字号"]').value`),'24');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端配色"]').value`),'follow_theme','old database defaults only the new palette');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端文字亮度"]').value`),'100','legacy brightness defaults to the original colors');
  assert.deepEqual((await call({op:'preferences'})).preferences,{...oldPreferences,terminal_palette:'follow_theme'});
  const migrationFiles=(await readdir(directory)).filter(name=>/^config-before-v3-[0-9a-f-]+\.sqlite$/.test(name));
  assert.equal(migrationFiles.length,1);
  const migration=new DatabaseSync(path.join(directory,migrationFiles[0]),{readOnly:true});
  assert.equal(migration.prepare('PRAGMA user_version').get().user_version,3);
  assert.deepEqual(JSON.parse(migration.prepare('SELECT value FROM desktop_preferences WHERE id=1').get().value),oldPreferences);migration.close();
  assert.equal((await ui.invoke('service_list')).length,0,'service restart restores preferences without recreating sessions');
  await ui.close();ui=null;
  const second=await mkdtemp(path.join(tmpdir(),'shared-terminal-preferences-ui-中文-'));roots.push(second);
  await open(second);assert.equal(await ui.evaluate('document.documentElement.dataset.theme'),'light');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="字号"]').value`),'15');
  const secondStored=await call({op:'preferences'});
  const external={...secondStored.preferences,terminal_text_brightness:63};
  await call({op:'save_preferences',revision:secondStored.revision,preferences:external});
  await ui.evaluate(`document.querySelector('[aria-label="终端字号"]').focus()`);
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await ui.waitFor(`document.querySelector('[aria-label="终端字号"]').value==='16' && document.querySelector('[aria-label="终端字号保存状态"]').textContent==='字号已自动保存'`);
  assert.deepEqual((await call({op:'preferences'})).preferences,{...external,font_size:16},'font write starts from the latest stored shared preferences');
  console.log('PASS native preferences: isolated automatic font size, explicit save/read of other preferences, reload and process restart, directory isolation, exact clipboard bytes, stale revision, lost font save verified without replay and late restore; synthetic only');
} catch(error) {
  console.error('preferences failure:',await ui?.evaluate(`JSON.stringify({preferences:document.querySelector('[aria-label="桌面偏好状态"]')?.textContent,main:document.querySelector('.status')?.textContent})`)); if(ui)await ui.screenshot('desktop-preferences-failure.png'); throw error;
} finally {
  await ui?.close();
  for(const root of roots){const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-preferences-ui-中文-'));await rm(target,{recursive:true,maxRetries:20,retryDelay:100});}
}
