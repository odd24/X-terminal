import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop} from './lib/DesktopHarness.mjs';
import {processRpc} from './jsonrpc-client.mjs';
import {legacyTerminalReadMetadata} from './lib/McpCatalog.mjs';
const executable=process.argv[2]&&path.resolve(process.argv[2]);
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-mcp-contract-中文-'));let ui,rpc;
try{
 ui=await launchDesktop(root,{executable});const info=await ui.invoke('bridge_management_request',{request:{op:'info'}});
 rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
 await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'contract-capture',version:'2'}});rpc.notify('notifications/initialized',{});
 const tools=(await rpc.request('tools/list',{})).result.tools;
 assert.deepEqual(tools.slice(0,3).map(t=>t.name),['logs_export','logs_export_status','logs_export_cancel']);
 assert.ok(tools.every(t=>t.inputSchema.additionalProperties===false));
 const read=tools.find(tool=>tool.name==='terminal_read');
 assert.match(read.description,/max_bytes 16384\.\.65536/);
 const text=read.inputSchema.$defs.View.oneOf.find(view=>view.properties.kind.const==='text');
 assert.deepEqual(text.properties.max_bytes,{format:'uint',minimum:16384,maximum:65536,type:'integer'});
 const versions=[9,12,14,16,18,20,22,24,25,26];
 const historical=legacyTerminalReadMetadata(tools);
 for (const [index,count] of versions.entries()) {
   const version=index+1;
   const file=version===1?'v1-initial-tools.json':`v${version}-tools.json`;
   const original=JSON.parse(await readFile(`contracts/mcp/${file}`,'utf8'));
   assert.deepEqual({...(version===1?{}:{version}),tools:historical.slice(-count)},original,`v${version} remains exactly unchanged apart from terminal_read metadata in the current release`);
 }
 await writeFile('contracts/mcp/initial-tools.json',JSON.stringify({version:11,tools},null,2)+'\n');
 console.log('PASS captured exact v11 schema; historical snapshots match apart from the terminal_read metadata correction.');
}finally{
 await rpc?.close();await ui?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-mcp-contract-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
