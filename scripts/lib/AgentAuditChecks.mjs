import assert from 'node:assert/strict';
export async function checkAuditHistory(ui, connection) {
  const native = request => ui.invoke('audit_history_request', { request });
  const info = await native({ op: 'info' });
  assert.equal(info.type, 'info'); assert.equal(info.status.state, 'HEALTHY');
  assert.equal(typeof info.status.synced_through, 'string');
  assert.ok(BigInt(info.status.synced_through) <= BigInt(info.status.accepted_through));
  for (const request of [{ op: 'info', path: 'forbidden' }, { op: 'grant' }, { op: 'page', cursor: 0, through_cursor: '1' }, { op: 'page', cursor: '01', through_cursor: '1' }, { op: 'page', cursor: '0', through_cursor: '18446744073709551616' }]) await assert.rejects(native(request));
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(x=>x.textContent==='持久审计历史与记录状态').click()`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="持久审计状态"]')`), false, 'history never loads without the explicit read');
  await ui.click('读取持久审计状态');
  await ui.waitFor(`document.querySelector('[aria-label="持久审计状态"]')?.textContent.includes('正在记录')`);
  await ui.click('读取首个历史页');
  await ui.waitFor(`!!document.querySelector('[aria-label="持久审计历史页"]')`);
  const pageText=await ui.evaluate(`document.querySelector('[aria-label="持久审计历史页"]').textContent`);
  const through=pageText.match(/固定水位 (\d+)/)[1];
  const page=await native({op:'page',cursor:'0',through_cursor:through});
  assert.ok(page.records.length > 0 && page.records.length <= 64);
  for (const row of page.records) assert.ok(pageText.includes(row.metadata));
  assert.ok(page.records.some(row=>row.category==='RPC'));
  assert.ok(pageText.includes(info.service_id));
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="持久审计历史页"] script')!==null`),false);
  const next=page.next_cursor;
  if (next!==through) {
    await ui.click('下一页历史');
    await ui.waitFor(`!document.querySelector('[aria-label="持久审计历史页"]')?.textContent.includes('下一游标 ${next} ·')`);
    assert.ok((await ui.evaluate(`document.querySelector('[aria-label="持久审计历史页"]').textContent`)).includes(`固定水位 ${through}`));
  }
  const lost=await ui.interceptIpc({command:'audit_history_request',op:'info',mode:'error'});
  try {
    await ui.click('读取持久审计状态');await ui.waitFor(`document.querySelector('[aria-label="Agent 授权"]')?.textContent.includes('审计读取失败') || Array.from(document.querySelectorAll('[role="status"]')).some(p=>p.textContent.includes('审计读取失败'))`);
    assert.equal(await lost.count(),1);assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="持久审计状态"]')`),false);
  } finally {await lost.restore();}
  await ui.click('读取持久审计状态');await ui.waitFor(`!!document.querySelector('[aria-label="持久审计状态"]')`);
  await ui.screenshot('desktop-agent-persistent-audit-synthetic.png');
  const held=await ui.interceptIpc({command:'audit_history_request',op:'info',mode:'hold'});
  try {
    await ui.click('读取持久审计状态');await ui.waitFor(`window.__desktopIpcResponseTest?.releases.length===1`);assert.equal(await held.count(),1);
    await ui.click('关闭Agent授权');await held.release();
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`),false);
  } finally {await held.restore();}
  await ui.click('Agent 授权');assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="持久审计状态"]')`),false);
  await ui.command('Page.reload');
  await ui.waitFor(`[...document.querySelectorAll('[role=\"tab\"]')].some(tab=>tab.dataset.connectionId===${JSON.stringify(connection.connection_id)})`);
  await ui.selectTab(connection.connection_id);await ui.click('Agent 授权');
  await ui.waitFor(`document.querySelector('[aria-label="Agent批准目标"]')?.textContent.includes(${JSON.stringify(connection.connection_id)})`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="持久审计状态"]')`),false);
  // Reload intentionally leaves the old signing receipt unresolved. Recover
  // that ID before handing the harness back to the existing profile checks.
  await ui.click('查询原Agent编号');await ui.waitFor(`!!document.querySelector('[aria-label="Agent授权详情"]')`);
  console.log('PASS persistent audit GUI: explicit status/fixed synced watermark, exact integer strings, bounded metadata-only pages, strict read-only channel, real fetch lost/late-close hits and reload clears snapshot');
}
