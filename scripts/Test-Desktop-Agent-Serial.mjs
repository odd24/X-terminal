import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

// This dedicated Agent GUI fixture never opens COM. Restore production even on failure.
const build = fixture => {
  const result = spawnSync('cargo', ['build', '-p', 'session-service', '--locked', ...(fixture ? ['--features', 'serial-ui-fixture'] : [])], { windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'serial Agent fixture/ordinary service build must succeed');
};
let ui, directory;
try {
  build(true);
  directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-agent-ui-中文-serial-'));
  ui = await launchDesktop(directory, { fixture: true });
  const call = request => ui.invoke('agent_management_request', { request });
  const profile = { id: randomUUID(), folder_id: null, name: '授权合成串口', settings: { protocol: 'serial', port: 'COM7', baud_rate: 115200, data_bits: 8, stop_bits: 1, parity: 'none', flow: 'none', dtr_on_open: false, rts_on_open: false, encoding: 'utf8' } };
  await ui.invoke('config_request', { request: { op: 'save_profile', profile, credential: { action: 'keep' } } });
  await ui.click('串口连接'); await ui.click('刷新串口配置与设备');
  await ui.waitFor(`document.querySelector('[aria-label="串口配置"]').options.length===2&&document.querySelector('[aria-label="串口设备"]').options.length===2`);
  await ui.fill('串口配置', profile.id);
  await ui.fill('串口设备', await ui.evaluate(`document.querySelector('[aria-label="串口设备"]').options[1].value`));
  await ui.evaluate(`document.querySelector('[aria-label="确认串口设备与控制线"]').click()`);
  await ui.click('打开串口');
  await ui.waitFor(`document.querySelector('[aria-label="串口状态"]')?.textContent.startsWith('CONNECTED')`);
  const target = (await ui.invoke('service_list')).find(c => c.protocol === 'SERIAL');
  const connection = { connection_id: target.connection_id, generation: target.generation };
  const other = await ui.invoke('fixture_create');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(other.connection_id)})`);
  await ui.fill('会话', target.connection_id);
  await ui.click('Agent 授权');
  await ui.waitFor(`document.querySelector('[aria-label="Agent批准目标"]')?.textContent.includes(${JSON.stringify(target.connection_id)})`);
  const toggle = label => ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const button = label => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
  for (const label of ['授权读取终端', '授权写入终端', '授权协议控制（SSH尺寸/串口控制线）', '授权断开连接']) {
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').checked`), false);
  }
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="授权建立配置连接"]')`), false);
  const count = async () => (await call({ op: 'grant_list' })).data.length;
  const before = await count();
  await toggle('授权断开连接');
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="Agent断开范围说明"]').textContent`)).includes('请求关闭不等于本地传输已回收'));
  const preview = async () => {
    await ui.click('预览Agent授权');
    await ui.waitFor(`!!(${button('确认批准Agent')})`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').checked`), false);
    await toggle('同意本次Agent范围');
  };
  await preview(); await ui.click('取消Agent批准');
  assert.equal(await count(), before);
  await preview();
  await ui.fill('会话', other.connection_id);
  await ui.waitFor(`!document.querySelector('[aria-label="授权断开连接"]')`);
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  await ui.fill('会话', target.connection_id);
  await ui.waitFor(`document.querySelector('[aria-label="授权断开连接"]')&&!document.querySelector('[aria-label="授权断开连接"]').checked`);
  await toggle('授权断开连接'); await preview();
  await ui.evaluate(`document.querySelector('[aria-label="Agent授权预览"]').scrollIntoView({block:'center'})`);
  await ui.screenshot('desktop-agent-serial-disconnect-preview-synthetic.png');
  await ui.evaluate(`{ const b=${button('确认批准Agent')}; b.click(); b.click(); }`);
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]').textContent.includes('已签发限时授权')`);
  assert.equal(await count(), before + 1);
  const saved = await ui.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  assert.deepEqual(Object.keys(saved).sort(), ['request_id', 'service_id']);
  const original = await call({ op: 'grant_status', request_id: saved.request_id });
  const scopes = [{ target: { kind: 'connection', connection }, action: 'DISCONNECT' }];
  assert.deepEqual(original.data.approved_scopes, scopes);
  assert.deepEqual(original.data.effective_scopes, scopes);
  assert.equal('token' in original.data, false);
  assert.equal((await ui.invoke('serial_request', { request: { op: 'status', connection } })).connection.state, 'CONNECTED');
  assert.equal((await call({ op: 'lease', connection })).data, null, 'grant does not acquire a lease');
  // Closing is a separate Desktop test operation. Its original receipt must settle
  // after actual worker join and remain recoverable after Forget; no Agent token enters JS.
  const id = randomUUID();
  const first = await ui.invoke('serial_request', { request: { op: 'disconnect', connection, request_id: id } });
  assert.equal(first.result, 'disconnect'); assert.equal(first.request_id, id);
  let ended;
  for (let attempt = 0; attempt < 200; attempt++) {
    ended = await ui.invoke('serial_request', { request: { op: 'disconnect_status', connection, request_id: id } });
    if (ended.state === 'TRANSPORT_ENDED') break;
    await delay(10);
  }
  assert.equal(ended.state, 'TRANSPORT_ENDED');
  await ui.invoke('serial_request', { request: { op: 'forget', connection } });
  assert.deepEqual(await ui.invoke('serial_request', { request: { op: 'disconnect', connection, request_id: id } }), ended);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('有效范围 0')`);
  const retired = await call({ op: 'grant_status', request_id: saved.request_id });
  assert.deepEqual(retired.data.approved_scopes, scopes);
  assert.deepEqual(retired.data.effective_scopes, []);
  assert.equal(retired.data.summary.state, 'ACTIVE');
  assert.equal(retired.data.summary.expires_at_ms, original.data.summary.expires_at_ms);
  await ui.command('Page.reload');
  await ui.waitFor(`!!(${button('Agent 授权')})&&Array.from(document.querySelector('[aria-label="会话"]')?.options??[]).some(o=>o.value===${JSON.stringify(other.connection_id)})`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="Agent授权面板"]')`), false);
  await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="Agent签发编号"]')`);
  assert.equal(await count(), before + 1);
  assert.equal(await ui.evaluate(`!!(${button('确认批准Agent')})`), false);
  await ui.click('查询原Agent编号');
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('有效范围 0')`);
  console.log('PASS serial Agent GUI: default-none independent DISCONNECT only, cancel/switch/one-shot, exact target, no implicit read/write/control/lease/close, worker join receipt/Forget recovery, retired effective scopes and ID-only reload; synthetic memory port, no COM');
} finally {
  try {
    await ui?.close();
    if (directory) {
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(tmpdir()));
      assert.ok(path.basename(target).startsWith('shared-terminal-agent-ui-中文-serial-'));
      await rm(target, { recursive: true, force: true });
    }
  } finally { build(false); }
}
