import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
const preview=JSON.parse(await readFile('artifacts/P16-local-preview.json','utf8'));
assert.equal(preview.result,'PASS');
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-preview-close-中文-'));
let ui,result;
try{
  ui=await launchDesktop(root,{executable:path.join(preview.directory,'shared-terminal-desktop.exe')});
  const status=await ui.invoke('service_status');assert.equal(status.fixture,false);assert.deepEqual(await ui.invoke('service_list'),[]);
  assert.deepEqual((await ui.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,e=>e==='FIXTURE_DISABLED')`),true);
  await ui.evaluate(`(()=>{const d=document.querySelector('details.tools-menu');if(!d.open)d.querySelector('summary').click();setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出桌面').click(),50);return true;})()`);
  for(let i=0;i<160&&ui.app.exitCode===null;i++)await delay(50);
  assert.equal(ui.app.exitCode,0);await ui.close();ui=undefined;
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',`${status.service_id}.json`),'utf8'));
  assert.equal(receipt.format,'shared-terminal-desktop-close-v1');assert.equal(receipt.version,1);assert.equal(receipt.service_id,status.service_id);assert.equal(receipt.owned_pid,status.pid);
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');assert.equal(receipt.exited,true);assert.equal(receipt.exit_code,0);assert.equal(receipt.kill_requested,false);assert.equal(receipt.reader.diagnostic.outcome,'CLOSED');assert.equal(receipt.reader.diagnostic.accepted,receipt.reader.diagnostic.synced);
  result={result:'PASS',preview:preview.directory,ordinary:true,fixtureRefused:true,receipt,scope:'actual copied preview; fresh own root; owned process exit checked'};
}finally{
  await ui?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-preview-close-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
await writeFile('artifacts/P22-close-preview-result.json',JSON.stringify(result,null,2)+'\n');
console.log('PASS copied ordinary preview actual native close, persisted receipt, healthy audit and owned process release.');
