import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {launchDesktop} from './lib/DesktopHarness.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'shared-terminal-audit-diagnostic-ui-中文-'));
let ui;
try {
  ui=await launchDesktop(root);assert.equal((await ui.invoke('service_status')).fixture,false);assert.deepEqual(await ui.invoke('service_list'),[]);
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,e=>e==='FIXTURE_DISABLED')`),true);
  const audit=await ui.invoke('audit_history_request',{request:{op:'info'}});assert.equal(audit.status.state,'HEALTHY');
  assert.deepEqual((await ui.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
}finally{await ui?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-audit-diagnostic-ui-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
console.log('PASS ordinary Desktop/service, fixture refusal and audit projection unchanged.');
