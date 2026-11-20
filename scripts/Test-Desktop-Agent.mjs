import { checkProfileConnect } from './lib/AgentProfileChecks.mjs';
import { checkForgetApproval } from './lib/AgentForgetChecks.mjs';
import { checkReadWindowApproval } from './lib/AgentContextChecks.mjs';
import { checkGrantForms } from './lib/AgentFormChecks.mjs';
import { checkOutputProtection } from './lib/AgentProtectionChecks.mjs';
import { checkAuditHistory } from './lib/AgentAuditChecks.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-agent-ui-中文-'));
let ui;
let fixture;
try {
  ui = await launchDesktop(directory, { fixture: true });
  const call = request => ui.invoke('agent_management_request', { request });
  const connection = await ui.invoke('fixture_create');
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  const scopes = ['READ', 'WRITE'].map(action => ({ target: { kind: 'connection', connection: ref }, action }));
  const request_id = randomUUID();
  const grant = { op: 'grant', request_id, scopes, lifetime_ms: 60000 };
  const first = await call(grant);
  assert.equal(first.type, 'grant');
  assert.equal(first.data.summary.state, 'ACTIVE');
  assert.equal(first.data.summary.request_id, request_id);
  assert.deepEqual(first.data.approved_scopes, scopes);
  assert.deepEqual(first.data.effective_scopes.map(s => s.action).sort(), ['READ', 'WRITE']);
  assert.ok(first.data.effective_scopes.every(s => JSON.stringify(s.target) === JSON.stringify(scopes[0].target)));
  assert.equal('token' in first, false);
  assert.equal('token' in first.data, false);
  assert.deepEqual(await call(grant), first, 'same native request recovers the original receipt');
  const list = await call({ op: 'grant_list' });
  assert.equal(list.type, 'grant_list'); assert.equal(list.data.length, 1);
  assert.equal(list.data[0].ticket_id, first.data.summary.ticket_id);
  assert.equal(JSON.stringify(list).includes('token'), false);
  for (const request of [
    { ...grant, lifetime_ms: 1 },
    { ...grant, request_id: randomUUID(), role: 'desktop' },
    { op: 'acquire', connection: ref, lifetime_ms: 1000 },
    { op: 'release', connection: ref, lease_id: randomUUID() },
    { op: 'grant_status', request_id, token: 'synthetic-rejected-secret' },
    { op: 'audit', cursor: 0, limit: 1, path: 'rejected' },
  ]) await assert.rejects(call(request));
  assert.deepEqual(await call({ op: 'lease', connection: ref }), { type: 'lease', data: null });
  await call({ op: 'takeover', connection: ref });
  const after = await call({ op: 'grant_status', request_id });
  assert.equal(after.data.summary.state, 'ACTIVE', 'ticket validity differs from executable scopes');
  assert.deepEqual(after.data.approved_scopes, scopes);
  assert.deepEqual(after.data.effective_scopes, scopes.slice(0, 1));
  assert.equal(after.data.summary.expires_at_ms, first.data.summary.expires_at_ms);
  const audit = await call({ op: 'audit', cursor: 0, limit: 128 });
  assert.equal(audit.type, 'audit'); assert.equal(audit.data.gap, false);
  assert.ok(audit.data.events.some(event => event.kind === 'TAKEOVER'));
  assert.equal(JSON.stringify(audit).includes('token'), false);
  const lost = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'error' });
  const unknown_id = randomUUID();
  try {
    await assert.rejects(call({ ...grant, request_id: unknown_id }));
    assert.equal(await lost.count(), 1);
  } finally { await lost.restore(); }
  const restored = await call({ op: 'grant_status', request_id: unknown_id });
  assert.equal(restored.data.summary.state, 'ACTIVE');
  assert.equal((await call({ op: 'grant_list' })).data.length, 2);
  await ui.command('Page.reload');
  assert.deepEqual(await call({ op: 'grant_status', request_id: unknown_id }), restored);
  const revoked = await call({ op: 'grant_revoke', request_id: unknown_id });
  assert.equal(revoked.data.summary.state, 'REVOKED');
  assert.deepEqual(revoked.data.effective_scopes, []);
  assert.deepEqual(await call({ op: 'grant_revoke', request_id: unknown_id }), revoked);
  const expiring = randomUUID();
  await call({ ...grant, request_id: expiring, lifetime_ms: 50 });
  await delay(100);
  assert.equal((await call({ op: 'grant_status', request_id: expiring })).data.summary.state, 'EXPIRED');

  fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
  const server = await Promise.race([lines.next().then(item => JSON.parse(item.value)), delay(10000).then(() => { throw new Error('fixture startup timeout'); })]);
  const profile = { id: randomUUID(), folder_id: null, name: '授权合成SSH', settings: { protocol: 'ssh2', host: '127.0.0.1', port: server.port, username: 'synthetic', auth: 'password', encoding: 'utf8' } };
  await ui.invoke('config_request', { request: { op: 'save_profile', profile, credential: { action: 'replace', value: { password: server.password, private_key: null, passphrase: null } } } });
  await ui.click('SSH2 连接');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length===2`);
  await ui.fill('SSH2 配置', profile.id); await ui.click('建立 SSH2 连接');
  const button = label => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
  await ui.waitFor(`!!(${button('拒绝 SSH2 主机')})`);
  assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`), server.pin);
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
  await ui.click('信任本次 SSH2 主机');
  await ui.waitFor(`!!(${button('使用保存的 SSH2 凭据')})`); await ui.click('使用保存的 SSH2 凭据');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith('CONNECTED')`);
  const sshId = await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`);
  const sshConnection = (await ui.invoke('service_list')).find(c => c.connection_id === sshId);
  const sshRef = { connection_id: sshId, generation: sshConnection.generation };
  const reopenAfterReload = async () => {
    // Page.reload completes before React/service inventory is ready. click() is
    // deliberately optional in the harness, so require the actual controls first.
    await ui.waitFor(`!!(${button('Agent 授权')})&&Array.from(document.querySelector('[aria-label="会话"]')?.options??[]).some(o=>o.value===${JSON.stringify(sshId)})`);
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`), false);
    await ui.fill('会话', sshId); await ui.click('Agent 授权');
    await ui.waitFor(`document.querySelector('[aria-label="Agent批准目标"]')?.textContent.includes(${JSON.stringify(sshId)})&&!!document.querySelector('[aria-label="授权读取终端"]')`);
  };
  await ui.click('Agent 授权');
  await ui.waitFor(`document.querySelector('[aria-label="Agent批准目标"]')?.textContent.includes(${JSON.stringify(sshId)})`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权读取终端"]').checked`), false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权写入终端"]').checked`), false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权协议控制（SSH尺寸/串口控制线）"]').checked`), false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权断开连接"]').checked`), false);
  const toggle = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const prepare = async (write = false) => {
    await toggle('授权读取终端'); if (write) { await toggle('授权写入终端'); await toggle('授权协议控制（SSH尺寸/串口控制线）'); await toggle('授权断开连接'); }
    await ui.fill('Agent授权秒数', '300'); await ui.click('预览Agent授权');
    await ui.waitFor(`!!(${button('确认批准Agent')})`); await toggle('同意本次Agent范围');
  };
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const initialCount = await count();
  await prepare(true); await ui.click('取消Agent批准');
  assert.equal(await count(), initialCount, 'cancel preview does not grant');
  // The cancelled preview retained choices; switching must clear them and consent.
  await ui.fill('会话', ref.connection_id);
  await ui.waitFor(`document.querySelector('[aria-label="Agent批准目标"]').textContent.includes(${JSON.stringify(ref.connection_id)})`);
  await ui.fill('会话', sshId);
  await ui.waitFor(`document.querySelector('[aria-label="授权写入终端"]')&&!document.querySelector('[aria-label="授权写入终端"]').checked`);
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  await prepare(true);
  await ui.evaluate(`{const b=${button('确认批准Agent')};b.click();b.click();}`);
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(), initialCount + 1, 'one explicit approval grants once');
  const storage = () => ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  let saved = await storage(); assert.deepEqual(Object.keys(saved).sort(), ['request_id', 'service_id']);
  let managed = await call({ op: 'grant_status', request_id: saved.request_id });
  assert.ok(managed.data.approved_scopes.every(s => JSON.stringify(s.target.connection) === JSON.stringify(sshRef)));
  assert.deepEqual(managed.data.approved_scopes.map(s => s.action).sort(), ['CONTROL', 'DISCONNECT', 'READ', 'WRITE']);
  assert.equal('token' in managed.data, false);
  assert.equal((await ui.invoke('service_list')).find(c => c.connection_id === sshId).state, 'CONNECTED', 'granting Disconnect does not close the target');
  await ui.click('查询当前输入租约');
  await ui.waitFor(`document.querySelector('[aria-label="Agent租约详情"]')?.textContent.includes('没有有效输入租约')`);
  await ui.click('人工接管当前连接'); await ui.click('取消Agent变更');
  assert.equal((await call({ op: 'grant_status', request_id: saved.request_id })).data.summary.effective_scope_count, 4);
  await ui.click('人工接管当前连接'); await ui.click('确认Agent变更');
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已人工接管')`);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('有效范围 1')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent有效范围"]').textContent.includes('写入终端')`), false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent有效范围"]').textContent.includes('断开连接')`), false);
  assert.ok((await call({ op: 'grant_status', request_id: saved.request_id })).data.summary.state === 'ACTIVE');
  await ui.click('撤销此Agent授权'); await ui.click('取消Agent变更');
  assert.equal((await call({ op: 'grant_status', request_id: saved.request_id })).data.summary.state, 'ACTIVE');
  const revokeLoss = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant_revoke', mode: 'error' });
  try {
    await ui.click('撤销此Agent授权'); await ui.click('确认Agent变更');
    await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);
    assert.equal(await revokeLoss.count(), 1);
    assert.equal(await ui.evaluate(`!!(${button('撤销此Agent授权')})`), false, 'unknown revoke permits query only');
  } finally { await revokeLoss.restore(); }
  await ui.click('查询原Agent编号'); await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('REVOKED')`);
  // Change a choice to invalidate prior selections, then approve exactly READ.
  await ui.fill('会话', ref.connection_id); await ui.fill('会话', sshId);
  await ui.waitFor(`document.querySelector('[aria-label="授权读取终端"]')&&!document.querySelector('[aria-label="授权读取终端"]').checked`);
  await prepare();
  const grantLoss = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'error' });
  const beforeLost = await count();
  try {
    await ui.click('确认批准Agent');
    await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);
    assert.equal(await grantLoss.count(), 1); assert.equal(await count(), beforeLost + 1);
    assert.equal(await ui.evaluate(`(${button('预览Agent授权')}).matches(':disabled')`), true);
  } finally { await grantLoss.restore(); }
  saved = await storage();
  await ui.command('Page.reload');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`), false);
  await reopenAfterReload();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权详情"]')`), false);
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  assert.equal(await count(), beforeLost + 1, 'reload never signs automatically');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`), saved.request_id);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  assert.equal((await call({ op: 'grant_status', request_id: saved.request_id })).data.summary.request_id, saved.request_id);
  // A real successful grant response held after Tauri must not reopen a closed panel.
  await prepare();
  const heldGrant = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'hold' });
  const beforeHeld = await count();
  try {
    await ui.click('确认批准Agent');
    await ui.waitFor(`window.__desktopIpcResponseTest?.releases.length===1`);
    assert.equal(await heldGrant.count(), 1);
    await ui.click('关闭Agent授权'); await heldGrant.release(); await delay(150);
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`), false);
  } finally { await heldGrant.restore(); }
  await ui.click('Agent 授权');
  assert.equal(await count(), beforeHeld + 1);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  const beforePreviewReload = await count();
  await prepare();
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').checked`), true);
  await ui.command('Page.reload'); await reopenAfterReload();
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权读取终端"]').checked`), false);
  assert.equal(await count(), beforePreviewReload, 'reload of an approved preview cannot sign');
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  // Force a real bounded audit overwrite and verify the GUI reports it.
  for (let batch = 0; batch < 6; batch++) await ui.evaluate(`(async()=>{for(let n=0;n<90;n++)await window.__TAURI_INTERNALS__.invoke('agent_management_request',{request:{op:'takeover',connection:${JSON.stringify(sshRef)}}});})()`);
  await ui.evaluate(`document.querySelector('[aria-label="Agent授权面板"] details').open=true`);
  await ui.click('读取保留审计');
  await ui.waitFor(`document.querySelector('[aria-label="Agent审计页"]')?.textContent.includes('审计缺口')`);
  await ui.click('下一页审计');
  await ui.waitFor(`document.querySelector('[aria-label="Agent审计页"]')?.textContent.includes('本页无覆盖缺口')`);
  await ui.evaluate(`document.querySelector('[aria-label="Agent授权详情"]').scrollIntoView({block:'center'})`);
  await ui.screenshot('desktop-agent-management-synthetic.png');
  await ui.evaluate(`document.querySelector('.app-dialog[aria-label="管理 Agent 授权"]').scrollTop=0`);
  await ui.screenshot('desktop-agent-management-top-synthetic.png');
  await ui.click('外观'); await ui.fill('应用主题', 'light');
  await ui.waitFor(`document.documentElement.dataset.theme==='light'`);
  await ui.click('关闭外观');
  await ui.evaluate(`document.querySelector('.app-dialog[aria-label="管理 Agent 授权"]').scrollTop=0`);
  await ui.screenshot('desktop-agent-management-light-synthetic.png');
  await checkReadWindowApproval(ui, sshRef, 'SSH2');
  await checkGrantForms(ui, sshRef, profile, 'SSH2');
  await checkOutputProtection(ui, sshRef, 'SSH2');
  await ui.invoke('ssh_request', { request: { op: 'close', connection: sshRef } });
  assert.equal((await ui.invoke('service_list')).find(c => c.connection_id === sshId).state, 'DISCONNECTED');
  await ui.waitFor(`!!(${button('Agent 授权')})`);
  await ui.waitFor(`!document.querySelector('[aria-label="Agent授权类型"] option[value="reconnect"]').disabled`);
  await ui.fill('Agent授权类型', 'reconnect');
  await ui.click('读取重连固定配置');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="Agent建连配置"]')?.options??[]).some(o=>o.value===${JSON.stringify(profile.id)})`);
  await ui.fill('Agent建连配置', profile.id);
  await ui.click('预览Agent重连双范围');
  await ui.waitFor(`!!(${button('确认批准Agent重连')})`);
  assert.match(await ui.evaluate(`document.querySelector('[aria-label="Agent建连预览"]').textContent`), new RegExp(`${sshId}.*旧代次 ${sshRef.generation}.*配置版本`));
  await ui.evaluate(`document.querySelector('[aria-label="同意Agent重连双范围"]').click()`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意Agent重连双范围"]').checked`), true);
  const beforeReconnectGrant = await count();
  await ui.click('确认批准Agent重连');
  try { await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时双范围授权')`); }
  catch (error) { throw new Error(`${error.message}; visible status=${await ui.evaluate(`document.querySelector('[aria-label="Agent管理状态"]')?.textContent`)}; consent=${await ui.evaluate(`document.querySelector('[aria-label="同意Agent重连双范围"]')?.checked`)}; disabled=${await ui.evaluate(`${button('确认批准Agent重连')}?.disabled`)}`); }
  assert.equal(await count(), beforeReconnectGrant + 1);
  const reconnectSlot = await storage();
  const reconnectGrant = await call({ op: 'grant_status', request_id: reconnectSlot.request_id });
  assert.deepEqual(reconnectGrant.data.approved_scopes, [
    { target: { kind: 'connection', connection: sshRef }, action: 'RECONNECT' },
    { target: { kind: 'profile_revision', profile_id: profile.id, revision: reconnectGrant.data.approved_scopes[1].target.revision }, action: 'CONNECT' },
  ]);
  assert.equal((await ui.invoke('service_list')).find(c => c.connection_id === sshId).state, 'DISCONNECTED', 'grant approval never reconnects');
  await checkForgetApproval(ui, sshRef, 'SSH2');
  await checkGrantForms(ui, sshRef, profile, 'SSH2', true);
  await checkOutputProtection(ui, sshRef, 'SSH2', true);
  await checkAuditHistory(ui, sshRef);
  console.log('PASS Agent GUI: fixed SSH generation/independent READ+WRITE+SSH CONTROL+DISCONNECT, approval does not close, no default consent, cancel/switch/one-shot approval, takeover removes Disconnect, original revoke/lost grant recovery, ID-only reload, late-close and bounded audit gap');
  await checkProfileConnect(ui, profile);
  await ui.close(); ui = await launchDesktop(directory, { fixture: true });
  assert.deepEqual((await call({ op: 'grant_list' })).data, []);
  await assert.rejects(call({ op: 'grant_status', request_id }));
  console.log('PASS native Agent management: strict desktop-only actions, no WebView token, original receipt/reload/lost response, effective scopes, revoke/expiry/restart; synthetic connections only');
} finally {
  await ui?.close();
  fixture?.kill();
  if (fixture) await new Promise(resolve => { if (fixture.exitCode !== null || fixture.signalCode !== null) resolve(); else fixture.once('exit', resolve); });
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('shared-terminal-agent-ui-中文-'));
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
