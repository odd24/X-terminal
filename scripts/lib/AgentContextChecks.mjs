import assert from 'node:assert/strict';

export async function checkReadWindowApproval(ui, connection, protocol) {
  const call = request => ui.invoke('agent_management_request', { request });
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const button = text => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})`;
  const click = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const slot = () => ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  if (await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`)) await ui.click('关闭Agent授权');
  await ui.fill('会话', connection.connection_id); await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="授权读取终端"]')`);
  const previous = await slot();
  if (previous) {
    await ui.click('查询原Agent编号');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权详情"]')`);
  }
  const before = await count();
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权读取终端"]').checked`), false);
  await click('授权读取终端');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent读取范围"]').value`), 'full');
  await ui.fill('Agent读取范围', 'window');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent读取开始时间"]').value`), '');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent读取结束时间"]').value`), '');
  await ui.click('预览Agent授权');
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('请填写有效北京时间')`);
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  const from = '2026-11-07T00:00:00.123', until = '2026-11-07T00:01:00.456';
  const fill = async () => { await ui.fill('Agent读取开始时间', from); await ui.fill('Agent读取结束时间', until); };
  const preview = async () => {
    await ui.click('预览Agent授权'); await ui.waitFor(`!!(${button('确认批准Agent')})`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').checked`), false);
    assert.match(await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').closest('fieldset').textContent`), /北京时间.*时间窗重建/);
    await click('同意本次Agent范围');
  };
  await fill(); await preview();
  await ui.fill('Agent读取结束时间', '2026-11-07T00:02:00.456');
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false, 'editing time invalidates consent');
  await fill(); await preview(); await ui.click('取消Agent批准');
  assert.equal(await count(), before);
  await preview();
  const other = await ui.invoke('fixture_create');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(other.connection_id)})`);
  await ui.fill('会话', other.connection_id); await ui.fill('会话', connection.connection_id);
  await ui.waitFor(`document.querySelector('[aria-label="授权读取终端"]')&&!document.querySelector('[aria-label="授权读取终端"]').checked`);
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  await click('授权读取终端'); await ui.fill('Agent读取范围', 'window');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent读取开始时间"]').value`), '');
  await fill(); await preview();
  await ui.evaluate(`document.querySelector('[aria-label="Agent授权预览"]').scrollIntoView({block:'center'})`);
  await ui.screenshot(`desktop-agent-${protocol.toLowerCase()}-time-window-preview-synthetic.png`);
  await ui.evaluate(`{const b=${button('确认批准Agent')};b.click();b.click();}`);
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(), before + 1);
  const fixed = [{ target: { kind: 'output_window', connection, window: { from_ms: Date.parse(`${from}+08:00`), until_ms: Date.parse(`${until}+08:00`) } }, action: 'READ' }];
  let saved = await slot();
  const original = await call({ op: 'grant_status', request_id: saved.request_id });
  assert.deepEqual(original.data.approved_scopes, fixed); assert.deepEqual(original.data.effective_scopes, fixed);
  assert.equal('token' in original.data, false);
  assert.equal((await call({ op: 'lease', connection })).data, null);
  const lost = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'error' });
  try {
    await preview(); await ui.click('确认批准Agent');
    await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);
    assert.equal(await lost.count(), 1);
  } finally { await lost.restore(); }
  assert.equal(await count(), before + 2);
  saved = await slot();
  const uncertain = await call({ op: 'grant_status', request_id: saved.request_id });
  await ui.command('Page.reload');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]')?.options??[]).some(o=>o.value===${JSON.stringify(connection.connection_id)})`);
  await ui.fill('会话', connection.connection_id); await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="Agent签发编号"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="授权读取终端"]').checked`), false);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent读取开始时间"]')`), false);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes(${JSON.stringify(uncertain.data.summary.ticket_id)})`);
  assert.deepEqual((await call({ op: 'grant_status', request_id: saved.request_id })).data, uncertain.data);
  assert.deepEqual(uncertain.data.approved_scopes, fixed); assert.equal(await count(), before + 2);
  assert.equal((await ui.invoke('service_list')).find(c=>c.connection_id===connection.connection_id).generation, connection.generation);
  console.log(`PASS ${protocol} time-window GUI: explicit Beijing half-open limits, no default times/consent, edit/cancel/switch invalidate, one-shot, actual lost IPC hit once, reload IDs only with exact original expiry; no token bridge`);
  return 2;
}
