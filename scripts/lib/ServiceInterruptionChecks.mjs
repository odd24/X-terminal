import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './DesktopHarness.mjs';

const error = (ui, command, args = {}) => ui.evaluate(
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(()=>null,e=>String(e))`);

function windowsProcesses(script, desktopPid, servicePid, executable) {
  assert.ok(Number.isSafeInteger(desktopPid) && desktopPid > 0);
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 0 && servicePid !== desktopPid);
  return JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, P24_DESKTOP_PID: String(desktopPid), P24_SERVICE_PID: String(servicePid), P24_SERVICE_EXE: executable },
  }));
}

export async function checkServiceInterruption({
  ui, call, success, ref, management, grantId, lease, control, send, directory, serviceExecutable, reopen,
}) {
  const owner = await ui.invoke('service_status');
  assert.equal(owner.fixture, false);
  const desktopPid = ui.app.pid;
  const metrics = () => control({ op: 'metrics' });
  const statusArgs = request_id => ({ transport: 'SSH2', connection: ref, request_id });
  const receipt = async id => (await success('terminal_input_status', statusArgs(id))).data;
  const accepted = await receipt(send.request_id);
  assert.equal(accepted.state, 'PIPELINE_QUEUED');
  assert.equal(accepted.pipeline_bytes, Buffer.byteLength(send.text));
  assert.deepEqual(Buffer.from((await metrics()).received.flat()), Buffer.from(send.text));
  const grant = await management({ op: 'grant_status', request_id: grantId });
  assert.deepEqual(grant.data.effective_scopes.map(scope => scope.action).sort(), ['READ', 'WRITE']);
  assert.equal((await success('input_lease', { connection: ref })).data.lease_id, lease.lease_id);

  await control({ op: 'stall_next_data' });
  const burst = [];
  for (let index = 0; index < 4; index++) {
    const args = { ...statusArgs(randomUUID()), text: `P24_SERVICE_IN_FLIGHT_${index}:`.padEnd(16384, 'x') };
    burst.push(args);
    await success('terminal_send', args);
  }
  let dispatching;
  for (let attempt = 0; attempt < 150 && !dispatching; attempt++) {
    for (const input of burst) {
      const observed = await receipt(input.request_id);
      if (observed.state === 'DISPATCHING') { dispatching = observed; break; }
    }
    if (!dispatching) await delay(20);
  }
  assert.ok(dispatching, 'a write must be observed in DISPATCHING before the service is terminated');
  const beforeLoss = await metrics();
  assert.ok(beforeLoss.received.flat().length > accepted.pipeline_bytes);
  assert.deepEqual(await receipt(dispatching.request_id), dispatching);
  const checkedOwner = await ui.invoke('service_status');
  assert.equal(checkedOwner.service_id, owner.service_id);
  assert.equal(checkedOwner.pid, owner.pid);

  const externalExit = windowsProcesses(`
    $ErrorActionPreference = 'Stop'
    $service = [int]$env:P24_SERVICE_PID
    $desktop = [int]$env:P24_DESKTOP_PID
    $process = [Diagnostics.Process]::GetProcessById($service)
    try {
      $null = $process.Handle
      $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$service"
      if (!$actual -or $actual.ParentProcessId -ne $desktop -or $actual.ExecutablePath -ine $env:P24_SERVICE_EXE -or $process.HasExited) {
        throw 'Refusing termination without the exact owned service identity'
      }
      $process.Kill()
      if (!$process.WaitForExit(5000)) { throw 'Owned service did not exit' }
      @{pid=$service; parent=$desktop; code=$process.ExitCode} | ConvertTo-Json -Compress
    } finally { $process.Dispose() }
  `, desktopPid, owner.pid, serviceExecutable);
  assert.equal(externalExit.pid, owner.pid);
  assert.equal(externalExit.parent, desktopPid);
  assert.notEqual(externalExit.code, 0);
  const failure = '会话服务不可用；未重连或重放输入。请退出后重新启动。';
  await ui.click('关闭Agent授权');
  await ui.waitFor(`document.querySelector('.status')?.textContent === ${JSON.stringify(failure)} && document.querySelector('.status').getClientRects().length > 0`);
  const assertUnknown = async id => {
    const result = await call('terminal_input_status', statusArgs(id));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error_code, 'UNKNOWN_DELIVERY');
  };
  await assertUnknown(accepted.request_id);
  await assertUnknown(dispatching.request_id);
  await delay(600);
  assert.equal(ui.app.exitCode, null);
  assert.equal(await error(ui, 'service_status'), 'SERVICE_UNAVAILABLE');
  assert.deepEqual(windowsProcesses(`
    $ErrorActionPreference = 'Stop'
    $desktop = [int]$env:P24_DESKTOP_PID
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$desktop AND Name='session-service.exe'")
    @{count=$children.Count} | ConvertTo-Json -Compress
  `, desktopPid, owner.pid, serviceExecutable), { count: 0 });
  const assertPeerUnchanged = async () => {
    const now = await metrics();
    assert.equal(now.accepted_connections, beforeLoss.accepted_connections);
    assert.equal(now.attempts, beforeLoss.attempts);
    assert.deepEqual(now.received, beforeLoss.received);
  };
  await assertPeerUnchanged();

  async function close(app) {
    await app.evaluate(`(()=>{
      const menu=document.querySelector('details.tools-menu');
      if(!menu.open)menu.querySelector('summary').click();
      setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出桌面').click(),50);
    })()`);
    for (let i = 0; i < 160 && app.app.exitCode === null; i++) {
      if (await app.evaluate(`!!document.querySelector('[aria-label="退出桌面确认"]')`).catch(() => false)) {
        await app.click('确认退出并停止服务').catch(() => {});
      }
      await delay(50);
    }
    assert.equal(app.app.exitCode, 0);
    await app.close();
  }
  await close(ui);
  const closed = JSON.parse(await readFile(path.join(directory, 'desktop-close-receipts-v1', `${owner.service_id}.json`), 'utf8'));
  assert.equal(closed.service_id, owner.service_id);
  assert.equal(closed.owned_pid, owner.pid);
  assert.equal(closed.exited, true);
  assert.equal(closed.exit_code, externalExit.code);
  assert.equal(closed.kill_requested, false);
  assert.equal(closed.kill_request_ok, null);
  assert.equal(closed.shutdown_attempted, false);
  assert.equal(closed.shutdown_ack, 'NOT_ATTEMPTED');
  assert.equal(closed.request_error, 'UNAVAILABLE');
  assert.equal(closed.reader.diagnostic, null);

  const next = await reopen();
  const status = await next.invoke('service_status');
  assert.equal(status.fixture, false);
  assert.notEqual(status.service_id, owner.service_id);
  assert.deepEqual(await next.invoke('service_list'), []);
  const agent = request => next.invoke('agent_management_request', { request });
  assert.deepEqual((await agent({ op: 'grant_list' })).data, []);
  const oldGrant = await error(next, 'agent_management_request', { request: { op: 'grant_status', request_id: grantId } });
  assert.equal(oldGrant, 'NotFound');
  const oldLease = await agent({ op: 'lease', connection: ref });
  assert.deepEqual(oldLease, { type: 'lease', data: null });
  assert.equal((await next.invoke('bridge_management_request', { request: { op: 'info' } })).peer, null);
  await assertUnknown(dispatching.request_id);
  await next.waitFor(`!!document.querySelector('[aria-label="上次关闭提示"]')`);
  assert.equal(status.previous_close.receipt.service_id, owner.service_id);
  await delay(600);
  await assertPeerUnchanged();
  await close(next);
  return {
    result: 'PASS', original_service: owner.service_id, recovered_service: status.service_id,
    external_exit: externalExit, failure_ui: failure, accepted, dispatching,
    original_queries_after_loss: 'UNKNOWN_DELIVERY', old_grant_after_restart: oldGrant,
    old_lease_after_restart: oldLease.data, old_stdio_query_after_restart: 'UNKNOWN_DELIVERY',
    peer_connections: beforeLoss.accepted_connections,
    peer_auth_attempts: beforeLoss.attempts, peer_bytes_last_observed: beforeLoss.received.flat().length,
    close_receipt: closed,
  };
}
