import assert from 'node:assert/strict';
import { delay } from './DesktopHarness.mjs';

// Dedicated Agent Chinese temporary root only. Grants do not execute Forget.
export async function checkForgetApproval(ui, connection, protocol) {
  const call = request => ui.invoke('agent_management_request', { request });
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const button = text => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})`;
  const toggle = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const label = '授权移除已回收连接记录';
  const fixed = [{ target: { kind: 'connection', connection }, action: 'FORGET' }];
  const saved = () => ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  const assertPresent = async () => {
    const current = (await ui.invoke('service_list')).find(c => c.connection_id === connection.connection_id);
    assert.equal(current?.generation, connection.generation, 'grant never removes or replaces the connection');
    assert.ok(['DISCONNECTED', 'FAILED'].includes(current.state));
    assert.equal((await call({ op: 'lease', connection })).data, null, 'approval does not acquire lease');
  };
  const open = async () => {
    if (await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`)) await ui.click('关闭Agent授权');
    await ui.fill('会话', connection.connection_id);
    await ui.click('Agent 授权');
    await ui.waitFor(`!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').checked`), false);
    const previous = await saved();
    if (previous) {
      const original = await call({ op: 'grant_status', request_id: previous.request_id });
      await ui.click('查询原Agent编号');
      await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes(${JSON.stringify(original.data.summary.ticket_id)})`);
    }
  };
  const preview = async () => {
    await ui.click('预览Agent授权');
    await ui.waitFor(`!!(${button('确认批准Agent')})`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').checked`), false);
    assert.equal(await ui.evaluate(`${button('确认批准Agent')}.disabled`), true);
    assert.match(await ui.evaluate(`document.querySelector('[aria-label="Agent授权预览"]').textContent`), new RegExp(`${protocol}.*${connection.connection_id}.*代次 ${connection.generation}`));
    await toggle('同意本次Agent范围');
  };
  await open();
  const before = await count();
  assert.equal(await ui.evaluate(`document.querySelectorAll('[aria-label="Agent授权面板"] input[type="checkbox"]').length`), 1);
  await toggle(label);
  assert.match(await ui.evaluate(`document.querySelector('[aria-label="Agent移除范围说明"]').textContent`), /不删除日志、配置或用户文件/);
  await preview(); await ui.click('取消Agent批准'); assert.equal(await count(), before);
  await preview();
  const other = await ui.invoke('fixture_create');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(other.connection_id)})`);
  await ui.fill('会话', other.connection_id);
  await ui.waitFor(`!(${button('确认批准Agent')})`);
  await open(); await toggle(label); await preview();
  await ui.command('Page.reload');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]')?.options??[]).some(o=>o.value===${JSON.stringify(connection.connection_id)})`);
  await open();
  assert.equal(await count(), before, 'preview consent does not survive reload');
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  await toggle(label); await preview();
  await ui.evaluate(`document.querySelector('[aria-label="Agent授权预览"]').scrollIntoView({block:'center'})`);
  await ui.screenshot(`desktop-agent-${protocol.toLowerCase()}-forget-preview-synthetic.png`);
  await ui.evaluate(`{const b=${button('确认批准Agent')};b.click();b.click();}`);
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(), before + 1);
  let slot = await saved();
  const original = await call({ op: 'grant_status', request_id: slot.request_id });
  assert.deepEqual(original.data.approved_scopes, fixed);
  assert.deepEqual(original.data.effective_scopes, fixed);
  assert.equal('token' in original.data, false);
  await assertPresent();
  // Real IPC fetch response loss: recover only the retained original grant ID.
  const loss = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'error' });
  try {
    await preview(); await ui.click('确认批准Agent');
    await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);
    assert.equal(await loss.count(), 1);
  } finally { await loss.restore(); }
  assert.equal(await count(), before + 2);
  slot = await saved();
  const lost = await call({ op: 'grant_status', request_id: slot.request_id });
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes(${JSON.stringify(lost.data.summary.ticket_id)})`);
  assert.deepEqual((await call({ op: 'grant_status', request_id: slot.request_id })).data, lost.data);
  await ui.command('Page.reload');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]')?.options??[]).some(o=>o.value===${JSON.stringify(connection.connection_id)})`);
  await open(); await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes(${JSON.stringify(lost.data.summary.ticket_id)})`);
  assert.equal(await count(), before + 2);
  assert.deepEqual((await saved()), slot);
  await toggle(label); await preview();
  const held = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'hold' });
  try {
    await ui.click('确认批准Agent');
    await ui.waitFor(`window.__desktopIpcResponseTest?.releases.length===1`);
    assert.equal(await held.count(), 1);
    await ui.click('关闭Agent授权'); await held.release(); await delay(150);
  } finally { await held.restore(); }
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`), false);
  assert.equal(await count(), before + 3);
  await assertPresent(); await open();
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('移除已回收连接记录')`);
  console.log(`PASS ${protocol} Forget GUI: default-none fixed generation, cancel/switch/reload/one-shot, real lost/late IPC, ID-only recovery, approval neither removes nor acquires lease; no bridge token`);
  return 3;
}
