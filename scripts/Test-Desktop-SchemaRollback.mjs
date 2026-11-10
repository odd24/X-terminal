import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function verifiedPreview(id, head) {
  const directory = path.resolve('artifacts', `shared-terminal-preview-${id}`);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.packagedFromHead, head);
  assert.match(manifest.smoke, /^PASS: copied desktop\/ordinary sibling service/);
  assert.deepEqual(manifest.files.map(file => file.name).sort(),
    ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(directory, file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
  }
  return { id, head, executable: path.join(directory, 'shared-terminal-desktop.exe') };
}

const legacy = await verifiedPreview('ebabd174-4402-4e68-a28a-b9d9af1694dd', '41917a713fc6a289d261f0861e722330e5e11a79');
const current = await verifiedPreview('a38cc309-3888-4aaf-8e1c-c821d347ad5a', 'adbd3d138309cd309308b07b0ad6fb1e580d68a5');
const prefix = 'shared-terminal-schema-rollback-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const active = path.join(root, '原应用数据');
const recovery = path.join(root, '独立恢复数据');
const database = path.join(active, 'config.sqlite');
const copy = path.join(recovery, 'config.sqlite');
const button = label => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
const configStatus = text => `document.querySelector('[aria-label="配置状态"]')?.textContent.includes(${JSON.stringify(text)})`;
const config = (ui, request) => ui.invoke('config_request', { request });
const page = (ui, folders = false) => config(ui, { op: 'page', revision: null, offset: 0, folders });
const workspaces = ui => config(ui, { op: 'workspaces' });
const backups = async directory => (await readdir(directory)).filter(name => /^config-before-v\d+-.*\.sqlite$/.test(name));
let ui, report;

