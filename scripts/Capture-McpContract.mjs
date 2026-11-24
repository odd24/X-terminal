import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop} from './lib/DesktopHarness.mjs';
import {processRpc} from './jsonrpc-client.mjs';
import {assertShortcutV2Catalog,assertShortcutV3Catalog,legacyTerminalReadMetadata} from './lib/McpCatalog.mjs';
const executable=process.argv[2]&&path.resolve(process.argv[2]);
const version=process.argv.includes('--v12')?12:process.argv.includes('--v13')?13:14;
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-mcp-contract-中文-'));let ui,rpc;
try{
 ui=await launchDesktop(root,{executable});const info=await ui.invoke('bridge_management_request',{request:{op:'info'}});
 rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
 await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'contract-capture',version:'2'}});rpc.notify('notifications/initialized',{});
 const tools=(await rpc.request('tools/list',{})).result.tools;
 const original=JSON.parse(await readFile('contracts/mcp/initial-tools.json','utf8'));
 assert.equal(original.version,11);
 assert.deepEqual(tools.slice(0,29),original.tools);
 assert.deepEqual(tools.slice(29).map(tool=>tool.name),['shortcuts_list','shortcuts_create','shortcuts_update','shortcuts_remove']);
 assert.deepEqual(tools.slice(0,3).map(t=>t.name),['logs_export','logs_export_status','logs_export_cancel']);
 assert.ok(tools.slice(0, version===12?33:29).every(t=>t.inputSchema.additionalProperties===false));
 const read=tools.find(tool=>tool.name==='terminal_read');
 assert.match(read.description,/max_bytes 16384\.\.65536/);
 const text=read.inputSchema.$defs.View.oneOf.find(view=>view.properties.kind.const==='text');
 assert.deepEqual(text.properties.max_bytes,{format:'uint',minimum:16384,maximum:65536,type:'integer'});
 const versions=[9,12,14,16,18,20,22,24,25,26];
 const historical=legacyTerminalReadMetadata(original.tools);
 for (const [index,count] of versions.entries()) {
   const historic=index+1;
   const file=historic===1?'v1-initial-tools.json':`v${historic}-tools.json`;
   const original=JSON.parse(await readFile(`contracts/mcp/${file}`,'utf8'));
   assert.deepEqual({...(historic===1?{}:{version:historic}),tools:historical.slice(-count)},original,`v${historic} remains exactly unchanged apart from terminal_read metadata in the current release`);
 }
 if(version===13){
   const legacy=JSON.parse(await readFile('contracts/mcp/v12-tools.json','utf8'));
   assertShortcutV2Catalog(tools,legacy.tools);
 }
 if(version===14){
   const previous=JSON.parse(await readFile('contracts/mcp/v13-tools.json','utf8'));
   assertShortcutV3Catalog(tools,previous.tools);
 }
 await writeFile(`contracts/mcp/v${version}-tools.json`,JSON.stringify({version,tools},null,2)+'\n');
 console.log(`PASS captured v${version} and confirmed backward-compatible shortcut and session contracts.`);
}finally{
 await rpc?.close();await ui?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-mcp-contract-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
