import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
import {processRpc} from './jsonrpc-client.mjs';
const preview=JSON.parse(await readFile('artifacts/P16-local-preview.json','utf8'));
const catalogVersion=process.argv.includes('--mcp-v6')?6:process.argv.includes('--mcp-v5')?5:process.argv.includes('--mcp-v4')?4:process.argv.includes('--mcp-v3')?3:process.argv.includes('--mcp-v2')?2:null;
assert.equal(preview.result,'PASS');
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-preview-close-中文-'));
let ui,rpc,result;
try{
  ui=await launchDesktop(root,{executable:path.join(preview.directory,'shared-terminal-desktop.exe')});
  const status=await ui.invoke('service_status');assert.equal(status.fixture,false);assert.deepEqual(await ui.invoke('service_list'),[]);
  assert.deepEqual((await ui.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,e=>e==='FIXTURE_DISABLED')`),true);
  let toolCount;
  if(catalogVersion){
    const info=await ui.invoke('bridge_management_request',{request:{op:'info'}});
    assert.equal(path.resolve(info.executable).toLowerCase(),path.join(preview.directory,'terminal-mcp.exe').toLowerCase());
    rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
    await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'copied-preview-v2',version:'2'}});rpc.notify('notifications/initialized',{});
    const tools=(await rpc.request('tools/list',{})).result.tools;
    assert.deepEqual({version:catalogVersion,tools},JSON.parse(await readFile(catalogVersion===6?'contracts/mcp/initial-tools.json':`contracts/mcp/v${catalogVersion}-tools.json`,'utf8')));assert.equal(tools.length,8+2*catalogVersion);toolCount=tools.length;
    assert.equal((await rpc.close()).code,0);rpc=undefined;
  }
  await ui.evaluate(`(()=>{const d=document.querySelector('details.tools-menu');if(!d.open)d.querySelector('summary').click();setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出桌面').click(),50);return true;})()`);
  for(let i=0;i<160&&ui.app.exitCode===null;i++)await delay(50);
  assert.equal(ui.app.exitCode,0);await ui.close();ui=undefined;
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',`${status.service_id}.json`),'utf8'));
  assert.equal(receipt.format,'shared-terminal-desktop-close-v1');assert.equal(receipt.version,1);assert.equal(receipt.service_id,status.service_id);assert.equal(receipt.owned_pid,status.pid);
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');assert.equal(receipt.exited,true);assert.equal(receipt.exit_code,0);assert.equal(receipt.kill_requested,false);assert.equal(receipt.reader.diagnostic.outcome,'CLOSED');assert.equal(receipt.reader.diagnostic.accepted,receipt.reader.diagnostic.synced);
  result={result:'PASS',preview:preview.directory,ordinary:true,fixtureRefused:true,...(toolCount?{mcp_catalog_version:catalogVersion,mcp_tools:toolCount}:{}),receipt,scope:'actual copied preview; fresh own root; owned process exit checked'};
}finally{
  await rpc?.close();await ui?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-preview-close-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
await writeFile(catalogVersion===6?'artifacts/P15-reconnect-v6-preview-result.json':catalogVersion===5?'artifacts/P15-forget-v5-preview-result.json':catalogVersion===4?'artifacts/P15-disconnect-v4-preview-result.json':catalogVersion===3?'artifacts/P15-serial-v3-preview-result.json':catalogVersion===2?'artifacts/P15-exec-preview-result.json':'artifacts/P22-close-preview-result.json',JSON.stringify(result,null,2)+'\n');
console.log('PASS copied ordinary preview actual native close, persisted receipt, healthy audit and owned process release.');
