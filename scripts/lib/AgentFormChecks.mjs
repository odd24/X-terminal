import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { delay } from './DesktopHarness.mjs';

// Only the dedicated Agent Chinese roots / synthetic SSH or memory-port fixtures.
// Approval is exercised through buttons; no Agent bearer ever enters the WebView.
export async function checkGrantForms(ui, connection, profile, protocol, ended = false) {
  const call = request => ui.invoke('agent_management_request', { request });
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const button = text => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})`;
  const click = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const value = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').value`);
  const slot = () => ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  const open = async () => {
    if (await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`)) await ui.click('关闭Agent授权');
    await ui.waitFor(`[...document.querySelectorAll('[role=\"tab\"]')].some(tab=>tab.dataset.connectionId===${JSON.stringify(connection.connection_id)})`);
    await ui.selectTab(connection.connection_id); await ui.click('Agent 授权');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权形式"]')`);
    await ui.waitFor(`document.querySelector('[aria-label="活动编码"]')?.textContent.includes('UTF-8')`);
    assert.equal(await value('Agent授权形式'), 'scoped');
    if (await slot()) { await ui.click('查询原Agent编号'); await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权详情"]')`); }
  };
  await open(); const before = await count();
  const listBefore = await ui.invoke('service_list');
  const original = listBefore.find(c => c.connection_id === connection.connection_id);
  assert.equal(original.state, ended ? 'DISCONNECTED' : 'CONNECTED');
  const configure = async action => {
    if (await value('Agent授权形式') !== 'single_operation') await ui.fill('Agent授权形式', 'single_operation');
    assert.equal(await value('Agent单次动作'), '', 'no operation is preselected');
    await ui.fill('Agent单次动作', action);
    if (['start', 'reconnect'].includes(action)) {
      await ui.click('读取单次固定配置');
      await ui.waitFor(`Array.from(document.querySelector('[aria-label="Agent单次配置"]').options).some(o=>o.value===${JSON.stringify(profile.id)})`);
      assert.equal(await value('Agent单次配置'), ''); await ui.fill('Agent单次配置', profile.id);
      if (action === 'start' && protocol === 'SERIAL') {
        await ui.click('读取单次串口库存');
        await ui.waitFor(`document.querySelector('[aria-label="Agent单次设备"]').options.length>1`);
        assert.equal(await value('Agent单次设备'), '');
        const device = await ui.evaluate(`Array.from(document.querySelector('[aria-label="Agent单次设备"]').options).find(o=>o.value&&!o.disabled).value`);
        await ui.fill('Agent单次设备', device);
      }
    }
    if (['write_text', 'send', 'exec'].includes(action)) await ui.fill('Agent单次正文', action === 'exec' ? 'synthetic-only-command' : '中  文\n<tag>');
    if (action === 'write') await ui.fill('Agent单次HEX', '00 ff 0d 0a');
    if (['resize', 'reconnect'].includes(action) || (action === 'start' && protocol === 'SSH2')) { await ui.fill('Agent单次列数', 93); await ui.fill('Agent单次行数', 31); }
    if (action === 'exec') { await ui.fill('Agent单次exec超时', 777); await ui.fill('Agent单次exec上限', 1234); }
    if (action === 'send') { await ui.fill('Agent单次结尾', 'cr_lf'); await ui.fill('Agent单次片长', 2); await ui.fill('Agent单次间隔', 7); }
    if (action === 'control') { await ui.fill('Agent单次控制线', 'BREAK'); await ui.fill('Agent单次电平', 'true'); }
  };
  const preview = async () => {
    await ui.click('预览Agent单次操作');
    try { await ui.waitFor(`!!document.querySelector('[aria-label="Agent单次预览"]')`); }
    catch(error) { throw new Error(`${error.message}; ${await ui.evaluate(`document.querySelector('[aria-label="Agent单次状态"]')?.textContent`)}`); }
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意Agent单次操作"]').checked`), false);
    assert.equal(await ui.evaluate(`${button('确认批准Agent单次')}.disabled`), true);
    const fields = await ui.evaluate(`Object.fromEntries(Array.from(document.querySelector('[aria-label="Agent单次预览"]').querySelectorAll(':scope > div')).map(row=>[row.querySelector('strong').textContent.slice(0,-1),(row.querySelector('pre')??row.querySelector('p')).textContent]))`);
    assert.match(fields['原操作编号'], /^[0-9a-f-]{36}$/); await click('同意Agent单次操作'); return fields;
  };
  const actions = ended ? protocol === 'SSH2' ? ['reconnect', 'forget_start'] : ['forget_start'] : protocol === 'SSH2' ? ['write_text', 'write', 'exec', 'resize', 'disconnect', 'start'] : ['send', 'write', 'control', 'disconnect', 'start'];
  for (const action of actions) {
    // Re-entering the form clears prior operation/body/consent even after success.
    await ui.fill('Agent授权形式', 'scoped'); await ui.fill('Agent授权形式', 'single_operation');
    await configure(action);
    await preview(); await ui.fill('Agent单次秒数', 301);
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent单次预览"]')`), false);
    await ui.fill('Agent单次秒数', 300); let fields = await preview();
    if (action === actions[0]) {
      const n = await count(); await ui.click('取消Agent单次批准'); assert.equal(await count(), n);
      fields = await preview();
      await ui.evaluate(`document.querySelector('[aria-label="Agent单次预览"]').scrollIntoView({block:'center'})`);
      await ui.screenshot(`desktop-agent-${protocol.toLowerCase()}-${ended?'ended':'connected'}-single-preview-synthetic.png`);
      await ui.evaluate(`${button('确认批准Agent单次')}.scrollIntoView({block:'center'})`);
      await ui.screenshot(`desktop-agent-${protocol.toLowerCase()}-${ended?'ended':'connected'}-single-confirm-synthetic.png`);
    }
    const request_id = fields['原操作编号'];
    let request;
    if (action === 'start') request = protocol === 'SSH2' ? { op: action, profile_id: profile.id, request_id, cols: 93, rows: 31 } : { op: action, profile_id: profile.id, request_id, revision: fields['库存版本'], device_id: await value('Agent单次设备') };
    else if (['reconnect','resize'].includes(action)) request = { op: action, connection, request_id, cols: 93, rows: 31 };
    else if (action === 'write') request = { op: action, connection, request_id, bytes: [0,255,13,10] };
    else if (action === 'write_text') request = { op: action, connection, request_id, text: await value('Agent单次正文') };
    else if (action === 'exec') request = { op: action, connection, request_id, command: 'synthetic-only-command', timeout_ms: 777, max_output_bytes: 1234 };
    else if (action === 'send') request = { op: action, connection, request_id, content: await value('Agent单次正文'), format: 'text', ending: 'cr_lf', pace: { chunk_bytes: 2, interval_ms: 7 } };
    else if (action === 'control') request = { op: action, connection, request_id, line: 'BREAK', asserted: true };
    else request = { op: action, connection, request_id };
    const n = await count(); await ui.evaluate(`{const b=${button('确认批准Agent单次')};b.click();b.click();}`);
    try { await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已批准一次固定操作')`); }
    catch(error) { throw new Error(`${protocol}/${action}: ${error.message}; ${await ui.evaluate(`document.querySelector('[aria-label="Agent管理状态"]').textContent`)}`); }
    assert.equal(await count(), n + 1, 'double confirmation issues once');
    const saved = await slot(), receipt = (await call({ op: 'grant_status', request_id: saved.request_id })).data;
    assert.deepEqual(Object.keys(saved).sort(), ['request_id','service_id']);
    assert.deepEqual(receipt.form, { kind: 'single_operation', operation: { request_id, fingerprint: createHash('sha256').update(JSON.stringify({ protocol, request })).digest('hex') } });
    assert.equal(receipt.approved_scopes.some(s=>s.action==='READ'), false);
    assert.equal(receipt.approved_scopes.length, action === 'reconnect' ? 2 : 1);
    if (['start','reconnect'].includes(action)) assert.equal(receipt.approved_scopes.at(-1).target.revision, fields['配置版本']);
    else assert.deepEqual(receipt.approved_scopes[0].target, { kind: 'connection', connection });
    assert.equal('token' in receipt, false); assert.equal((await call({ op: 'lease', connection })).data, null);
    assert.deepEqual(await ui.invoke('service_list'), listBefore, 'approval never executes the typed mutation');
  }
  const taskModes = ended ? protocol === 'SSH2' ? ['reconnect'] : ['connection'] : ['connection','profile'];
  for (const mode of taskModes) {
    await ui.fill('Agent授权形式', 'timed_task');
    assert.equal(await value('Agent任务说明'), ''); await ui.fill('Agent任务说明', `合成${protocol}有限任务`);
    await ui.fill('Agent授权类型', mode);
    let confirm, previewTask, consent;
    if (mode === 'connection') {
      const action = ended ? '移除已回收连接记录' : '写入终端';
      await click(`授权${action}`); await ui.click('预览Agent授权');
      confirm='确认批准Agent';previewTask='预览Agent授权';consent='同意本次Agent范围';
    } else {
      await ui.click(mode==='reconnect'?'读取重连固定配置':'读取Agent建连配置');
      await ui.waitFor(`Array.from(document.querySelector('[aria-label="Agent建连配置"]').options).some(o=>o.value===${JSON.stringify(profile.id)})`);
      await ui.fill('Agent建连配置',profile.id); await ui.click(mode==='reconnect'?'预览Agent重连双范围':'预览Agent建连授权');
      confirm=mode==='reconnect'?'确认批准Agent重连':'确认批准Agent建连';previewTask=mode==='reconnect'?'预览Agent重连双范围':'预览Agent建连授权';consent=mode==='reconnect'?'同意Agent重连双范围':'同意Agent固定配置建连';
    }
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent任务预览"]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(consent)}]').checked`),false);
    await click(consent);await ui.fill('Agent任务说明','编辑使同意失效');
    await ui.waitFor(`!document.querySelector('[aria-label="Agent任务预览"]')`);
    await ui.fill('Agent任务说明',`合成${protocol}有限任务`);await ui.click(previewTask);
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent任务预览"]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(consent)}]').checked`),false);
    await click(consent); const n=await count(),prior=(await slot())?.request_id; await ui.click(confirm);
    await ui.waitFor(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))?.request_id!==${JSON.stringify(prior)}&&document.querySelector('[aria-label="Agent管理状态"]')?.textContent.includes('已签发限时')&&document.querySelector('[aria-label="Agent授权形式详情"]')?.textContent.includes('有限任务')`);
    assert.equal(await count(),n+1);
    const saved=await slot(),receipt=(await call({op:'grant_status',request_id:saved.request_id})).data;
    assert.equal(receipt.form.kind,'timed_task');assert.equal(receipt.form.label,`合成${protocol}有限任务`);
    assert.equal(receipt.approved_scopes.some(s=>s.action==='READ'),false);assert.equal('token' in receipt,false);
    assert.deepEqual(await ui.invoke('service_list'),listBefore);
    await ui.fill('Agent授权形式','scoped');
  }
  if (!ended) {
    // Real response loss/late close for each new signing command. Reconstructing
    // only the receipt ID after reload must not restore body, task or consent.
    for (const kind of ['single_operation','timed_task']) {
      const setup = async () => {
        await ui.fill('Agent授权形式','scoped');await ui.fill('Agent授权形式',kind);
        if(kind==='single_operation'){await configure(protocol==='SSH2'?'write_text':'send');await preview();return '确认批准Agent单次';}
        await ui.fill('Agent任务说明','故障合成任务');await click('授权写入终端');await ui.click('预览Agent授权');await click('同意本次Agent范围');return '确认批准Agent';
      };
      let confirm=await setup(),n=await count();
      await ui.command('Page.reload');await open();assert.equal(await count(),n);
      confirm=await setup();
      const op=kind==='single_operation'?'grant_operation':'grant_task';
      const lost=await ui.interceptIpc({command:'agent_management_request',op,mode:'error'});
      try{await ui.click(confirm);await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);assert.equal(await lost.count(),1);}finally{await lost.restore();}
      assert.equal(await count(),n+1);const saved=await slot(),first=(await call({op:'grant_status',request_id:saved.request_id})).data;
      await ui.command('Page.reload');await open();
      assert.equal(await value('Agent授权形式'),'scoped');assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent单次正文"]')||!!document.querySelector('[aria-label="Agent任务说明"]')`),false);
      assert.deepEqual((await call({op:'grant_status',request_id:saved.request_id})).data,first);
      confirm=await setup();const held=await ui.interceptIpc({command:'agent_management_request',op,mode:'hold'});
      try{await ui.click(confirm);await ui.waitFor(`window.__desktopIpcResponseTest?.releases.length===1`);assert.equal(await held.count(),1);await ui.click('关闭Agent授权');await held.release();await delay(150);assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`),false);}finally{await held.restore();}
      assert.equal(await count(),n+2);await open();
    }
  }
  await ui.fill('Agent授权形式','scoped');
  console.log(`PASS ${protocol} ${ended?'ended':'connected'} forms GUI: complete typed previews, independently hashed receipts, task scopes, no implicit Read/token/lease/execution, one-shot consent and real reply recovery`);
  return (await count()) - before;
}
