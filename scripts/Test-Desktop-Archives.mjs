import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-archive-ui-中文-'));
let ui;
const archiveMessage = text => ui.waitFor(`document.querySelector('[aria-label="备份状态"]').textContent.includes(${JSON.stringify(text)})`);
const configMessage = text => ui.waitFor(`document.querySelector('[aria-label="配置状态"]').textContent.includes(${JSON.stringify(text)})`);
const call = request => ui.invoke('config_request', { request });
const profiles = async () => (await call({ op: 'page', revision: null, offset: 0, folders: false })).profiles;
async function open(target = directory) { ui = await launchDesktop(target); await ui.click('连接配置'); await ui.waitFor(`document.querySelector('[aria-label="备份状态"]').textContent.includes('已加载')`); }
async function close() { await ui.click('退出桌面'); for (let n = 0; n < 100 && ui.app.exitCode === null; n++) await delay(50); assert.notEqual(ui.app.exitCode, null); await ui.close(); ui = null; }
async function inspect(id) { await ui.fill('已保存副本', `backup:${id}`); await ui.click('预览选中备份'); await archiveMessage('备份验证完成'); }
async function confirm() { await ui.evaluate(`document.querySelector('[aria-label="确认恢复备份"]').click()`); }
try {
  await open(); await configMessage('配置已加载');
  await ui.fill('配置名称', 'Archive original'); await ui.fill('主机', 'example.invalid'); await ui.fill('用户名', 'synthetic'); await ui.fill('凭据操作', 'replace'); await ui.fill('新密码', 'synthetic archive UI password'); await ui.click('保存配置'); await configMessage('配置已保存');
  const initialPreferences = await call({ op: 'preferences' });
  const backedPreferences = { ...initialPreferences.preferences, theme: 'light', terminal_palette: 'black_green', font_size: 22, ctrl_v_paste: true };
  assert.equal((await call({ op: 'save_preferences', revision: initialPreferences.revision, preferences: backedPreferences })).result, 'preferences');
  await ui.click('创建配置备份'); await archiveMessage('配置备份已保存');
  const backup = (await call({ op: 'archives' })).entries.find(entry => entry.kind === 'backup');
  await ui.click('导出便携配置'); await archiveMessage('便携导出已保存');
  const exported = (await call({ op: 'archives' })).entries.find(entry => entry.kind === 'export');
  const json = await readFile(path.join(directory, 'artifacts', exported.filename), 'utf8'); assert.equal(json.includes('credential_ref'), false); assert.equal(json.includes('synthetic archive UI password'), false); assert.equal(json.includes('preferences'),false);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='删除选中副本').disabled`),true);
  await ui.evaluate(`document.querySelector('[aria-label="确认删除副本"]').click()`);await ui.click('删除选中副本');await archiveMessage('副本已删除');
  assert.equal((await call({op:'archives'})).entries.some(entry=>entry.id===exported.id),false);
  const currentPreferences = await call({ op: 'preferences' });
  await call({ op: 'save_preferences', revision: currentPreferences.revision, preferences: initialPreferences.preferences });
  await ui.fill('配置名称', 'Archive changed'); await ui.click('保存配置'); await configMessage('配置已保存');
  await inspect(backup.id);
  assert.deepEqual((await call({ op: 'inspect_backup', id:backup.id })).preferences,backedPreferences);
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="备份桌面偏好"]').textContent.includes('22')`));
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="确认恢复备份"]').parentElement.textContent.includes('桌面偏好')`));
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="确认恢复备份"]').parentElement.textContent.includes('常用命令')`));
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="备份预览"]').textContent.includes('常用命令 0')`));
  await ui.evaluate(`document.querySelector('[aria-label="备份桌面偏好"]').scrollIntoView({block:'center'})`);
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="备份桌面偏好"]').textContent.includes('黑底绿字')`));
  await ui.screenshot('desktop-preferences-backup-native.png');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='替换当前配置').disabled`), true);
  await ui.fill('配置名称', 'Archive changed again'); await ui.click('保存配置'); await configMessage('配置已保存');
  await confirm(); await ui.click('替换当前配置'); await archiveMessage('配置已变化'); assert.equal((await profiles())[0].name, 'Archive changed again');
  await ui.click('预览选中备份'); await archiveMessage('备份验证完成'); await confirm(); await ui.click('替换当前配置'); await archiveMessage('当前配置已恢复');
  assert.equal((await profiles())[0].name, 'Archive original'); assert.deepEqual((await call({op:'preferences'})).preferences,backedPreferences); assert.equal((await call({ op: 'archives' })).entries.filter(entry => entry.kind === 'backup').length, 2);
  await ui.screenshot('P08.3-archives.png');
  await inspect(backup.id);
  const backupPath = path.join(directory, 'artifacts', backup.filename);
  const changed = new DatabaseSync(backupPath); changed.prepare('UPDATE profiles SET name=?').run('Backup modified since preview'); changed.close();
  await confirm(); await ui.click('替换当前配置'); await archiveMessage('配置已变化'); assert.equal((await profiles())[0].name, 'Archive original');
  await close();
  const sourcePath = path.join(directory, 'config.sqlite'); const newer = new DatabaseSync(sourcePath); newer.exec('PRAGMA user_version=99'); newer.close(); const before = await readFile(sourcePath);
  await open(); await configMessage('数据库版本不受支持'); await inspect(backup.id);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='替换当前配置').disabled`), true);
  await confirm(); await ui.click('恢复到新目录'); await archiveMessage('恢复目录已准备');
  const text = await ui.evaluate(`document.querySelector('[aria-label="备份状态"]').textContent`); const id = /recovered-([0-9a-f-]{36})/.exec(text)?.[1]; assert.ok(id);
  assert.ok(text.includes('1 个配置需要重新输入凭据')); const recovered = path.join(directory, `recovered-${id}`);
  assert.deepEqual(await readFile(sourcePath), before); await close();
  await open(recovered); await configMessage('配置已加载');
  assert.deepEqual((await call({op:'preferences'})).preferences,backedPreferences);
  const page = await call({ op: 'page', revision: null, offset: 0, folders: false }); assert.equal(page.profiles[0].name, 'Backup modified since preview'); assert.deepEqual(page.missing_credential_profiles, [page.profiles[0].id]);
  await ui.waitFor(`document.querySelector('.profile-list').textContent.includes('凭据引用缺失')`);
  await ui.evaluate(`document.querySelector('.profile-list button').click()`); await ui.fill('凭据操作', 'clear'); await ui.click('保存配置'); await configMessage('配置已保存'); assert.equal((await profiles())[0].credential_ref, null);
  await close();
  await writeFile('artifacts/P08.3-archive-ui-result.json', JSON.stringify({ result: 'PASS', scenarios: ['UI backup/export without secrets', 'confirmation required and stale target/source rejected', 'transaction restore keeps previous backup', 'unknown schema preserved; recover to new directory', 'start recovered directory; missing credential prompt and repair'], note: 'synthetic configurations; no device/session commands' }, null, 2));
  console.log('PASS: native backup/export/preview/restore, stale confirmation and new-directory recovery');
} finally {
  await ui?.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('shared-terminal-archive-ui-中文-')); await rm(directory, { recursive: true, maxRetries: 20, retryDelay: 100 });
}
