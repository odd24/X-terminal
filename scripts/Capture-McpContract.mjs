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
 assert.deepEqual(tools.map(t=>t.name),['ssh_resize','serial_connect','serial_connect_status','ssh_connect','ssh_connect_status','ssh_reconnect','ssh_reconnect_status','sessions_forget','sessions_forget_status','sessions_disconnect','sessions_disconnect_status','serial_write','serial_control','ssh_exec','tasks_get','tasks_cancel','agent_status','sessions_list','terminal_read','terminal_screen','terminal_send','terminal_input_status','input_lease','input_acquire','input_release']);
 assert.ok(tools.every(t=>t.inputSchema.additionalProperties===false));
 const initial=JSON.parse(await readFile('contracts/mcp/v1-initial-tools.json','utf8'));
 assert.deepEqual({tools:tools.slice(16)},initial,'original nine tool schemas remain exactly unchanged');
 assert.deepEqual({version:2,tools:tools.slice(13)},JSON.parse(await readFile('contracts/mcp/v2-tools.json','utf8')),'previous twelve schemas remain exactly unchanged');
 assert.deepEqual({version:3,tools:tools.slice(11)},JSON.parse(await readFile('contracts/mcp/v3-tools.json','utf8')),'previous fourteen tools remain exactly unchanged');
 assert.deepEqual({version:4,tools:tools.slice(9)},JSON.parse(await readFile('contracts/mcp/v4-tools.json','utf8')),'previous sixteen tools remain exactly unchanged');
 assert.deepEqual({version:5,tools:tools.slice(7)},JSON.parse(await readFile('contracts/mcp/v5-tools.json','utf8')),'previous eighteen tools remain exactly unchanged');
 assert.deepEqual({version:6,tools:tools.slice(5)},JSON.parse(await readFile('contracts/mcp/v6-tools.json','utf8')),'previous twenty tools remain exactly unchanged');
 assert.deepEqual({version:7,tools:tools.slice(3)},JSON.parse(await readFile('contracts/mcp/v7-tools.json','utf8')),'previous twenty-two tools remain exactly unchanged');
 assert.deepEqual({version:8,tools:tools.slice(1)},JSON.parse(await readFile('contracts/mcp/v8-tools.json','utf8')),'previous twenty-four tools remain exactly unchanged');
 await writeFile('contracts/mcp/initial-tools.json',JSON.stringify({version:9,tools},null,2)+'\n');
 console.log('PASS captured exact twenty-five-tool v9 schema; previous twenty-four unchanged; no pairing or execution.');
}finally{
 await rpc?.close();await ui?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-mcp-contract-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
