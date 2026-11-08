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
  files.push({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
await copyFile('docs/LOCAL_PREVIEW.md',path.join(destination,'README.md'));
let ui,directory;
try{
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-preview-ui-中文-'));
  ui=await launchDesktop(directory,{executable:path.join(destination,'shared-terminal-desktop.exe')});
  assert.deepEqual(await ui.invoke('service_list'),[],'ordinary service starts without test connections');
  let rejected=false;try{await ui.invoke('fixture_create');}catch{rejected=true;}assert.ok(rejected,'packaged ordinary service rejects fixture API');
  const broker=await ui.invoke('bridge_management_request',{request:{op:'info'}});
  assert.equal(path.resolve(broker.executable).toLowerCase(),path.join(destination,'terminal-mcp.exe').toLowerCase(),'native bridge resolves the packaged sibling');
  assert.equal(broker.peer,null);
  await ui.screenshot('P16-local-preview.png');
}finally{
  await ui?.close();if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-preview-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
await writeFile(path.join(destination,'manifest.json'),JSON.stringify({format:1,kind:'local development preview; not an installer or external release',version:'0.1.0',packagedAt:new Date().toISOString(),packagedFromHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files,smoke:'PASS: copied desktop/ordinary sibling service, no fixture capability, packaged MCP path, clean shutdown'},null,2)+'\n');
await writeFile('artifacts/P16-local-preview.json',JSON.stringify({result:'PASS',directory:destination,files},null,2)+'\n');
console.log(`PASS local preview smoke and shutdown: ${destination}`);
