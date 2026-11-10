import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './DesktopHarness.mjs';

export async function crashDesktopOwner(ui, owner, previewDirectory) {
  const current = await ui.invoke('service_status');
  assert.equal(current.service_id, owner.service_id);
  assert.equal(current.pid, owner.pid);
  assert.equal(current.fixture, false);
  assert.ok(Number.isSafeInteger(ui.app.pid) && ui.app.pid > 0 && ui.app.exitCode === null);
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== ui.app.pid);
  const observed = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $desktopPid = [int]$env:P24_DESKTOP_PID
    $servicePid = [int]$env:P24_SERVICE_PID
    $desktop = [Diagnostics.Process]::GetProcessById($desktopPid)
    $service = [Diagnostics.Process]::GetProcessById($servicePid)
    try {
      $null = $desktop.Handle
      $null = $service.Handle
      $actualDesktop = Get-CimInstance Win32_Process -Filter "ProcessId=$desktopPid"
      $actualService = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
      if (!$actualDesktop -or !$actualService -or $desktop.HasExited -or $service.HasExited -or
          $actualDesktop.ParentProcessId -ne [int]$env:P24_TEST_PID -or $actualDesktop.ExecutablePath -ine $env:P24_DESKTOP_EXE -or
          $actualService.ParentProcessId -ne $desktopPid -or $actualService.ExecutablePath -ine $env:P24_SERVICE_EXE) {
        throw 'Refusing termination without exact test Desktop and owned service identities'
      }
      $desktop.Kill($false)
      if (!$desktop.WaitForExit(5000)) { throw 'Owned Desktop did not exit' }
      if (!$service.WaitForExit(5000)) { throw 'Service remained alive after Desktop-only termination' }
      @{desktop_pid=$desktopPid; service_pid=$servicePid; desktop_exit_code=$desktop.ExitCode; service_exited=$true} | ConvertTo-Json -Compress
    } finally {
      $desktop.Dispose()
      $service.Dispose()
    }
  `], {
    encoding: 'utf8', windowsHide: true, timeout: 18000,
    env: {
      ...process.env,
      P24_TEST_PID: String(process.pid),
      P24_DESKTOP_PID: String(ui.app.pid),
      P24_SERVICE_PID: String(owner.pid),
      P24_DESKTOP_EXE: await realpath(path.join(previewDirectory, 'shared-terminal-desktop.exe')),
      P24_SERVICE_EXE: await realpath(path.join(previewDirectory, 'session-service.exe')),
    },
  }));
  assert.equal(observed.desktop_pid, ui.app.pid);
  assert.equal(observed.service_pid, owner.pid);
  assert.notEqual(observed.desktop_exit_code, 0);
  assert.equal(observed.service_exited, true);
  // Both handles were observed signalled before the harness closes its CDP client.
  await ui.close();
  return observed;
}

export async function checkOwnerCrashRestart({ ui, owner, grant, profiles, data, metrics, expectedWire }) {
  const current = await ui.invoke('service_status');
  assert.equal(current.fixture, false);
  assert.notEqual(current.service_id, owner.service_id);
  assert.deepEqual(current.previous_close, { availability: 'EMPTY', receipt: null, attention: false });
  await assert.rejects(access(path.join(data, 'desktop-close-receipts-v1', `${owner.service_id}.json`)), { code: 'ENOENT' });
  assert.deepEqual(await ui.invoke('service_list'), []);
  const page = await ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
  assert.deepEqual(page.profiles, profiles);
  const agent = request => ui.invoke('agent_management_request', { request });
  assert.deepEqual((await agent({ op: 'grant_list' })).data, []);
  const oldRequest = { op: 'grant_status', request_id: grant.request_id };
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('agent_management_request',${JSON.stringify({ request: oldRequest })}).then(()=>null,e=>String(e))`), 'NotFound');
  await delay(600);
  const peer = await metrics();
  assert.equal(peer.accepted_connections, 1);
  assert.equal(peer.attempts, 1);
  assert.deepEqual(Buffer.from(peer.received.flat()), Buffer.from(expectedWire));
  return { current, peerConnections: peer.accepted_connections, peerAuthAttempts: peer.attempts, peerBytes: Buffer.byteLength(expectedWire) };
}
