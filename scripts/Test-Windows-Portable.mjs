import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { openCodexMcpClient } from './lib/CodexMcpClient.mjs';

const packageDir = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const readJson = async file => JSON.parse(await readFile(file,'utf8'));
const manifest = await readJson(path.join(packageDir,'manifest.json'));
const expectedFiles = ['README.md','session-service.exe','shared-terminal-desktop.exe','terminal-mcp.exe'];
assert.equal(manifest.version,(await readJson('package.json')).version);
assert.equal(manifest.target,'x86_64-pc-windows-msvc');
assert.equal(manifest.buildProfile,'release');
assert.deepEqual(manifest.files.map(file=>file.name).sort(),expectedFiles);
assert.deepEqual((await readdir(packageDir)).sort(),[...expectedFiles,'manifest.json'].sort());
for(const file of manifest.files){
  const bytes = await readFile(path.join(packageDir,file.name));
  assert.equal(bytes.length,file.bytes,file.name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.name);
  if(!file.name.endsWith('.exe'))continue;
  assert.equal(file.authenticode,'NotSigned');
  assert.equal(bytes.toString('ascii',0,2),'MZ');
  const pe=bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii',pe,pe+4),'PE\0\0');
  assert.equal(bytes.readUInt16LE(pe+4),0x8664,'Windows x64 image');
  if(file.name==='shared-terminal-desktop.exe')assert.equal(bytes.readUInt16LE(pe+24+68),2,'Windows GUI subsystem');
}

const root = await mkdtemp(path.join(tmpdir(),'shared-terminal-portable-ui-中文-'));
const executable = path.join(packageDir,'shared-terminal-desktop.exe');
const serviceExecutable = path.join(packageDir,'session-service.exe');
const launch = (image, name) => launchDesktop(root,{executable:image,webviewDirectory:path.join(root,name)});
const configure = (ui, request) => ui.invoke('config_request',{request});
const page = ui => configure(ui,{op:'page',revision:null,offset:0,folders:false});
const preferences = ui => configure(ui,{op:'preferences'});
const psJson = command => JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '+command],
{windowsHide:true,encoding:'utf8'}));