function inspect(file) {
  const sql = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = query => sql.prepare(query).all();
    assert.equal(sql.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(rows('PRAGMA foreign_key_check'), []);
    return {
      version: sql.prepare('PRAGMA user_version').get().user_version,
      applicationId: sql.prepare('PRAGMA application_id').get().application_id,
      migrations: rows('SELECT version FROM schema_migrations ORDER BY version').map(row => row.version),
      tables: rows("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"),
      data: Object.fromEntries(['folders', 'profiles', 'host_keys', 'desktop_preferences', 'workspaces']
        .map(table => [table, rows(`SELECT * FROM ${table} ORDER BY 1`)])),
    };
  } finally { sql.close(); }
}
async function identity(file) {
  const entry = await stat(file, { bigint: true });
  return { volume: String(entry.dev), index: String(entry.ino), sha256: sha256(await readFile(file)) };
}
async function idle(ui) {
  assert.deepEqual(await ui.invoke('service_list'), []);
  assert.deepEqual((await ui.invoke('agent_management_request', { request: { op: 'grant_list' } })).data, []);
}
async function boot(preview, directory, webview) {
  ui = await launchDesktop(directory, { executable: preview.executable, webviewDirectory: path.join(root, webview) });
  const owner = await ui.invoke('service_status');
  assert.equal(owner.fixture, false);
  await idle(ui);
  return owner;
}
async function close() {
  await idle(ui);
  await ui.evaluate(`(()=>{
    const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click();
    setTimeout(()=>${button('退出桌面')}.click(),50);
  })()`);
  for (let i = 0; i < 160 && ui.app.exitCode === null; i++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  await ui.close();
  ui = undefined;
}

try {
  await mkdir(active);
  const original = await boot(legacy, active, '旧版种子WebView');
  await ui.click('连接配置');
  await ui.waitFor(configStatus('配置已加载'));
  await ui.fill('目录名称', '回退合成目录');
  await ui.click('保存目录');
  await ui.waitFor(configStatus('目录已保存'));
  const { folders } = await page(ui, true);
  assert.equal(folders.length, 1);
  await ui.fill('配置名称', '回退合成 SSH2');
  await ui.fill('所属目录', folders[0].id);
  await ui.fill('主机', 'rollback-synthetic.invalid');
  await ui.fill('用户名', 'synthetic');
  await ui.click('保存配置');
  await ui.waitFor(configStatus('配置已保存'));
  const { profiles } = await page(ui);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].credential_ref, null);
  const tabs = [0, 1].map(() => ({ id: randomUUID(), profile_id: profiles[0].id, group_id: null }));
  const workspace = {
    id: randomUUID(), name: '回退布局标记', groups: [], tabs, selected_tab: tabs[0].id,
    navigation_open: true, split: { direction: 'horizontal', tabs: tabs.map(tab => tab.id) },
  };
  const { revision } = await workspaces(ui);
  await config(ui, { op: 'save_workspace', workspace, revision });
  assert.deepEqual((await workspaces(ui)).workspaces, [workspace]);
  await close();
  const seeded = inspect(database);
  assert.equal(seeded.version, 6);
  assert.deepEqual(seeded.migrations, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await backups(active), []);

  const upgraded = await boot(current, active, '升级WebView');
  assert.deepEqual((await page(ui)).profiles, profiles);
  assert.deepEqual((await page(ui, true)).folders, folders);
  assert.deepEqual((await workspaces(ui)).workspaces, [workspace]);
  assert.deepEqual((await config(ui, { op: 'quick_commands' })).commands, []);
  assert.equal(inspect(database).version, 7);
  const backupNames = await backups(active);
  assert.equal(backupNames.length, 1);
  assert.match(backupNames[0], /^config-before-v6-/);
  const backup = path.join(active, backupNames[0]);
  assert.deepEqual(inspect(backup), seeded);
  const backupIdentity = await identity(backup);
  const addedFolder = { id: randomUUID(), name: '仅新版新增的目录', parent_id: null };
  await config(ui, { op: 'save_folder', folder: addedFolder });
  assert.ok((await page(ui, true)).folders.some(folder => folder.id === addedFolder.id));
  await close();
  const migrated = inspect(database);
  assert.equal(migrated.version, 7);
  assert.deepEqual(migrated.migrations, [1, 2, 3, 4, 5, 6, 7]);
  const migratedIdentity = await identity(database);

  const refused = await boot(legacy, active, '旧版拒绝WebView');
  const unsupported = { result: 'error', code: 'UNSUPPORTED_SCHEMA' };
  assert.deepEqual(await page(ui), unsupported);
  await ui.click('连接配置');
  await ui.waitFor(configStatus('数据库版本不受支持，未覆盖文件。请使用匹配版本或备份，并重新启动。'));
  assert.equal(await ui.evaluate(`${button('保存配置')}.matches(':disabled')`), true);
  assert.deepEqual(await config(ui, {
    op: 'save_folder', folder: { id: randomUUID(), name: '禁止写入的合成目录', parent_id: null },
  }), unsupported);
  await close();
  assert.deepEqual(await identity(database), migratedIdentity);
  assert.deepEqual(inspect(database), migrated);
  assert.deepEqual(await backups(active), backupNames);
  assert.deepEqual(await identity(backup), backupIdentity);

  await mkdir(recovery);
  assert.deepEqual(await readdir(recovery), []);
  await copyFile(backup, copy, constants.COPYFILE_EXCL);
  assert.equal((await identity(copy)).sha256, backupIdentity.sha256);
  assert.deepEqual(inspect(copy), seeded);
  const restored = await boot(legacy, recovery, '旧版恢复WebView');
  assert.deepEqual((await page(ui)).profiles, profiles);
  assert.deepEqual((await page(ui, true)).folders, folders);
  assert.deepEqual((await workspaces(ui)).workspaces, [workspace]);
  await ui.click('连接配置');
  await ui.waitFor(configStatus('配置已加载'));
  await ui.waitFor(`document.querySelector('.profile-list')?.textContent.includes('回退合成 SSH2')`);
  await close();
  assert.deepEqual(inspect(copy), seeded);
  assert.deepEqual(await identity(database), migratedIdentity);
  assert.deepEqual(await identity(backup), backupIdentity);
  assert.equal(new Set([original, upgraded, refused, restored].map(owner => owner.service_id)).size, 4);
  report = {
    result: 'PASS', legacy: legacy.head, current: current.head, versions: [6, 7, 6],
    rejection: unsupported.code, upgradedDatabase: migratedIdentity, preMigrationBackup: backupIdentity,
    restoredProfiles: profiles.length, restoredWorkspace: workspace.name, newerFolderAbsentFromSnapshot: true,
    normalDesktopExits: 4,
  };
} catch (error) {
  console.error('P24 owned rollback evidence root retained:', root);
  throw error;
} finally {
  await ui?.close();
}
const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile('artifacts/P24-schema-rollback.json', JSON.stringify(report, null, 2) + '\n');
console.log('PASS ordinary schema 6 to 7 upgrade, legacy refusal, and isolated schema 6 snapshot recovery');
