import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { delay } from './DesktopHarness.mjs';

// Only called inside the dedicated Chinese-prefixed Agent synthetic roots.
export async function checkOutputProtection(ui, connection, protocol, ended = false) {
  const call = request => ui.invoke('agent_management_request', { request });
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const button = text => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})`;
  const toggle = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const slot = () => ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  const open = async () => {
    if (await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`)) await ui.click('关闭Agent授权');
    await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]')?.options??[]).some(o=>o.value===${JSON.stringify(connection.connection_id)})`);
    await ui.fill('会话', connection.connection_id); await ui.click('Agent 授权');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权形式"]')`);
    await ui.waitFor(`document.querySelector('[aria-label="Agent批准目标"]')?.textContent.includes(${JSON.stringify(connection.connection_id)})`);
    if (await slot()) { await ui.click('查询原Agent编号'); await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权详情"]')`); }
  };
  await open(); const before = await count(), source = await ui.invoke('service_list');
  const rules = ['  合成保护值\n保留空白  ', '<script>synthetic-only</script>'];
  const setup = async (form = 'scoped') => {
    await ui.fill('Agent授权形式', 'scoped');
    // Remount to discard all prior rule values and selected capabilities.
    await open();
    if (form !== 'scoped') await ui.fill('Agent授权形式', form);
    if (form === 'single_operation') {
      await ui.waitFor(`document.querySelector('[aria-label="活动编码"]')?.textContent.includes('UTF-8')`);
      await ui.fill('Agent单次动作', 'exec'); await ui.fill('Agent单次正文', 'synthetic-protected-only');
    } else {
      if (form === 'timed_task') {
        await ui.fill('Agent任务说明', '合成保护时窗'); await toggle('授权读取终端');
        await ui.fill('Agent读取范围', 'window');
        await ui.fill('Agent读取开始时间', '2026-11-07T00:00:00.123');
        await ui.fill('Agent读取结束时间', '2026-11-07T00:01:00.456');
      } else await toggle('授权读取终端');
    }
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="启用Agent输出保护"]').checked`), false);
    await toggle('启用Agent输出保护');
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent敏感字段保护"]').checked`), true);
    assert.equal(await ui.evaluate(`document.querySelectorAll('[aria-label^="Agent精确文本规则"]').length`), 0);
    for (let i = 0; i < rules.length; i++) { await ui.click('添加精确文本规则'); await ui.fill(`Agent精确文本规则${i+1}`, rules[i]); }
    return { preview: form === 'single_operation' ? '预览Agent单次操作' : '预览Agent授权', confirm: form === 'single_operation' ? '确认批准Agent单次' : '确认批准Agent', consent: form === 'single_operation' ? '同意Agent单次操作' : '同意本次Agent范围', cancel: form === 'single_operation' ? '取消Agent单次批准' : '取消Agent批准' };
  };
  const preview = async controls => {
    await ui.click(controls.preview);
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent输出保护预览"]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(controls.consent)}]').checked`), false);
    assert.equal(await ui.evaluate(`${button(controls.confirm)}.disabled`), true);
    assert.deepEqual(await ui.evaluate(`Array.from(document.querySelectorAll('[aria-label="Agent输出保护预览"] pre')).map(p=>p.textContent)`), rules.map(v=>JSON.stringify(v)));
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent输出保护预览"] script')!==null`), false);
    await toggle(controls.consent);
  };
  const receipt = async (fields = true) => {
    const saved = await slot(); assert.deepEqual(Object.keys(saved).sort(), ['request_id','service_id']);
    const response = await call({ op: 'grant_status', request_id: saved.request_id }), p = response.data.protection;
    assert.deepEqual(Object.keys(p).sort(), ['literal_count','policy_id','sensitive_fields']);
    assert.match(p.policy_id, /^[0-9a-f-]{36}$/); assert.equal(p.sensitive_fields, fields); assert.equal(p.literal_count, 2);
    assert.equal('token' in response.data, false);
    for (const forbidden of [...rules, 'signature', 'salt', 'literals']) assert.equal(JSON.stringify(response).includes(forbidden), false);
    assert.equal(await ui.evaluate(`JSON.stringify({...sessionStorage,...localStorage}).includes(${JSON.stringify(rules[1])})`), false);
    assert.deepEqual(await ui.invoke('service_list'), source, 'approval never executes or changes generations');
    assert.equal((await call({ op: 'lease', connection })).data, null);
    return response.data;
  };
  let controls = await setup();
  if (!ended) {
    await ui.click('移除精确规则 2');await ui.click('移除精确规则 1');
    await ui.click(controls.preview);await ui.waitFor(`document.querySelector('[aria-label="Agent输出保护预览"]')?.textContent.includes('精确规则 0 条')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(controls.consent)}]').checked`),false);
    await ui.click(controls.cancel);await toggle('Agent敏感字段保护');
    await ui.click(controls.preview);await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('至少启用敏感字段')`);
    assert.equal(await ui.evaluate(`!!(${button(controls.confirm)})`),false);
    await ui.click('添加精确文本规则');await ui.fill('Agent精确文本规则1','中'.repeat(86));
    await ui.click(controls.preview);await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('最多32条')`);
    assert.equal(await count(),before);
    await toggle('Agent敏感字段保护');await ui.fill('Agent精确文本规则1',rules[0]);
    await ui.click('添加精确文本规则');await ui.fill('Agent精确文本规则2',rules[1]);
  }
  await preview(controls);
  await ui.fill('Agent精确文本规则1', 'changed');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent输出保护预览"]')`), false);
  await ui.fill('Agent精确文本规则1', rules[0]); await preview(controls);
  await ui.click(controls.cancel); assert.equal(await count(), before);
  await preview(controls);
  if (!ended) {
    const other = source.find(c=>c.connection_id!==connection.connection_id);
    assert.ok(other); await ui.fill('会话', other.connection_id);
    await ui.waitFor(`!document.querySelector('[aria-label="Agent输出保护预览"]')`);
    assert.equal(await count(), before); controls = await setup(); await preview(controls);
  }
  await ui.evaluate(`document.querySelector('[aria-label="Agent输出保护预览"]').scrollIntoView({block:'center'})`);
  await ui.screenshot(`desktop-agent-${protocol.toLowerCase()}-${ended?'ended':'connected'}-protection-preview-synthetic.png`);
  await ui.evaluate(`{const b=${button(controls.confirm)};b.click();b.click();}`);
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(), before+1); const first = await receipt();
  assert.deepEqual(first.approved_scopes, [{target:{kind:'connection',connection},action:'READ'}]);
  await ui.click('关闭Agent授权'); await open();
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Agent输出保护详情"]').textContent.includes(${JSON.stringify(first.protection.policy_id)})`), true);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent精确文本规则1"]')||!!document.querySelector('[aria-label="Agent输出保护预览"]')`), false);
  if (ended) { console.log(`PASS ${protocol} ended protected Read: fixed rules/metadata only, no implicit Forget or source mutation`); return (await count())-before; }

  controls = await setup('timed_task'); await toggle('Agent敏感字段保护'); await preview(controls); let n=await count();
  await ui.click(controls.confirm); await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(),n+1); const task=await receipt(false); assert.equal(task.form.kind,'timed_task');
  assert.deepEqual(task.approved_scopes.map(s=>s.target.kind),['output_window']); assert.notEqual(task.protection.policy_id,first.protection.policy_id);
  if (protocol === 'SSH2') {
    controls = await setup('single_operation'); await preview(controls);
    const operationId = await ui.evaluate(`Array.from(document.querySelector('[aria-label="Agent单次预览"]').querySelectorAll(':scope > div')).find(row=>row.querySelector('strong').textContent==='原操作编号：').querySelector('p').textContent`);
    n=await count(); await ui.click(controls.confirm);
    await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已批准一次固定操作')`);
    assert.equal(await count(),n+1); const single=await receipt();
    assert.deepEqual(single.approved_scopes,[{target:{kind:'connection',connection},action:'EXEC'}]);
    const operation={protocol:'SSH2',request:{op:'exec',connection,request_id:operationId,command:'synthetic-protected-only',timeout_ms:30000,max_output_bytes:65536}};
    assert.equal(single.form.operation.fingerprint,createHash('sha256').update(JSON.stringify(operation)).digest('hex'));
  }
  // Preview reload cannot issue. Lost/late replies fault real fetch, not invoke.
  controls=await setup();await preview(controls);n=await count();await ui.command('Page.reload');await open();assert.equal(await count(),n);
  controls=await setup();await preview(controls);
  const lost=await ui.interceptIpc({command:'agent_management_request',op:'grant_protected',mode:'error'});
  try { await ui.click(controls.confirm);await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('操作未确认')`);assert.equal(await lost.count(),1); } finally { await lost.restore(); }
  assert.equal(await count(),n+1);const uncertain=await receipt(), saved=await slot();
  await ui.command('Page.reload');await open();assert.deepEqual((await call({op:'grant_status',request_id:saved.request_id})).data,uncertain);assert.equal(await count(),n+1);
  controls=await setup();await preview(controls);
  const held=await ui.interceptIpc({command:'agent_management_request',op:'grant_protected',mode:'hold'});
  try { await ui.click(controls.confirm);await ui.waitFor(`window.__desktopIpcResponseTest?.releases.length===1`);assert.equal(await held.count(),1);await ui.click('关闭Agent授权');await held.release();await delay(150);assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`),false); } finally { await held.restore(); }
  assert.equal(await count(),n+2);await open();await receipt();
  console.log(`PASS ${protocol} protected GUI: exact immutable rules, full/window/task${protocol==='SSH2'?'/single exec':''}, edit/cancel/switch/reload/one-shot, ID-only policy metadata, real lost/late response; no token/lease/execution`);
  return (await count())-before;
}
