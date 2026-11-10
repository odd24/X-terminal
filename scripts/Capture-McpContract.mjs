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
 assert.deepEqual(tools.map(t=>t.name),['serial_write','serial_control','ssh_exec','tasks_get','tasks_cancel','agent_status','sessions_list','terminal_read','terminal_screen','terminal_send','terminal_input_status','input_lease','input_acquire','input_release']);
 assert.ok(tools.every(t=>t.inputSchema.additionalProperties===false));
 const initial=JSON.parse(await readFile('contracts/mcp/v1-initial-tools.json','utf8'));
 assert.deepEqual({tools:tools.slice(5)},initial,'original nine tool schemas remain exactly unchanged');
 assert.deepEqual({version:2,tools:tools.slice(2)},JSON.parse(await readFile('contracts/mcp/v2-tools.json','utf8')),'previous twelve schemas remain exactly unchanged');
 await writeFile('contracts/mcp/initial-tools.json',JSON.stringify({version:3,tools},null,2)+'\n');
 console.log('PASS captured exact fourteen-tool v3 schema; previous twelve unchanged; no pairing or execution.');
}finally{
 await rpc?.close();await ui?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-mcp-contract-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
