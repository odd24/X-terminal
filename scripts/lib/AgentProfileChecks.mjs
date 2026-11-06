import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { delay } from './DesktopHarness.mjs';

// Called only inside the dedicated Agent Chinese temporary root / synthetic fixtures.
export async function checkProfileConnect(ui, source) {
  const profile = structuredClone(source);
  const call = request => ui.invoke('agent_management_request', { request });
  const save = value => ui.invoke('config_request', { request: { op: 'save_profile', profile: value, credential: { action: 'keep' } } });
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const button = text => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})`;
  const toggle = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const read = async () => {
    await ui.click('读取Agent建连配置');
    await ui.waitFor(`Array.from(document.querySelector('[aria-label="Agent建连配置"]').options).some(o=>o.value===${JSON.stringify(profile.id)})`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent建连配置"]').value`), '');
    await ui.fill('Agent建连配置', profile.id);
  };
  const preview = async () => {
    await ui.click('预览Agent建连授权');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent建连预览"]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意Agent固定配置建连"]').checked`), false);
    await toggle('同意Agent固定配置建连');
  };
  const reopen = async () => {
    await ui.waitFor(`!!(${button('Agent 授权')})`);
    await ui.click('Agent 授权');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权类型"]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent授权类型"]').value`), 'connection');
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent建连预览"]')`), false);
    await ui.click('查询原Agent编号');
    await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
    await ui.fill('Agent授权类型', 'profile');
    await read();
  };
  await ui.fill('Agent授权类型', 'profile'); await read();
  const startCount = await count();
  await preview();
  const text = await ui.evaluate(`document.querySelector('[aria-label="Agent建连预览"]').textContent`);
  assert.ok(text.includes(profile.id)); assert.ok(text.includes('配置版本')); assert.ok(text.includes('300 秒'));
  if (profile.settings.protocol === 'serial') {
    assert.ok(text.includes('初始DTR 关闭')); assert.ok(text.includes('初始RTS 关闭'));
    assert.ok(text.includes('COM7')); assert.ok(text.includes('115200'));
  } else { assert.ok(text.includes(`${profile.settings.host}:${profile.settings.port}`)); }
  await ui.click('取消Agent建连批准'); assert.equal(await count(), startCount);
  await preview(); await ui.fill('Agent建连配置', '');
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent建连')})`), false);
  await ui.fill('Agent建连配置', profile.id); await preview();
  // A saved edit outside this panel must be caught by the fresh read before signing.
  profile.name += '已修改';
  if (profile.settings.protocol === 'serial') profile.settings.dtr_on_open = true;
  await save(profile); await ui.click('确认批准Agent建连');
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('配置版本已变化')`);
  assert.equal(await count(), startCount);
  await read(); await preview();
  if (profile.settings.protocol === 'serial') assert.ok((await ui.evaluate(`document.querySelector('[aria-label="Agent建连预览"]').textContent`)).includes('初始DTR 开启'));
  await ui.invoke('config_request', { request: { op: 'delete_profile', id: profile.id } });
  await ui.click('确认批准Agent建连');
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('配置版本已变化')`);
  assert.equal(await count(), startCount);
  const savedProfile = await save(profile); await read(); await preview();
  const sessionsBefore = await ui.invoke('service_list');
  await ui.evaluate(`document.querySelector('[aria-label="Agent建连预览"]').scrollIntoView({block:'center'})`);
  await ui.screenshot(`desktop-agent-profile-${profile.settings.protocol}-preview-synthetic.png`);
  await ui.evaluate(`{const b=${button('确认批准Agent建连')}; b.click(); b.click();}`);
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(), startCount + 1);
  assert.deepEqual(await ui.invoke('service_list'), sessionsBefore, 'approval must not start a connection');
  const slot = await ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  assert.deepEqual(Object.keys(slot).sort(), ['request_id', 'service_id']);
  const receipt = await call({ op: 'grant_status', request_id: slot.request_id });
  assert.deepEqual(receipt.data.approved_scopes, [{ target: { kind: 'profile_revision', profile_id: profile.id, revision: savedProfile.revision }, action: 'CONNECT' }]);
  assert.deepEqual(receipt.data.effective_scopes, receipt.data.approved_scopes); assert.equal('token' in receipt.data, false);
  // Preview reload never grants; only the previous two-ID slot is recoverable.
  await preview(); await ui.command('Page.reload'); await reopen();
  assert.equal(await count(), startCount + 1);
  await preview();
  const lost = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'error' });
  try {
    await ui.click('确认批准Agent建连');
    await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);
    assert.equal(await lost.count(), 1);
  } finally { await lost.restore(); }
  assert.equal(await count(), startCount + 2);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent配置建连面板"]').disabled`), true);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  assert.equal(await count(), startCount + 2);
  await preview();
  const held = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'hold' });
  try {
    await ui.click('确认批准Agent建连');
    await ui.waitFor(`window.__desktopIpcResponseTest?.releases.length===1`);
    assert.equal(await held.count(), 1);
    await ui.click('关闭Agent授权'); await held.release(); await delay(150);
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`), false);
  } finally { await held.restore(); }
  assert.equal(await count(), startCount + 3);
  console.log(`PASS ${profile.settings.protocol} Profile Connect GUI: fixed saved revision/parameters, default-none, cancel/switch/edit/delete/reload, one-shot Connect-only without opening, real lost/held response and ID-only recovery; no Agent stdio token handoff`);
}
