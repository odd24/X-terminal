import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchDesktop } from './lib/DesktopHarness.mjs';

// Local-only preview. No installer, credentials/config copying, upload or publication.
const saveRecovery=process.argv.includes('--save-recovery');
const auditGrantFeedback=process.argv.includes('--audit-grant-feedback');
const stagePreview=process.argv.includes('--cr-022-polish')?'CR-022-polish-preview'
  :process.argv.includes('--cr-022')?'CR-022-preview'
  :process.argv.includes('--command-shortcuts')?'P19-command-shortcuts-preview'
  :process.argv.includes('--compact-ssh-auth')?'P12.1-compact-ssh-auth-preview':null;
const ssh1Option=process.argv.indexOf('--ssh1-service');
const ssh1Service=ssh1Option<0?undefined:process.argv[ssh1Option+1];
if(ssh1Option>=0)assert.ok(ssh1Service&&path.isAbsolute(ssh1Service)&&path.basename(ssh1Service)==='session-service.exe','paired SSH1 service required');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pairedFiles = ['session-service.exe', 'ssh1-helper.exe', 'PuTTY-LICENCE.txt'];
let pairing;
if (ssh1Service) {
  pairing = JSON.parse(await readFile(path.join(path.dirname(ssh1Service), 'ssh1-build-manifest.json'), 'utf8'));
  assert.equal(pairing.version, 1);
  assert.equal(pairing.archive_sha256, '13fd4db2936d03b73812a7bcc2a658e4dd29cc776a56c3670a7fc6f1a0ee8af8');
  assert.deepEqual(Object.keys(pairing.files).sort(), [...pairedFiles].sort());
  assert.ok(Object.values(pairing.files).every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)));
  assert.equal(pairing.files['PuTTY-LICENCE.txt'], '3b02f87e0063430289d9681727a98818c844fc8a4d79b24b76047fa061e77f13');
}
await mkdir('artifacts',{recursive:true});
const destination=path.resolve('artifacts',`shared-terminal-preview-${randomUUID()}`);
await mkdir(destination,{recursive:false});
const files=[];
for(const name of ['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe',...(ssh1Service?['ssh1-helper.exe','PuTTY-LICENCE.txt']:[])]){
  const paired = ssh1Service && pairedFiles.includes(name);
  const source = paired ? path.join(path.dirname(ssh1Service), name) : path.resolve('target/debug', name);
  const expected = digest(await readFile(source));
  if (paired) assert.equal(expected, pairing.files[name], `SSH1 staging hash mismatch for ${name}`);
  const target=path.join(destination,name);
  await copyFile(source,target);const data=await readFile(target);
  assert.equal(digest(data), expected, `preview copy hash mismatch for ${name}`);
  if(name==='shared-terminal-desktop.exe'){
    assert.equal(data.toString('ascii',0,2),'MZ');
    const pe=data.readUInt32LE(0x3c);
    assert.equal(data.toString('ascii',pe,pe+4),'PE\0\0');
    assert.equal(data.readUInt16LE(pe+24+68),2,'direct-launch desktop must use Windows GUI subsystem, including debug previews');
  }
  files.push({name,bytes:data.length,sha256:expected});
}
await copyFile('docs/LOCAL_PREVIEW.md',path.join(destination,'README.md'));
let ui,directory;
try{
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-preview-ui-中文-'));
  ui=await launchDesktop(directory,{executable:path.join(destination,'shared-terminal-desktop.exe'),windowsHide:false});
  // Inspect only names/PIDs, never command lines or user terminal contents.
  const consoleChildren=JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',`$items = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${ui.app.pid}" | Where-Object { $_.Name -match '^(conhost|OpenConsole|WindowsTerminal|powershell|pwsh)\\.exe$' } | Select-Object Name,ProcessId); ConvertTo-Json -InputObject $items -Compress`],{encoding:'utf8',windowsHide:true}));
  assert.deepEqual(consoleChildren,[],'direct launch must not create a console or shell child');
  assert.deepEqual(await ui.invoke('service_list'),[],'ordinary service starts without test connections');
  assert.equal(!!(await ui.invoke('service_status')).ssh1_preview,!!ssh1Service,'preview must use the expected service configuration');
  let rejected=false;try{await ui.invoke('fixture_create');}catch{rejected=true;}assert.ok(rejected,'packaged ordinary service rejects fixture API');
  const broker=await ui.invoke('bridge_management_request',{request:{op:'info'}});
  assert.equal(path.resolve(broker.executable).toLowerCase(),path.join(destination,'terminal-mcp.exe').toLowerCase(),'native bridge resolves the packaged sibling');
  assert.equal(broker.peer,null);
  await ui.screenshot(stagePreview?`${stagePreview}.png`:ssh1Service?'P13-ssh1-preview.png':auditGrantFeedback ? 'P22-audit-grant-feedback-preview.png' : saveRecovery ? 'P24-save-recovery-preview.png' : process.argv.includes('--mcp-v11') ? 'P15-protected-export-v11-preview.png' : process.argv.includes('--mcp-v10') ? 'P15-terminal-wait-v10-preview.png' : process.argv.includes('--mcp-v9') ? 'P15-ssh-resize-v9-preview.png' : process.argv.includes('--mcp-v8') ? 'P15-serial-connect-v8-preview.png' : process.argv.includes('--mcp-v7') ? 'P15-connect-v7-preview.png' : process.argv.includes('--mcp-v6') ? 'P15-reconnect-v6-preview.png' : process.argv.includes('--mcp-v5') ? 'P15-forget-v5-preview.png' : process.argv.includes('--mcp-v4') ? 'P15-disconnect-v4-preview.png' : 'P16-local-preview.png');
}finally{
  await ui?.close();if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-preview-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
await writeFile(path.join(destination,'manifest.json'),JSON.stringify({format:1,kind:'local development preview; not an installer or external release',version:'0.1.0',packagedAt:new Date().toISOString(),packagedFromHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files,smoke:'PASS: copied desktop/ordinary sibling service, no fixture capability, packaged MCP path, clean shutdown'},null,2)+'\n');
await writeFile(stagePreview?`artifacts/${stagePreview}.json`:ssh1Service?'artifacts/P13-ssh1-preview.json':auditGrantFeedback?'artifacts/P22-audit-grant-feedback-preview.json':saveRecovery?'artifacts/P24-save-recovery-preview.json':'artifacts/P16-local-preview.json',JSON.stringify({result:'PASS',directory:destination,files},null,2)+'\n');
console.log(`PASS local preview smoke and shutdown: ${destination}`);
