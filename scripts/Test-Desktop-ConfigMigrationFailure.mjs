import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';

const preview = JSON.parse(await readFile('artifacts/P24-save-recovery-preview.json', 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(preview.result, 'PASS');
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(sha256(bytes), file.sha256);
}

const prefix = 'shared-terminal-config-migration-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const original = path.join(root, '原应用数据');
const recovery = path.join(root, '恢复应用数据');
const database = path.join(original, 'config.sqlite');
const recoveredDatabase = path.join(recovery, 'config.sqlite');
const executable = path.join(preview.directory, 'shared-terminal-desktop.exe');
const reason = '配置或凭据库损坏，未重建文件。请保留原文件并使用备份恢复后重新启动。';
const sentinel = 'P24_SYNTHETIC_SCHEMA_7_ABORT';
const config = (ui, request) => ui.invoke('config_request', { request });
const page = (ui, folders = false) => config(ui, { op: 'page', revision: null, offset: 0, folders });
const configStatus = text => `document.querySelector('[aria-label="配置状态"]')?.textContent.includes(${JSON.stringify(text)})`;
const button = label => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
let ui;

function withSql(file, readOnly, action) {
  const sql = new DatabaseSync(file, { readOnly });
  try { return action(sql); } finally { sql.close(); }
}
function snapshot(file) {
  return withSql(file, true, sql => {
    const rows = query => sql.prepare(query).all();
    assert.equal(sql.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(rows('PRAGMA foreign_key_check'), []);
    return {
      version: sql.prepare('PRAGMA user_version').get().user_version,
      applicationId: sql.prepare('PRAGMA application_id').get().application_id,
      schema: rows("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      migrations: rows('SELECT version FROM schema_migrations ORDER BY version').map(row => row.version),
      data: Object.fromEntries(['folders', 'profiles', 'host_keys', 'desktop_preferences', 'workspaces']
        .map(table => [table, rows(`SELECT * FROM ${table} ORDER BY 1`)])),
    };
  });
}
const backups = async directory => (await readdir(directory))
  .filter(name => /^config-before-v\d+-.*\.sqlite$/.test(name));
async function assertIdle(app) {
  assert.deepEqual(await app.invoke('service_list'), []);
  assert.deepEqual((await app.invoke('agent_management_request', { request: { op: 'grant_list' } })).data, []);
}
async function boot(directory, label) {
  ui = await launchDesktop(directory, { executable, webviewDirectory: path.join(directory, label) });
  const status = await ui.invoke('service_status');
  assert.equal(status.fixture, false);
  await assertIdle(ui);
  return status;
}
async function close(directory, status) {
  await ui.evaluate(`(()=>{
    const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click();
    setTimeout(()=>${button('退出桌面')}.click(),50);
    return true;
  })()`);
  for (let i = 0; i < 160 && ui.app.exitCode === null; i++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  await ui.close();
  ui = undefined;
  const receipt = JSON.parse(await readFile(path.join(directory, 'desktop-close-receipts-v1', `${status.service_id}.json`), 'utf8'));
  assert.equal(receipt.service_id, status.service_id);
  assert.equal(receipt.owned_pid, status.pid);
  assert.equal(receipt.shutdown_ack, 'ACKNOWLEDGED');
  assert.equal(receipt.exited, true);
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.kill_requested, false);
}

try {
  const seeded = await boot(original, 'webview-seed');
  await ui.click('连接配置');
  await ui.waitFor(configStatus('配置已加载'));
  await ui.fill('目录名称', '迁移实验组');
  await ui.click('保存目录');
  await ui.waitFor(configStatus('目录已保存'));
  const { folders } = await page(ui, true);
  assert.equal(folders.length, 1);
  await ui.fill('配置名称', '迁移合成 SSH2');
  await ui.fill('所属目录', folders[0].id);
  await ui.fill('主机', 'migration-synthetic.invalid');
  await ui.fill('用户名', 'synthetic');
  await ui.click('保存配置');
  await ui.waitFor(configStatus('配置已保存'));
  const { profiles } = await page(ui);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].credential_ref, null);
  await assertIdle(ui);
  await close(original, seeded);

  const current = snapshot(database);
  assert.equal(current.version, 7);
  assert.deepEqual(await backups(original), []);
  withSql(database, false, sql => sql.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE quick_commands;
    DELETE FROM schema_migrations WHERE version=7;
    PRAGMA user_version=6;
    CREATE TRIGGER p24_fail_v7 BEFORE INSERT ON schema_migrations
    WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'${sentinel}'); END;
    COMMIT;
  `));
  const legacy = snapshot(database);
  assert.equal(legacy.version, 6);
  assert.deepEqual(legacy.migrations, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(legacy.data, current.data);
  const originalHash = sha256(await readFile(database));
  const originalIdentity = await stat(database, { bigint: true });

  const failed = await boot(original, 'webview-failure');
  assert.deepEqual(await page(ui), { result: 'error', code: 'CORRUPT' });
  await ui.click('连接服务器');
  await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes(${JSON.stringify(reason)})`);
  assert.ok(await ui.evaluate(`document.querySelector('dialog:modal [role="alert"]').textContent.includes('读取连接配置失败')`));
  assert.equal(await ui.evaluate(`${button('连接')}.disabled`), true);
  assert.equal(await ui.evaluate(`document.body.innerText.includes(${JSON.stringify(sentinel)})`), false);
  assert.deepEqual(await config(ui, { op: 'recheck', service_id: failed.service_id }), { result: 'error', code: 'CORRUPT' });
  await assertIdle(ui);
  await ui.click('收起连接窗口');
  await close(original, failed);

  assert.deepEqual(snapshot(database), legacy);
  assert.equal(sha256(await readFile(database)), originalHash);
  const [backupName, ...extra] = await backups(original);
  assert.match(backupName, /^config-before-v6-/);
  assert.deepEqual(extra, []);
  const backup = path.join(original, backupName);
  assert.deepEqual(snapshot(backup), legacy);
  const backupHash = sha256(await readFile(backup));

  await mkdir(recovery);
  await copyFile(backup, recoveredDatabase, constants.COPYFILE_EXCL);
  assert.equal(sha256(await readFile(recoveredDatabase)), backupHash);
  withSql(recoveredDatabase, false, sql => sql.exec('DROP TRIGGER p24_fail_v7'));
  const cleanLegacy = { ...legacy, schema: legacy.schema.filter(row => row.name !== 'p24_fail_v7') };
  assert.deepEqual(snapshot(recoveredDatabase), cleanLegacy);
  const restored = await boot(recovery, 'webview-restored');
  assert.notEqual(restored.service_id, failed.service_id);
  assert.deepEqual((await page(ui)).profiles, profiles);
  assert.deepEqual((await page(ui, true)).folders, folders);
  assert.deepEqual((await config(ui, { op: 'quick_commands' })).commands, []);
  await ui.click('连接配置');
  await ui.waitFor(configStatus('配置已加载'));
  await ui.waitFor(`document.querySelector('.profile-list')?.textContent.includes('迁移合成 SSH2')`);
  await assertIdle(ui);
  await close(recovery, restored);
  assert.deepEqual(snapshot(recoveredDatabase), current);
  const recoveryBackups = await backups(recovery);
  assert.equal(recoveryBackups.length, 1);
  assert.deepEqual(snapshot(path.join(recovery, recoveryBackups[0])), cleanLegacy);
  const after = await stat(database, { bigint: true });
  assert.equal(after.dev, originalIdentity.dev);
  assert.equal(after.ino, originalIdentity.ino);
  assert.equal(sha256(await readFile(database)), originalHash);
  assert.equal(sha256(await readFile(backup)), backupHash);

  const resolvedRoot = await realpath(root);
  const resolvedRecovery = await realpath(recovery);
  assert.equal(path.dirname(resolvedRoot), await realpath(tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith(prefix));
  assert.equal(resolvedRecovery, path.join(resolvedRoot, '恢复应用数据'));
  await rm(resolvedRecovery, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  const result = {
    result: 'PASS', preview: preview.directory, failure: 'CORRUPT', failedService: failed.service_id,
    recoveredService: restored.service_id, originalVersion: legacy.version, recoveredVersion: current.version,
    preservedFailureRoot: await realpath(original), originalHash, backupName, backupHash,
  };
  await writeFile('artifacts/P24-config-migration-failure.json', JSON.stringify(result, null, 2) + '\n');
  console.log('PASS ordinary Desktop configuration migration rollback, preserved backup and explicit recovery in a new root');
} catch (error) {
  console.error('P24 owned evidence root retained:', root);
  throw error;
} finally {
  await ui?.close();
}
