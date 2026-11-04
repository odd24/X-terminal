import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-config-ui-'));
const secret = 'synthetic-password-P08.3-only';
const syntheticKey='-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-key-import-only\n-----END OPENSSH PRIVATE KEY-----\n';
let ui;
const page = () => ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
const message = text => ui.waitFor(`document.querySelector('[aria-label="配置状态"]').textContent.includes(${JSON.stringify(text)})`);
const pick = name => ui.evaluate(`Array.from(document.querySelectorAll('.profile-list button')).find(button => button.firstChild?.textContent === ${JSON.stringify(name)}).click()`);
async function open() { ui = await launchDesktop(directory); await ui.click('连接配置'); await message('配置已加载'); }
async function close() {
  await ui.click('退出桌面');
  for (let attempt = 0; attempt < 100 && ui.app.exitCode === null; attempt++) await delay(50);
  assert.notEqual(ui.app.exitCode, null, 'normal desktop close must complete');
  await ui.close(); ui = null;
}
try {
  await open();
  await ui.fill('目录名称', '实验组'); await ui.click('保存目录'); await message('目录已保存');
  const folder = (await ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: true } })).folders[0];
  await ui.fill('配置名称', 'SSH2 合成'); await ui.fill('所属目录', folder.id);
  await ui.fill('主机', 'example.invalid'); await ui.fill('用户名', 'synthetic');
  await ui.fill('凭据操作', 'replace'); await ui.fill('新密码', secret); await ui.click('保存配置'); await message('配置已保存');
  let data = await page(); assert.equal(data.profiles.length, 1);
  const original = data.profiles[0]; assert.ok(original.credential_ref);
  assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('input,textarea')).some(control => control.value === ${JSON.stringify(secret)})`), false, 'new secret must clear');
  await ui.fill('配置名称', 'SSH2 已更新'); await ui.click('保存配置'); await message('配置已保存');
  assert.equal((await page()).profiles[0].credential_ref, original.credential_ref);
  await ui.click('复制配置'); await ui.click('保存配置'); await message('配置已保存');
  data = await page(); assert.equal(data.profiles.length, 2); assert.equal(data.profiles.find(p => p.id !== original.id).credential_ref, null);
  await ui.click('删除配置'); await message('配置已删除'); assert.equal((await page()).profiles.length, 1);
  await ui.click('新建配置'); await ui.fill('协议', 'serial'); await ui.fill('配置名称', '串口合成');
  await ui.fill('串口标识', 'COM89'); await ui.fill('流控', 'hardware');
  await ui.click('保存配置'); await message('配置已保存');
  let serial = (await page()).profiles.find(p => p.settings.protocol === 'serial');
  assert.equal(serial.settings.rts_on_open, null); assert.equal(serial.settings.dtr_on_open, false); assert.equal(serial.credential_ref, null);
  await ui.click('新建配置'); await ui.fill('协议', 'ssh1'); await ui.fill('配置名称', '旧协议合成');
  await ui.fill('主机', 'legacy.invalid'); await ui.fill('用户名', 'synthetic');
  await ui.click('保存配置'); await delay(100); assert.equal((await page()).profiles.length, 2, 'SSH1 requires explicit checkbox');
  await ui.evaluate(`document.querySelector('[aria-label="显式开启SSH1"]').click()`);
  await ui.click('保存配置'); await message('配置已保存');
  assert.equal((await page()).profiles.find(p => p.settings.protocol === 'ssh1').settings.explicitly_enabled, true);
  const keyPath=path.join(directory,'synthetic-key-input');await writeFile(keyPath,syntheticKey);
  await ui.click('新建配置');await ui.fill('配置名称','私钥合成');await ui.fill('主机','key.invalid');await ui.fill('用户名','synthetic');await ui.fill('认证方式','public_key');await ui.fill('凭据操作','replace');await ui.fill('本地私钥文件',keyPath);await ui.click('保存配置');await message('配置已保存');
  const keyProfile=(await page()).profiles.find(p=>p.name==='私钥合成');assert.ok(keyProfile.credential_ref);
  assert.equal(JSON.stringify(await page()).includes('synthetic-key-import-only'),false);
  assert.equal(await ui.evaluate(`document.body.textContent.includes('synthetic-key-import-only')`),false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="私钥内容"]')===null`),true);
  assert.equal(await ui.invoke('config_request',{request:{op:'save_profile_key_file',profile:{id:crypto.randomUUID(),folder_id:null,name:'invalid key path',settings:keyProfile.settings},key_path:'\\\\.\\COM89',passphrase:null}}).then(reply=>reply.code),'INVALID');
  await ui.fill('编辑目录', folder.id); await ui.fill('目录名称', '工程组'); await ui.click('保存目录'); await message('目录已保存');
  await ui.click('删除目录'); await message('目录仍被引用');
  await ui.fill('目录筛选',folder.id);
  await pick('SSH2 已更新'); await ui.fill('所属目录', ''); await ui.click('保存配置'); await message('配置已保存');
  await ui.click('删除目录'); await message('目录已删除');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="目录筛选"]').value`),'*');
  assert.equal((await page()).profiles.find(p => p.id === original.id).folder_id, null);
  await close();

  await open(); data = await page(); assert.equal(data.profiles.length, 4);
  assert.equal(data.profiles.find(p => p.id === original.id).credential_ref, original.credential_ref);
  await pick('SSH2 已更新');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="凭据操作"]').value`), 'keep');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="新密码"]') === null`), true);
  assert.equal(JSON.stringify(data).includes(secret), false);
  const portableKey={id:keyProfile.id,folder_id:keyProfile.folder_id,name:keyProfile.name,settings:keyProfile.settings};
  assert.equal(await ui.invoke('config_request',{request:{op:'save_profile',profile:portableKey,credential:{action:'replace',value:{password:null,private_key:syntheticKey,passphrase:null}}}}).then(()=>false,()=>true),true,'native renderer entry must reject raw private-key material');
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('config_request',{request:{op:'read_credential',id:${JSON.stringify(original.credential_ref)}}}).then(() => false, () => true)`), true, 'secret reading must not be registered');
  await ui.screenshot('P08.3-profile-editor.png');
  await close();
  for (const name of ['config.sqlite', 'credentials.sqlite']) assert.equal((await readFile(path.join(directory, name))).includes(Buffer.from(secret)), false, `${name} must not contain plaintext marker`);

  const configPath = path.join(directory, 'config.sqlite');
  const db = new DatabaseSync(configPath); db.exec('PRAGMA user_version=99'); db.close();
  const newer = await readFile(configPath);
  ui = await launchDesktop(directory); await ui.click('连接配置'); await message('数据库版本不受支持');
  assert.equal(await ui.evaluate(`document.querySelector('.profile-form fieldset').disabled`), true);
  assert.equal(await ui.evaluate(`document.querySelector('.data-location').textContent.includes(${JSON.stringify(directory)})`), true);
  await close(); assert.deepEqual(await readFile(configPath), newer);
  await writeFile(configPath, 'synthetic corrupt config only'); const corrupt = await readFile(configPath);
  ui = await launchDesktop(directory); await ui.click('连接配置'); await message('库损坏');
  await close(); assert.deepEqual(await readFile(configPath), corrupt);
  await writeFile('artifacts/P08.3-config-ui-result.json', JSON.stringify({ result: 'PASS', scenarios: ['native folder/profile CRUD and move/copy', 'SSH2 credential keep without secret readback', 'serial RTS driver ownership; explicit SSH1', 'desktop restart persistence; plaintext marker absent', 'unknown/corrupt database diagnostic without overwrite'], note: 'synthetic configuration only; no endpoint/device opened' }, null, 2));
  console.log('PASS: native configuration editor, credentials, restart and corrupt/unknown schema diagnostics');
} finally {
  await ui?.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('shared-terminal-config-ui-'));
  await rm(directory, { recursive: true, maxRetries: 20, retryDelay: 100 });
}
