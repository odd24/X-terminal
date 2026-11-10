import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop} from './lib/DesktopHarness.mjs';
import {processRpc} from './jsonrpc-client.mjs';
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-mcp-contract-中文-'));let ui,rpc;
try{
 ui=await launchDesktop(root);const info=await ui.invoke('bridge_management_request',{request:{op:'info'}});
 rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
 await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'contract-capture',version:'2'}});rpc.notify('notifications/initialized',{});
 const tools=(await rpc.request('tools/list',{})).result.tools;
 assert.deepEqual(tools.slice(0,3).map(t=>t.name),['logs_export','logs_export_status','logs_export_cancel']);
 assert.ok(tools.every(t=>t.inputSchema.additionalProperties===false));
 const versions=[9,12,14,16,18,20,22,24,25,26];
 for (const [index,count] of versions.entries()) {
   const version=index+1;
   const file=version===1?'v1-initial-tools.json':`v${version}-tools.json`;
   const original=JSON.parse(await readFile(`contracts/mcp/${file}`,'utf8'));
   assert.deepEqual({...(version===1?{}:{version}),tools:tools.slice(-count)},original,`v${version} remains exactly unchanged`);
 }
 await writeFile('contracts/mcp/initial-tools.json',JSON.stringify({version:11,tools},null,2)+'\n');
 console.log('PASS captured exact twenty-nine-tool v11 schema; previous twenty-six unchanged; no pairing or execution.');
}finally{
 await rpc?.close();await ui?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-mcp-contract-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