async function closeIdle(ui, status, auditReady=true) {
  assert.deepEqual(await ui.invoke('service_list'),[]);
  const scheduled=await ui.evaluate(`(() => {
    const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click();
    const button=Array.from(menu.querySelectorAll('button')).find(item=>item.textContent==='退出桌面');
    if(!button||button.disabled)return false;
    setTimeout(()=>button.click(),50);
    return true;
  })()`);
  assert.equal(scheduled,true);
  for(let attempt=0;attempt<160&&ui.app.exitCode===null;attempt++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  const receipt=await readJson(path.join(root,'desktop-close-receipts-v1',status.service_id+'.json'));
  assert.equal(receipt.owned_pid,status.pid);
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');
  assert.equal(receipt.exited,true);
  assert.equal(receipt.exit_code,0);
  assert.equal(receipt.kill_requested,false);
  const diagnostic=receipt.reader.diagnostic;
  if(auditReady){
    assert.equal(diagnostic.outcome,'CLOSED');
    assert.equal(diagnostic.accepted,diagnostic.synced);
  }else assert.equal(diagnostic,null,'locked-startup service has no audit writer');
  await ui.close();
  return {ack:receipt.shutdown_ack,serviceExit:receipt.exit_code,desktopExit:ui.app.exitCode};
}

let owner, release, client, evidence;
try {
  const guards = path.join(root,'empty-guards');
  await mkdir(guards);
  for(const image of [executable,serviceExecutable]){
    const probe=spawnSync(image,['--serial-mcp-fixture','--data-dir',guards],
      {encoding:'utf8',windowsHide:true,timeout:10000});
    assert.ifError(probe.error);
    assert.notEqual(probe.status,0);
    assert.match(probe.stderr,/SERIAL_MCP_FIXTURE_DISABLED/);
    assert.deepEqual(await readdir(guards),[]);
  }
  const previousPatch=Number(manifest.version.split('.')[2])-1;
  const previousVersion=previousPatch>=0?'0.1.'+previousPatch:undefined;
  const previousDirectory=previousVersion
    ?path.resolve('artifacts/SharedTerminal-'+previousVersion+'-windows-x64')
    :(await readJson('artifacts/terminal-font-size-preview.json')).directory;
  owner = await launch(path.join(previousDirectory,'shared-terminal-desktop.exe'),'prior-webview');
  const ownerStatus = await owner.invoke('service_status');
  assert.equal(ownerStatus.fixture,false);
  const profile = {id:randomUUID(),folder_id:null,name:'便携版兼容验证',settings:{
    protocol:'ssh2',host:'127.0.0.1',port:22,username:'synthetic',auth:'password',encoding:'utf8',
  }};
  assert.equal((await configure(owner,{op:'save_profile',profile,credential:{action:'clear'}})).result,'saved_profile');
  const before = await preferences(owner);
  const expectedPreferences = {...before.preferences,font_size:19,terminal_text_brightness:70};
  assert.equal((await configure(owner,{op:'save_preferences',revision:before.revision,preferences:expectedPreferences})).result,'preferences');

  release = await launch(executable,'release-webview');
  const status = await release.invoke('service_status');
  assert.equal(status.fixture,false);
  assert.equal(status.ssh1_preview,false);
  assert.equal(path.resolve(await release.invoke('config_directory')).toLowerCase(),path.resolve(root).toLowerCase());
  const title = psJson(`(Get-Process -Id ${release.app.pid}).MainWindowTitle | ConvertTo-Json -Compress`);
  assert.equal(title,'共享终端');
  const consoles = psJson(`$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${release.app.pid}" | Where-Object { $_.Name -match '^(conhost|OpenConsole|WindowsTerminal|powershell|pwsh)\.exe$' }); ConvertTo-Json -InputObject $children.Count -Compress`);
  assert.equal(consoles,0);
  const service = psJson(`Get-CimInstance Win32_Process -Filter "ProcessId=${status.pid}" | Select-Object ExecutablePath,ParentProcessId | ConvertTo-Json -Compress`);
  assert.equal(service.ParentProcessId,release.app.pid);
  assert.equal(service.ExecutablePath.toLowerCase(),serviceExecutable.toLowerCase());
  assert.equal((await page(release)).code,'LOCKED');
  assert.equal(await release.evaluate("window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>null,error=>error)"),'FIXTURE_DISABLED');
  assert.deepEqual(await release.invoke('service_list'),[]);
  await closeIdle(owner,ownerStatus);
  owner=undefined;

  assert.equal((await page(release)).code,'LOCKED','ordinary reads must preserve the explicit recheck requirement');
  assert.equal((await configure(release,{op:'recheck',service_id:status.service_id})).result,'rechecked');
  assert.equal((await release.invoke('service_status')).service_id,status.service_id);
  assert.equal((await page(release)).profiles.find(saved=>saved.id===profile.id)?.name,profile.name);
  assert.deepEqual((await preferences(release)).preferences,expectedPreferences);
  assert.deepEqual((await release.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
  assert.equal((await release.invoke('audit_history_request',{request:{op:'info'}})).status.state,'STORAGE_FAILURE');
  await closeIdle(release,status,false);
  release=undefined;

  release=await launch(executable,'release-reopened-webview');
  const reopened=await release.invoke('service_status');
  assert.notEqual(reopened.service_id,status.service_id);
  assert.equal(reopened.fixture,false);
  assert.equal((await release.invoke('audit_history_request',{request:{op:'info'}})).status.state,'HEALTHY');
  assert.equal((await page(release)).profiles.find(saved=>saved.id===profile.id)?.name,profile.name);
  assert.deepEqual((await preferences(release)).preferences,expectedPreferences);

  const broker = request=>release.invoke('bridge_management_request',{request});
  const info = await broker({op:'info'});
  assert.equal(info.executable.toLowerCase(),path.join(packageDir,'terminal-mcp.exe').toLowerCase());
  assert.equal(info.peer,null);
  const catalog = await readJson('contracts/mcp/initial-tools.json');
  const observations = [];
  client = await openCodexMcpClient({directory:root,info,broker,catalog:catalog.tools,observations});
  assert.equal((await client.request('tools/call',{name:'agent_status',arguments:{}})).result.structuredContent.reply.data.paired_ticket,null);
  assert.equal((await client.request('tools/call',{name:'sessions_list',arguments:{}})).result.structuredContent.error_code,'PERMISSION_DENIED');
  assert.equal((await client.close()).code,0);
  client=undefined;
  const close=await closeIdle(release,reopened);
  release=undefined;
  evidence={result:'PASS',title,version:manifest.version,toolCount:catalog.tools.length,observations,close,
    priorVersion:previousVersion??'development preview',priorConfigLock:true,
    sameServiceRecheck:true,priorProfileAndPreferences:true,isolatedRoot:true,ordinaryService:true,
    sameDirectoryBridge:true,guardedFixturesRejected:true,auditHealthyAfterRestart:true,modelTurns:0};
}finally{
  await client?.close();await release?.close();await owner?.close();
  assert.equal(path.dirname(root),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('shared-terminal-portable-ui-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
await writeFile(output,JSON.stringify({...evidence,isolatedRootRemoved:true},null,2)+'\n');
console.log('PASS extracted Windows x64 portable build, previous config lock/recheck, native title, MCP tooling and graceful exit');
