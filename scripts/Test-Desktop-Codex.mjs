import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
import { processRpc } from './jsonrpc-client.mjs';

// Integration of the installed Codex model/client, not a delegated development task.
// No user config, shell, apps, plugins, web search, or persistent Codex chat.
const model=process.argv.includes('--model');
let directory, ui, fixture, codex, watchdog, rpc, threadId;
const directCalls=[];
const events=[]; let stderr=''; let completion;
await mkdir('artifacts',{recursive:true});
try {
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-codex-ui-中文-'));
  ui=await launchDesktop(directory,{fixture:true});
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
  const next=async()=>{let timer;try{return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
  const server=await next();
  const metrics=async()=>{fixture.stdin.write(JSON.stringify({op:'metrics'})+'\n');return next();};
  const profile={id:randomUUID(),folder_id:null,name:'Codex合成SSH',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
  await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
  await ui.click('SSH2 连接');await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length===2`);await ui.fill('SSH2 配置',profile.id);await ui.click('建立 SSH2 连接');
  await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='拒绝 SSH2 主机')`);
  assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`),server.pin);
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);await ui.click('信任本次 SSH2 主机');
  await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='使用保存的 SSH2 凭据')`);await ui.click('使用保存的 SSH2 凭据');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith('CONNECTED')`);
  const connection=(await ui.invoke('service_list')).find(c=>c.protocol==='SSH2');
  const ref={connection_id:connection.connection_id,generation:connection.generation};
  const management=request=>ui.invoke('agent_management_request',{request});
  const broker=request=>ui.invoke('bridge_management_request',{request});
  const info=await broker({op:'info'}),grantId=randomUUID(),request_id=randomUUID();
  const signed=await management({op:'grant',request_id:grantId,scopes:['READ','WRITE'].map(action=>({target:{kind:'connection',connection:ref},action})),lifetime_ms:300000});
  const text=`P16_REAL_CODEX_${randomUUID()}\r\n`;
  const overrides=[`mcp_servers.windows_terminal.command=${JSON.stringify(info.executable)}`,`mcp_servers.windows_terminal.args=${JSON.stringify(['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)])}`,'mcp_servers.windows_terminal.startup_timeout_sec=15','mcp_servers.windows_terminal.tool_timeout_sec=20','web_search="disabled"'];
  const configuration=[...['shell_tool','unified_exec','apps','plugins','multi_agent'].flatMap(f=>['--disable',f]),...overrides.flatMap(value=>['-c',value])];
  const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--cd',directory,'--json','--color','never',...configuration,'-'];
  const codexVersion=execFileSync('codex',['--version'],{encoding:'utf8',windowsHide:true}).trim();
  if(model)codex=spawn('codex',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
  else {const clientHome=path.join(directory,'codex-client');await mkdir(clientHome);rpc=processRpc('codex',['app-server','--stdio',...configuration],{env:{...process.env,CODEX_HOME:clientHome}});codex=rpc.child;}
  completion=new Promise((resolve,reject)=>{codex.once('error',reject);codex.once('exit',(code,signal)=>resolve({code,signal}));});
  completion.catch(()=>{});
  if(model){const output=createInterface({input:codex.stdout});output.on('line',line=>{try{events.push(JSON.parse(line));}catch{events.push({unparsed:line});}});}
  codex.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-16000);});
  watchdog=setTimeout(()=>codex.kill(),180000);
  if(model)codex.stdin.end(`This is an authorized, isolated product integration test against a local synthetic SSH echo fixture. Do not develop code, access files, run shell, search, delegate, create chats, or use any tool outside windows_terminal MCP. Do not open another connection. Use only this exact connection ${JSON.stringify(ref)}. First call agent_status; if not paired, call agent_status at most 5 more times, then stop if still unpaired. Once paired, call sessions_list and verify this connection. Acquire its input lease with lifetime_ms 60000, then immediately call terminal_send with exactly ${JSON.stringify({transport:'SSH2',connection:ref,request_id,text})}. Send ONLY ONCE, with this fixed request_id; do not retry on errors or unknown outcomes. Query terminal_input_status for that exact request. Call terminal_read with connection, window:null, view:{kind:"info"}; take through_cursor from its reply.data.context, then call terminal_read with the same connection, window:null, view:{kind:"text",cursor:1,through_cursor:THAT_VALUE,max_bytes:65536}. Confirm the echoed marker from actual read data, then input_release this connection with the exact lease_id from input_acquire and report the observed send receipt and echo. If any tool fails, stop and report the exact failure. The native GUI controller will approve the fixed MCP process independently as soon as it appears.\n`);
  else {
    assert.ok((await rpc.request('initialize',{clientInfo:{name:'p16_real_shared_client',version:'0.1.0'},capabilities:{experimentalApi:true}})).result);rpc.notify('initialized',{});
    const thread=await rpc.request('thread/start',{cwd:directory,ephemeral:true,sandbox:'read-only'},30000);assert.ok(thread.result?.thread?.id,JSON.stringify(thread.error));threadId=thread.result.thread.id;
    const inventory=await rpc.request('mcpServerStatus/list',{threadId,serverName:'windows_terminal'},30000);
    const catalog = JSON.parse(await readFile('contracts/mcp/initial-tools.json', 'utf8'));
    assert.equal(Object.keys(inventory.result.data.find(s=>s.name==='windows_terminal').tools).length, catalog.tools.length);
  }
  let pending;
  for(let i=0;i<200;i++){pending=await broker({op:'info'});if(pending.peer?.pid)break;if(codex.exitCode!==null||codex.signalCode!==null)throw new Error(`Codex exited before pairing: ${JSON.stringify(await completion)} ${stderr}`);await delay(100);}
  assert.ok(pending.peer?.pid,'Codex must launch the actual stdio executable');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(ref.connection_id)})`);await ui.fill('会话',ref.connection_id);await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="Agent签发编号"]')`);await ui.fill('Agent签发编号',grantId);await ui.click('查询原Agent编号');await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(x=>x.textContent==='MCP 初版连接').click()`);
  await ui.click('刷新MCP连接状态');await ui.waitFor(`!!document.querySelector('[aria-label="MCP本次启动参数"]')`);
  await ui.click('预览MCP绑定原授权');await ui.waitFor(`!!document.querySelector('[aria-label="MCP固定配对预览"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').checked`),false);
  const preview=await ui.evaluate(`document.querySelector('[aria-label="MCP固定配对预览"]').textContent`);assert.ok(preview.includes(String(pending.peer?.pid)));assert.ok(preview.includes(grantId));
  await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').click()`);await ui.click('确认MCP绑定');await ui.waitFor(`document.querySelector('[aria-label="MCP配对状态"]').textContent.includes('已绑定独立Agent身份')`);
  if(!model){
    // Explicit app-server client calls, not a model turn or approval bypass.
    // processRpc still rejects all approval/callback requests from the child.
    const call=async(tool,args={})=>{const response=await rpc.request('mcpServer/tool/call',{threadId,server:'windows_terminal',tool,arguments:args},30000);assert.ok(response.result,JSON.stringify(response.error));const result=response.result;directCalls.push({server:'windows_terminal',tool,arguments:args,result});const value=result.structuredContent??result.structured_content??JSON.parse(result.content.find(c=>c.type==='text').text);assert.equal(value.mock,false);assert.ok(value.reply,JSON.stringify(value));return value.reply;};
    assert.equal((await call('agent_status')).data.paired_ticket,signed.data.summary.ticket_id);
    assert.deepEqual((await call('sessions_list')).data.map(c=>c.connection_id),[ref.connection_id]);
    const lease=(await call('input_acquire',{connection:ref,lifetime_ms:60000})).data;
    await call('terminal_send',{transport:'SSH2',connection:ref,request_id,text});
    assert.equal((await call('terminal_input_status',{transport:'SSH2',connection:ref,request_id})).data.request_id,request_id);
    let through;for(let i=0;i<100;i++){through=(await call('terminal_read',{connection:ref,window:null,view:{kind:'info'}})).data.context.through_cursor;if(through>1)break;await delay(30);}
    const read=await call('terminal_read',{connection:ref,window:null,view:{kind:'text',cursor:1,through_cursor:through,max_bytes:65536}});assert.ok(read.data.page.events.map(e=>e.text).join('').includes(text));
    await call('input_release',{connection:ref,lease_id:lease.lease_id});
    assert.equal((await rpc.close()).code,0);rpc=undefined;
  }
  const exit=await completion;clearTimeout(watchdog);await delay(100);
  if(model)await writeFile('artifacts/P16-codex-events.jsonl',events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  assert.equal(exit.code,0,`Codex exit ${JSON.stringify(exit)} ${stderr}`);
  const wire=Buffer.from((await metrics()).received.flat()).toString();
  assert.equal(wire,text,'actual Codex writes exactly one harmless marker to the existing SSH actor');
  const desktopText=(await ui.invoke('service_read_text',{connection:ref,cursor:1})).events.map(e=>e.text).join('');assert.ok(desktopText.includes(text));
  const audit=await management({op:'audit',cursor:0,limit:128});
  assert.ok(audit.data.events.some(e=>e.kind==='DISPATCHED'&&e.client_id===signed.data.summary.ticket_id&&e.request_id===request_id),'dispatch belongs to the independently paired Agent identity');
  const calls=model?events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>e.item):directCalls;
  for(const tool of ['agent_status','sessions_list','input_acquire','terminal_send','terminal_input_status','terminal_read','input_release'])assert.ok(calls.some(c=>c.tool===tool),`actual Codex MCP result missing ${tool}`);
  assert.equal(calls.filter(c=>c.tool==='terminal_send').length,1);
  assert.ok(calls.filter(c=>c.tool==='terminal_read').some(c=>JSON.stringify(c.result).includes(text.trim())),'Codex receives actual echo through its own MCP read');
  assert.ok(!calls.some(c=>c.error),'no Codex MCP call error');
  await writeFile('artifacts/P16-codex-shared-session.json',JSON.stringify({result:'PASS',codexVersion,client:model?'installed Codex CLI and real model turn':'installed Codex app-server explicit MCP client; NO MODEL TURN',connection:ref,grantId,ticketId:signed.data.summary.ticket_id,request_id,stdioPid:pending.peer?.pid,tools:calls.map(c=>c.tool),wire,desktopEcho:true,agentDispatch:true,scope:'local synthetic SSH only; Codex model writes/desktop GUI/serial/hardware/full-v1 not validated by explicit client calls',configuration:'process-only isolated config, ephemeral, read-only; shell/apps/plugins/multi_agent/web disabled'},null,2)+'\n');
  console.log(`PASS installed Codex ${model?'model':'explicit app-server client (NO MODEL TURN)'} → real stdio → native Agent proxy → existing Desktop SSH actor: exact once-only bytes, original receipt, actual MCP read/desktop echo and Agent audit; local synthetic fixture only`);
} catch(error){
  console.error(model?stderr:rpc?.stderr??'');throw error;
} finally {
  await writeFile(model?'artifacts/P16-codex-events.jsonl':'artifacts/P16-codex-client-calls.json',model?events.map(e=>JSON.stringify(e)).join('\n')+'\n':JSON.stringify(directCalls,null,2)+'\n');
  clearTimeout(watchdog);if(rpc)await rpc.close();if(codex&&codex.exitCode===null&&codex.signalCode===null){codex.kill();await completion;}
  await ui?.close();fixture?.kill();if(fixture&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(resolve=>fixture.once('exit',resolve));
  if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-codex-ui-中文-'));await rm(target,{recursive:true,force:true});}
}
