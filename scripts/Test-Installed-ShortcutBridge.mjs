import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestId } from '../apps/desktop/src/request-id.ts';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { readMcpCatalog } from './lib/McpCatalog.mjs';
import { processRpc } from './jsonrpc-client.mjs';

const [desktop, previous, launcher, shell, report] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(desktop && previous && launcher && shell && report);
const root = await mkdtemp(path.join(await realpath(tmpdir()), 'shared-terminal-installed-mcp-中文-'));
const bridge = path.join(path.dirname(desktop), 'terminal-mcp.exe');
const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher, '-PreferredPath', desktop, '-PreviousPath', previous];
const checks = [];
let ui, rpc, evidence;

try {
  ui = await launchDesktop(root, { executable: desktop });
  const owner = await ui.invoke('service_status');
  assert.equal(owner.fixture, false);
  assert.deepEqual(await ui.invoke('service_list'), []);
  const before = await ui.invoke('local_adb_settings', { settings: null });
  const info = await ui.invoke('bridge_management_request', { request: { op: 'info' } });
  assert.equal(info.peer, null);
  assert.equal(path.resolve(info.executable).toLowerCase(), bridge.toLowerCase());
  rpc = processRpc(shell,args);
  const initialized = await rpc.request('initialize', { protocolVersion: '2025-03-26',
    capabilities: {}, clientInfo: { name: 'installed-stdio-check', version: '1' } }, 12000);
  assert.ok(initialized.result?.capabilities.tools);
  rpc.notify('notifications/initialized',{});
  const { tools } = (await rpc.request('tools/list',{})).result;
  const catalog = await readMcpCatalog(13);
  assert.deepEqual(tools,catalog.tools);

  async function call(name, args={}) {
    const { result } = await rpc.request('tools/call', { name, arguments: args });
    assert.ok(result, name);
    for (const item of result.content) assert.deepEqual(JSON.parse(item.text),result.structuredContent);
    return result;
  }
  const status = (await call('agent_status')).structuredContent;
  assert.equal(status.mock,false);
  assert.equal(status.reply.data.paired_ticket,null);
  const pid = status.reply.data.peer_pid;
  assert.ok(Number.isSafeInteger(pid));
  const child = JSON.parse(execFileSync(shell,['-NoProfile','-Command',
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`],
  { encoding:'utf8', windowsHide:true }));
  assert.equal(child.ParentProcessId,rpc.child.pid);
  assert.equal(path.resolve(child.ExecutablePath).toLowerCase(),bridge.toLowerCase());
  const nil='00000000-0000-0000-0000-000000000000';
  for(const [name,body] of [
    ['sessions_list',{}],
    ['shortcuts_list',{}],
    ['shortcuts_list',{version:'v2'}],
    ['shortcuts_list',{version:'v2',receipt_request_id:requestId()}],
    ['shortcuts_create',{version:'v2',request_id:requestId(),revision:nil,
      items:[{name:'隔离测试',target:{type:'local',command:'probe.exe one\r\nprobe.exe two'}}]}],
    ['shortcuts_update',{version:'v2',request_id:requestId(),revision:nil,
      changes:[{id:requestId(),close_on_success:false}]}],
    ['shortcuts_remove',{version:'v2',request_id:requestId(),revision:nil,ids:[requestId()]}],
  ]){
    assert.deepEqual((await call(name,body)).structuredContent,{mock:false,error_code:'PERMISSION_DENIED'});
    checks.push({tool:name,version:body.version??null,outcome:'PERMISSION_DENIED'});
  }
  assert.deepEqual(await ui.invoke('local_adb_settings',{settings:null}),before);
  assert.equal((await rpc.close()).code,0);
  rpc=undefined;
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('退出桌面');
  for(let attempt=0;attempt<160&&ui.app.exitCode===null;attempt++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',owner.service_id+'.json'),'utf8'));
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');
  assert.equal(receipt.owned_pid,owner.pid);
  assert.equal(receipt.exited,true);
  assert.equal(receipt.exit_code,0);
  await ui.close();
  ui=undefined;
  evidence={ result:'PASS', desktop, bridge, registration:{command:shell,args}, version:catalog.version,
    tools:tools.length, checks, fixture:false, paired:false, shutdown:receipt.shutdown_ack };
} finally {
  await rpc?.close();
  await ui?.close();
  assert.ok(path.basename(root).startsWith('shared-terminal-installed-mcp-中文-'));
  assert.equal(path.dirname(root),await realpath(tmpdir()));
  await rm(root,{recursive:true,force:true,maxRetries:12,retryDelay:100});
}
await writeFile(report,JSON.stringify({...evidence,isolatedRootRemoved:true},null,2)+'\n');
console.log('PASS installed launcher selected the same-directory bridge, discovered v13 and rejected unapproved calls');
