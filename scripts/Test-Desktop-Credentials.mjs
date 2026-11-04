import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-credentials-ui-'));
let ui;
const message = text => ui.waitFor(`document.querySelector('[aria-label="凭据整理状态"]').textContent.includes(${JSON.stringify(text)})`);
const configMessage = text => ui.waitFor(`document.querySelector('[aria-label="配置状态"]').textContent.includes(${JSON.stringify(text)})`);
const call = request => ui.invoke('config_request', { request });
async function open() { ui = await launchDesktop(directory); await ui.click('连接配置'); await message('凭据元数据已加载'); await configMessage('配置已加载'); }
async function close() { await ui.click('退出桌面'); for (let n=0;n<100 && ui.app.exitCode===null;n++) await delay(50); assert.notEqual(ui.app.exitCode,null); await ui.close(); ui=null; }
async function inspect() { await ui.click('检查选中凭据'); await message('凭据引用已核对'); }
const forgetDisabled = () => ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='遗忘选中凭据').disabled`);
try {
  await open();
  await ui.fill('配置名称','Credential cleanup fixture');await ui.fill('主机','example.invalid');await ui.fill('用户名','synthetic');await ui.fill('凭据操作','replace');await ui.fill('新密码','synthetic cleanup UI secret');await ui.click('保存配置');await configMessage('配置已保存');
  await ui.click('刷新凭据列表');await message('凭据元数据已加载');await inspect();
  assert.equal(await forgetDisabled(),true);
  await ui.waitFor(`document.querySelector('[aria-label="凭据引用预览"]').textContent.includes('当前配置引用 1')`);
  const inventory=await call({op:'credentials_page',revision:null,offset:0});assert.equal(inventory.entries.length,1);
  assert.equal(JSON.stringify(inventory).includes('synthetic cleanup UI secret'),false);
  await ui.click('创建配置备份');await ui.waitFor(`document.querySelector('[aria-label="备份状态"]').textContent.includes('配置备份已保存')`);
  const backup=(await call({op:'archives'})).entries[0];
  await ui.fill('凭据操作','clear');await ui.click('保存配置');await configMessage('配置已保存');await inspect();
  await ui.waitFor(`document.querySelector('[aria-label="凭据引用预览"]').textContent.includes('受管理备份引用 1')`);
  await ui.evaluate(`document.querySelector('[aria-label="确认遗忘凭据"]').click()`);assert.equal(await forgetDisabled(),true);
  await ui.fill('已保存副本',`backup:${backup.id}`);await ui.evaluate(`document.querySelector('[aria-label="确认删除副本"]').click()`);await ui.click('删除选中副本');await ui.waitFor(`document.querySelector('[aria-label="备份状态"]').textContent.includes('副本已删除')`);
  await inspect();assert.equal(await forgetDisabled(),true);
  await call({op:'save_folder',folder:{id:crypto.randomUUID(),parent_id:null,name:'New revision'}});
  await ui.evaluate(`document.querySelector('[aria-label="确认遗忘凭据"]').click()`);await ui.click('遗忘选中凭据');await message('配置已变化');
  assert.equal((await call({op:'credentials_page',revision:null,offset:0})).entries.length,1);
  await inspect();await ui.waitFor(`document.querySelector('[aria-label="保存的凭据"]').selectedOptions[0].textContent.includes('当前配置引用 0')`);await ui.screenshot('P08.3-credential-cleanup.png');
  await ui.evaluate(`document.querySelector('[aria-label="确认遗忘凭据"]').click()`);await ui.click('遗忘选中凭据');await message('选中凭据已遗忘');
  assert.equal((await call({op:'credentials_page',revision:null,offset:0})).entries.length,0);
  await close();await open();assert.equal((await call({op:'credentials_page',revision:null,offset:0})).entries.length,0);await close();
  await writeFile('artifacts/P08.3-credentials-ui-result.json',JSON.stringify({result:'PASS',scenarios:['metadata contains no secret','live and managed backup references prevent forgetting','checkbox required','stale preview rejected','explicit orphan delete persists across native restart'],note:'synthetic credentials, no real devices'},null,2));
  console.log('PASS: native credential inventory, reference protection, stale confirmation and orphan forgetting/restart');
} finally {
  await ui?.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('shared-terminal-credentials-ui-'));await rm(directory,{recursive:true,maxRetries:20,retryDelay:100});
}
