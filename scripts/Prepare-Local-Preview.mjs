import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchDesktop } from './lib/DesktopHarness.mjs';

// Local-only preview. No installer, credentials/config copying, upload or publication.
await mkdir('artifacts',{recursive:true});
const destination=path.resolve('artifacts',`shared-terminal-preview-${randomUUID()}`);
await mkdir(destination,{recursive:false});
const files=[];
for(const name of ['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe']){
  const source=path.resolve('target/debug',name),target=path.join(destination,name);
  await copyFile(source,target);const data=await readFile(target);
  if(name==='shared-terminal-desktop.exe'){
    assert.equal(data.toString('ascii',0,2),'MZ');
    const pe=data.readUInt32LE(0x3c);
    assert.equal(data.toString('ascii',pe,pe+4),'PE\0\0');
    assert.equal(data.readUInt16LE(pe+24+68),2,'direct-launch desktop must use Windows GUI subsystem, including debug previews');
  }
  files.push({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
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
  let rejected=false;try{await ui.invoke('fixture_create');}catch{rejected=true;}assert.ok(rejected,'packaged ordinary service rejects fixture API');
  const broker=await ui.invoke('bridge_management_request',{request:{op:'info'}});
  assert.equal(path.resolve(broker.executable).toLowerCase(),path.join(destination,'terminal-mcp.exe').toLowerCase(),'native bridge resolves the packaged sibling');
  assert.equal(broker.peer,null);
  await ui.screenshot(process.argv.includes('--mcp-v8') ? 'P15-serial-connect-v8-preview.png' : process.argv.includes('--mcp-v7') ? 'P15-connect-v7-preview.png' : process.argv.includes('--mcp-v6') ? 'P15-reconnect-v6-preview.png' : process.argv.includes('--mcp-v5') ? 'P15-forget-v5-preview.png' : process.argv.includes('--mcp-v4') ? 'P15-disconnect-v4-preview.png' : 'P16-local-preview.png');
}finally{
  await ui?.close();if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-preview-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
await writeFile(path.join(destination,'manifest.json'),JSON.stringify({format:1,kind:'local development preview; not an installer or external release',version:'0.1.0',packagedAt:new Date().toISOString(),packagedFromHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files,smoke:'PASS: copied desktop/ordinary sibling service, no fixture capability, packaged MCP path, clean shutdown'},null,2)+'\n');
await writeFile('artifacts/P16-local-preview.json',JSON.stringify({result:'PASS',directory:destination,files},null,2)+'\n');
console.log(`PASS local preview smoke and shutdown: ${destination}`);
