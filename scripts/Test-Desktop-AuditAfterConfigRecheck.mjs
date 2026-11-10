import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';

const feedback = process.argv.includes('--grant-feedback');
const baseline = process.argv.includes('--grant-feedback-baseline');
const auditReadFailure = feedback && process.argv.includes('--audit-read-failure');
const previewPath = feedback ? 'artifacts/P22-audit-grant-feedback-preview.json' : 'artifacts/P24-save-recovery-preview.json';
const preview = JSON.parse(await readFile(previewPath, 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}

const prefix = 'shared-terminal-audit-recheck-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const executable = path.join(preview.directory, 'shared-terminal-desktop.exe');
const config = (ui, request) => ui.invoke('config_request', { request });
const page = ui => config(ui, { op: 'page', revision: null, offset: 0, folders: false });
const agent = (ui, request) => ui.invoke('agent_management_request', { request });
const agentError = (ui, request) => ui.evaluate(
  `window.__TAURI_INTERNALS__.invoke('agent_management_request',${JSON.stringify({ request })}).then(()=>null,e=>String(e))`);
const audit = ui => ui.invoke('audit_history_request', { request: { op: 'info' } });
const owner = ui => ui.invoke('service_status');
const feedbackText = '当前服务的持久审计不可用，新 Agent 授权已阻止';
const genericText = '操作未确认：CapacityExceeded';
const managementStatus = text => `document.querySelector('[aria-label="Agent管理状态"]')?.textContent.includes(${JSON.stringify(text)})`;
let first, second, reopened, result;

function boot(label) {
  return launchDesktop(root, { executable, webviewDirectory: path.join(root, label) });
}
async function close(ui, status) {
  await ui.evaluate(`(()=>{
    const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click();
    setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出桌面').click(),50);
  })()`);
  for (let i = 0; i < 160 && ui.app.exitCode === null; i++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  await ui.close();
  const receipt = JSON.parse(await readFile(path.join(root, 'desktop-close-receipts-v1', `${status.service_id}.json`), 'utf8'));
  assert.equal(receipt.service_id, status.service_id);
  assert.equal(receipt.owned_pid, status.pid);
  assert.equal(receipt.shutdown_ack, 'ACKNOWLEDGED');
  assert.equal(receipt.exited, true);
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.kill_requested, false);
  return receipt.reader.diagnostic;
}
async function expectAudit(ui, status, state) {
  const observed = await audit(ui);
  assert.equal(observed.type, 'info');
  assert.equal(observed.service_id, status.service_id);
  assert.equal(observed.status.state, state);
  return observed;
}
async function approveProfile(ui, profileId) {
  await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权类型"]')`);
  await ui.fill('Agent授权类型', 'profile');
  await ui.click('读取Agent建连配置');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="Agent建连配置"]')?.options??[]).some(o=>o.value===${JSON.stringify(profileId)})`);
  await ui.fill('Agent建连配置', profileId);
  await ui.click('预览Agent建连授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="同意Agent固定配置建连"]')`);
  await ui.evaluate(`document.querySelector('[aria-label="同意Agent固定配置建连"]').click()`);
  await ui.click('确认批准Agent建连');
}

try {
  first = await boot('首个所有者');
  const original = await owner(first);
  assert.equal(original.fixture, false);
  await expectAudit(first, original, 'HEALTHY');
  const profile = {
    id: randomUUID(), folder_id: null, name: '合成审计复查配置',
    settings: { protocol: 'ssh2', host: 'audit-recheck.invalid', port: 22, username: 'synthetic', auth: 'password', encoding: 'utf8' },
  };
  const saved = await config(first, { op: 'save_profile', profile, credential: { action: 'keep' } });
  assert.equal(saved.result, 'saved_profile');
  assert.equal(saved.profile.credential_ref, null);
  const grant = request_id => ({
    op: 'grant', request_id, lifetime_ms: 30000,
    scopes: [{ target: { kind: 'profile', profile_id: profile.id }, action: 'CONNECT' }],
  });
  const originalId = randomUUID();
  const originalGrant = await agent(first, grant(originalId));
  assert.deepEqual(originalGrant.data.effective_scopes, grant(originalId).scopes);
  assert.deepEqual(await first.invoke('service_list'), []);

  second = await boot('受锁第二窗口');
  const lockedOwner = await owner(second);
  assert.equal(lockedOwner.fixture, false);
  assert.notEqual(lockedOwner.service_id, original.service_id);
  const locked = { result: 'error', code: 'LOCKED' };
  assert.deepEqual(await page(second), locked);
  const initialAudit = await expectAudit(second, lockedOwner, 'STORAGE_FAILURE');
  assert.equal(initialAudit.status.accepted_through, '0');
  assert.equal(initialAudit.status.synced_through, '0');
  await second.click('连接服务器');
  await second.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('未取得配置目录的独占访问权')`);
  assert.equal((await close(first, original)).outcome, 'CLOSED');
  first = undefined;

  assert.deepEqual(await page(second), locked);
  await second.click('重新检查配置目录');
  await second.waitFor(`Array.from(document.querySelector('[aria-label="快速连接已保存"]')?.options??[]).some(o=>o.value===${JSON.stringify(profile.id)})`);
  const rechecked = await owner(second);
  assert.equal(rechecked.service_id, lockedOwner.service_id);
  assert.equal(rechecked.pid, lockedOwner.pid);
  assert.deepEqual((await page(second)).profiles, [saved.profile]);
  assert.deepEqual(await expectAudit(second, lockedOwner, 'STORAGE_FAILURE'), initialAudit);
  await second.click('收起连接窗口');
  let deniedId, visibleFeedback, auditInfoReads;
  if (feedback || baseline) {
    const auditInfo = await second.interceptIpc({
      command: 'audit_history_request', op: 'info', mode: auditReadFailure ? 'error' : 'delay', delayMs: 0,
    });
    const explained = feedback && !auditReadFailure;
    await approveProfile(second, profile.id);
    await second.waitFor(managementStatus(explained ? feedbackText : genericText));
    visibleFeedback = await second.evaluate(`document.querySelector('[aria-label="Agent管理状态"]').textContent`);
    assert.equal(visibleFeedback.includes(feedbackText), explained);
    deniedId = await second.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`);
    await second.click('查询原Agent编号');
    await second.waitFor(managementStatus('NotFound'));
    assert.equal(await second.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`), deniedId);
    auditInfoReads = await auditInfo.count();
    assert.equal(auditInfoReads, feedback ? 1 : 0);
    await auditInfo.restore();
    await second.click('关闭Agent授权');
  } else {
    deniedId = randomUUID();
    assert.equal(await agentError(second, grant(deniedId)), 'CapacityExceeded');
  }
  assert.equal(await agentError(second, { op: 'grant_status', request_id: deniedId }), 'NotFound');
  assert.deepEqual((await agent(second, { op: 'grant_list' })).data, []);
  assert.deepEqual(await second.invoke('service_list'), []);
  assert.equal(await close(second, lockedOwner), null);
  second = undefined;

  reopened = await boot('正常重开窗口');
  const restarted = await owner(reopened);
  assert.equal(restarted.fixture, false);
  assert.notEqual(restarted.service_id, lockedOwner.service_id);
  const recoveredAudit = await expectAudit(reopened, restarted, 'HEALTHY');
  assert.deepEqual((await page(reopened)).profiles, [saved.profile]);
  assert.deepEqual(await reopened.invoke('service_list'), []);
  assert.deepEqual((await agent(reopened, { op: 'grant_list' })).data, []);
  assert.equal(await agentError(reopened, { op: 'grant_status', request_id: originalId }), 'NotFound');
  assert.equal(await agentError(reopened, { op: 'grant_status', request_id: deniedId }), 'NotFound');
  if (feedback) {
    const auditInfo = await reopened.interceptIpc({ command: 'audit_history_request', op: 'info', mode: 'delay', delayMs: 0 });
    await approveProfile(reopened, profile.id);
    await reopened.waitFor(managementStatus('已签发限时授权'));
    assert.equal(await auditInfo.count(), 0);
    assert.equal((await agent(reopened, { op: 'grant_list' })).data.length, 1);
    await auditInfo.restore();
    await reopened.click('关闭Agent授权');
  } else {
    const freshId = randomUUID();
    const fresh = await agent(reopened, grant(freshId));
    assert.deepEqual(fresh.data.effective_scopes, grant(freshId).scopes);
  }
  assert.deepEqual(await reopened.invoke('service_list'), []);
  assert.equal((await close(reopened, restarted)).outcome, 'CLOSED');
  reopened = undefined;
  result = {
    result: 'PASS', original: original.service_id, rechecked: rechecked.service_id, restarted: restarted.service_id,
    auditOnLockedStartup: initialAudit.status, auditAfterRecheck: initialAudit.status,
    newGrantAfterRecheck: 'CapacityExceeded', recheckedCloseDiagnostic: null,
    auditAfterRestart: recoveredAudit.status, freshGrantAfterRestart: true, oldGrantRestored: false,
    ...(visibleFeedback ? { visibleFeedback, guiOriginalNumberQuery: 'NotFound', auditReadFailure, auditInfoReads } : {}),
  };
} catch (error) {
  console.error('P22/P24 owned audit-recheck root retained:', root);
  throw error;
} finally {
  await Promise.all([first?.close(), second?.close(), reopened?.close()]);
}
const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
const evidence = auditReadFailure ? 'P22-audit-grant-feedback-fallback'
  : feedback ? 'P22-audit-grant-feedback' : baseline ? 'P22-audit-grant-feedback-baseline' : 'P22-audit-after-config-recheck';
await writeFile(`artifacts/${evidence}.json`, JSON.stringify(result, null, 2) + '\n');
console.log('PASS ordinary Desktop configuration recheck leaves audit fail-closed until a normal restart');
