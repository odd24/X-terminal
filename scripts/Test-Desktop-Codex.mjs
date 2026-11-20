import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
import { processRpc } from './jsonrpc-client.mjs';
import { approveCodexExport, checkCodexExport } from './lib/CodexProtectedExportCheck.mjs';
import { approveCodexExec, checkCodexExec } from './lib/CodexProtectedExecCheck.mjs';
import { assertReleasedMcpCatalog } from './lib/McpCatalog.mjs';

// Integration of the installed Codex model/client, not a delegated development task.
// No user config, shell, apps, plugins, web search, or persistent Codex chat.
const model=process.argv.includes('--model');
const protectedExport=process.argv.includes('--preview-v11-export');
const protectedExec=process.argv.includes('--preview-v11-exec');
assert.ok(!(protectedExport&&protectedExec),'choose one protected operation');
const latestPreview=protectedExport||protectedExec;
const previewV11=latestPreview||process.argv.includes('--preview-v11');
assert.ok(!(model&&previewV11),'preview verification only supports explicit client calls');
const evidence=protectedExec?'artifacts/P16-codex-v11-exec':protectedExport?'artifacts/P16-codex-v11-export':previewV11?'artifacts/P16-codex-v11':'artifacts/P16-codex';
let directory, ui, fixture, codex, watchdog, rpc, threadId;
let previewDirectory, discovered, previewEvidence, metrics;
const directCalls=[];
const events=[]; let stderr=''; let completion;
await mkdir('artifacts',{recursive:true});
try {
  if(previewV11){
    const readArtifact=async file=>JSON.parse(await readFile(path.join('artifacts',file),'utf8'));
    const pointer=await readArtifact(latestPreview?'P12-narrow-tree-space-preview.json':'P16-local-preview.json');
    previewDirectory=path.resolve(pointer.directory);
    assert.equal(path.dirname(previewDirectory),path.resolve('artifacts'));
    assert.match(path.basename(previewDirectory),/^shared-terminal-preview-[0-9a-f-]+$/);
    assert.equal(pointer.result,'PASS');
    if(!latestPreview){
      const receipt=await readArtifact('P15-protected-export-v11-preview-result.json');
      assert.equal(receipt.result,'PASS');
      assert.equal(path.resolve(receipt.preview),previewDirectory);
      assert.equal(receipt.mcp_catalog_version,11);assert.equal(receipt.mcp_tools,29);assert.equal(receipt.ordinary,true);
    }
    const manifest=JSON.parse(await readFile(path.join(previewDirectory,'manifest.json'),'utf8'));
    if(latestPreview){
      assert.equal(path.basename(previewDirectory),'shared-terminal-preview-ae0e4810-8d39-4d60-b7b2-d1340f060b42');
      assert.match(manifest.packagedFromHead,/^43b8952[0-9a-f]{33}$/);
    }
    assert.deepEqual(manifest.files,pointer.files);
    assert.deepEqual(manifest.files.map(file=>file.name),['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe']);
    for(const file of manifest.files){
      const bytes=await readFile(path.join(previewDirectory,file.name));
      assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    }
  }
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-codex-ui-中文-'));
  ui=await launchDesktop(directory,previewV11?{executable:path.join(previewDirectory,'shared-terminal-desktop.exe')}:{fixture:true});
  const ordinary=previewV11?await ui.invoke('service_status'):undefined;
  if(previewV11)assert.equal(ordinary.fixture,false);
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
  const next=async()=>{let timer;try{return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
  const server=await next();
  const control=async request=>{fixture.stdin.write(JSON.stringify(request)+'\n');return next();};
  metrics=()=>control({op:'metrics'});
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
  const openAgent=async()=>{
    await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(ref.connection_id)})`);
    await ui.fill('会话',ref.connection_id);
    await ui.click('Agent 授权');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent签发编号"]')`);
  };
  const info=await broker({op:'info'}),request_id=randomUUID();
  if(previewV11)assert.equal(path.resolve(info.executable),path.join(previewDirectory,'terminal-mcp.exe'));
  const secret='P16_SYNTHETIC_REDACTION_MARKER';
  let grantId, signed, exportTarget, execTarget;
  if(protectedExec){
    ({target:execTarget,grantId,signed}=await approveCodexExec({ui,openAgent,ref,management}));
  }else if(protectedExport){
    exportTarget=await approveCodexExport({ui,openAgent,ref,serviceId:ordinary.service_id,control});
    grantId=await ui.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`);
    signed=await management({op:'grant_status',request_id:grantId});
    assert.deepEqual(signed.data.approved_scopes,[{target:{kind:'connection',connection:ref},action:'EXPORT'}]);
    assert.equal(signed.data.protection.literal_count,1);
  }else if(previewV11){
    await openAgent();
    await ui.evaluate(`document.querySelector('[aria-label="授权读取终端"]').click()`);
    await ui.evaluate(`document.querySelector('[aria-label="启用Agent输出保护"]').click()`);
    await ui.click('添加精确文本规则');
    await ui.fill('Agent精确文本规则1',secret);
    await ui.click('预览Agent授权');
    await ui.waitFor(`!!document.querySelector('[aria-label="同意本次Agent范围"]')`);
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').checked`),false);
    const scopePreview=await ui.evaluate(`document.querySelector('[aria-label="Agent授权预览"]').textContent`);
    assert.ok(scopePreview.includes(ref.connection_id)&&scopePreview.includes(`代次 ${ref.generation}`));
    await ui.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').click()`);
    await ui.click('确认批准Agent');
    await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
    grantId=await ui.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`);
    signed=await management({op:'grant_status',request_id:grantId});
    assert.deepEqual(signed.data.approved_scopes,[{target:{kind:'connection',connection:ref},action:'READ'}]);
    assert.equal(signed.data.protection.literal_count,1);
  }else{
    grantId=randomUUID();
    signed=await management({op:'grant',request_id:grantId,scopes:['READ','WRITE'].map(action=>({target:{kind:'connection',connection:ref},action})),lifetime_ms:300000});
  }
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
    const thread=await rpc.request('thread/start',{cwd:directory,ephemeral:true,sandbox:'read-only',...(previewV11?{approvalPolicy:'never'}:{})},30000);assert.ok(thread.result?.thread?.id,JSON.stringify(thread.error));threadId=thread.result.thread.id;
    if(previewV11)assert.equal(thread.result.thread.ephemeral,true);
    const inventory=await rpc.request('mcpServerStatus/list',{threadId,serverName:'windows_terminal'},30000);
    const catalog = JSON.parse(await readFile('contracts/mcp/initial-tools.json', 'utf8'));
    assert.ok(inventory.result,JSON.stringify(inventory.error));
    const server=inventory.result.data.find(s=>s.name==='windows_terminal');
    assert.ok(server,'official client must discover the preview MCP server');
    if(previewV11){
      assert.equal(catalog.version,11);assert.equal(catalog.tools.length,29);
      assert.equal(inventory.result.nextCursor,null);
      discovered=Object.keys(server.tools).sort();
      assert.deepEqual(discovered,catalog.tools.map(tool=>tool.name).sort());
      const observed=catalog.tools.map(tool=>{
        const actual=server.tools[tool.name];
        const {name,description,inputSchema,annotations}=actual;
        return {name,description,inputSchema,annotations};
      });
      assertReleasedMcpCatalog(observed,catalog.tools,'preview must advertise a released v11 catalog');
    }else assert.equal(Object.keys(server.tools).length,catalog.tools.length);
  }
  let pending;
  for(let i=0;i<200;i++){pending=await broker({op:'info'});if(pending.peer?.pid)break;if(codex.exitCode!==null||codex.signalCode!==null)throw new Error(`Codex exited before pairing: ${JSON.stringify(await completion)} ${stderr}`);await delay(100);}
  assert.ok(pending.peer?.pid,'Codex must launch the actual stdio executable');
  if(latestPreview){
    assert.ok(Number.isSafeInteger(pending.peer.pid)&&pending.peer.pid>0);
    const child=JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-CimInstance Win32_Process -Filter 'ProcessId=${pending.peer.pid}' | Select-Object ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`],
    {encoding:'utf8',windowsHide:true}));
    assert.equal(child.ParentProcessId,codex.pid);
    assert.equal(path.resolve(child.ExecutablePath).toLowerCase(),path.resolve(info.executable).toLowerCase());
  }
  if(!previewV11){
    await openAgent();
    await ui.fill('Agent签发编号',grantId);await ui.click('查询原Agent编号');
    await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  }
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(x=>x.textContent==='MCP 初版连接').click()`);
  await ui.click('刷新MCP连接状态');await ui.waitFor(`!!document.querySelector('[aria-label="MCP本次启动参数"]')`);
  await ui.click('预览MCP绑定原授权');await ui.waitFor(`!!document.querySelector('[aria-label="MCP固定配对预览"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').checked`),false);
  const preview=await ui.evaluate(`document.querySelector('[aria-label="MCP固定配对预览"]').textContent`);assert.ok(preview.includes(String(pending.peer?.pid)));assert.ok(preview.includes(grantId));
  await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').click()`);await ui.click('确认MCP绑定');await ui.waitFor(`document.querySelector('[aria-label="MCP配对状态"]').textContent.includes('已绑定独立Agent身份')`);
  if(!model){
    // Explicit app-server client calls, not a model turn or approval bypass.
    // processRpc still rejects all approval/callback requests from the child.
    const call=async(tool,args={},expectedError)=>{
      if(protectedExec)assert.ok(['agent_status','input_lease','input_acquire','ssh_exec','tasks_get','input_release'].includes(tool));
      else if(protectedExport)assert.ok(['agent_status','logs_export','logs_export_status','terminal_read','input_acquire'].includes(tool));
      else if(previewV11)assert.ok(['agent_status','sessions_list','terminal_read','terminal_wait'].includes(tool));
      const response=await rpc.request('mcpServer/tool/call',{threadId,server:'windows_terminal',tool,arguments:args},30000);
      if(protectedExec&&response.error)directCalls.push({server:'windows_terminal',tool,arguments:args,error:response.error});
      assert.ok(response.result,JSON.stringify(response.error));
      const result=response.result;
      directCalls.push({server:'windows_terminal',tool,arguments:args,result});
      assert.equal((result.isError??result.is_error)===true,!!expectedError,JSON.stringify(result));
      const value=result.structuredContent??result.structured_content??JSON.parse(result.content.find(c=>c.type==='text').text);
      assert.equal(value.mock,false);
      if(latestPreview){
        assert.deepEqual(Object.keys(value).sort(),expectedError?['error_code','mock']:['mock','reply']);
        for(const content of result.content){
          assert.equal(content.type,'text');
          assert.deepEqual(JSON.parse(content.text),value);
        }
      }
      if(expectedError){assert.equal(value.error_code,expectedError);return;}
      assert.ok(value.reply,JSON.stringify(value));
      return value.reply;
    };
    let exportEvidence, execEvidence;
    if(protectedExec){
      execEvidence=await checkCodexExec({call,target:execTarget,signed,metrics});
      assert.equal(directCalls.filter(call=>call.tool==='ssh_exec').length,1);
    }else if(protectedExport){
      exportEvidence=await checkCodexExport({call,directory,target:exportTarget,signed});
      assert.equal(directCalls.filter(call=>call.tool==='logs_export').length,1);
    }else{
    const status=(await call('agent_status')).data;
    assert.equal(status.paired_ticket,signed.data.summary.ticket_id);
    if(previewV11){
      assert.deepEqual(status.approved_scopes,[{target:{kind:'connection',connection:ref},action:'READ'}]);
      assert.deepEqual(status.protection,signed.data.protection);
    }
    assert.deepEqual((await call('sessions_list')).data.map(({connection_id,generation})=>({connection_id,generation})),[ref]);
    }
    if(previewV11){
      if(!latestPreview){
      const readArgs={connection:ref,window:null};
      const before=(await call('terminal_read',{...readArgs,view:{kind:'info'}})).data.context;
      assert.deepEqual(before.connection,ref);
      const pattern=`P16_WAIT.*[终]_${randomUUID()}`;
      const pendingWait=call('terminal_wait',{connection:ref,cursor:before.through_cursor,pattern,timeout_ms:5000});
      pendingWait.catch(()=>{});
      await control({op:'push',text:`${pattern} ${secret}\r\n`});
      const waited=await pendingWait;
      assert.equal(waited.result,'wait');assert.equal(waited.data.state,'MATCHED');
      assert.equal(waited.data.evidence.text,pattern);
      assert.ok(waited.data.evidence.first_cursor>=before.through_cursor);
      assert.ok(waited.data.evidence.last_cursor>=waited.data.evidence.first_cursor);
      const after=(await call('terminal_read',{...readArgs,view:{kind:'info'}})).data.context;
      assert.deepEqual(after.connection,ref);assert.equal(after.through_cursor,waited.data.next_cursor);
      const read=await call('terminal_read',{...readArgs,view:{kind:'text',cursor:before.through_cursor,through_cursor:after.through_cursor,max_bytes:16384}});
      assert.equal(read.result,'protected_context');assert.deepEqual(read.data.page.connection,ref);
      assert.equal(read.data.page.next_cursor,after.through_cursor);
      const projection=read.data.page.events.map(event=>event.text).join('');
      assert.ok(projection.includes(pattern));assert.ok(!projection.includes(secret));
      const desktopText=(await ui.invoke('service_read_text',{connection:ref,cursor:1})).events.map(event=>event.text).join('');
      assert.ok(desktopText.includes(pattern)&&desktopText.includes(secret));
      }
      assert.equal((await metrics()).received.flat().length,0);
      assert.equal((await rpc.close()).code,0);rpc=undefined;
      await ui.click('关闭Agent授权');
      await ui.evaluate(`(()=>{const menu=document.querySelector('details.tools-menu');if(!menu.open)menu.querySelector('summary').click();return menu.open;})()`);
      await ui.click('退出桌面');
      if(!protectedExport){
        await ui.waitFor(`!!document.querySelector('[aria-label="退出桌面确认"]')`);
        await ui.evaluate(`setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认退出并停止服务').click(),50);true`);
      }
      for(let i=0;i<160&&ui.app.exitCode===null;i++)await delay(50);
      assert.equal(ui.app.exitCode,0);await ui.close();ui=undefined;
      const receipt=JSON.parse(await readFile(path.join(directory,'desktop-close-receipts-v1',`${ordinary.service_id}.json`),'utf8'));
      assert.equal(receipt.service_id,ordinary.service_id);assert.equal(receipt.owned_pid,ordinary.pid);
      assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');assert.equal(receipt.exited,true);
      assert.equal(receipt.exit_code,0);assert.equal(receipt.kill_requested,false);
      assert.equal(receipt.reader.diagnostic.outcome,'CLOSED');
      assert.equal(receipt.reader.diagnostic.accepted,receipt.reader.diagnostic.synced);
      const bridgeAlive=()=>{try{process.kill(pending.peer.pid,0);return true;}catch(error){if(error.code!=='ESRCH')throw error;return false;}};
      for(let i=0;i<40&&bridgeAlive();i++)await delay(50);
      assert.equal(bridgeAlive(),false,'owned stdio bridge must exit');
      previewEvidence={result:'PASS',codexVersion,preview:previewDirectory,catalogVersion:11,discovered,connection:ref,
        grantId,ticketId:signed.data.summary.ticket_id,stdioPid:pending.peer.pid,explicitCalls:directCalls.map(call=>call.tool),
        desktopScopeConfirmed:true,desktopPairingConfirmed:true,
        ...(protectedExec?{exec:execEvidence,stdioParentPid:codex.pid}
          :protectedExport?{export:exportEvidence,stdioParentPid:codex.pid}:{protectedRead:true,literalMatch:true}),
        fixtureInputBytes:0,codexExit:0,stdioExited:true,receipt};
    }else{
    const lease=(await call('input_acquire',{connection:ref,lifetime_ms:60000})).data;
    await call('terminal_send',{transport:'SSH2',connection:ref,request_id,text});
    assert.equal((await call('terminal_input_status',{transport:'SSH2',connection:ref,request_id})).data.request_id,request_id);
    let through;for(let i=0;i<100;i++){through=(await call('terminal_read',{connection:ref,window:null,view:{kind:'info'}})).data.context.through_cursor;if(through>1)break;await delay(30);}
    const read=await call('terminal_read',{connection:ref,window:null,view:{kind:'text',cursor:1,through_cursor:through,max_bytes:65536}});assert.ok(read.data.page.events.map(e=>e.text).join('').includes(text));
    await call('input_release',{connection:ref,lease_id:lease.lease_id});
    assert.equal((await rpc.close()).code,0);rpc=undefined;
    }
  }
  const exit=await completion;clearTimeout(watchdog);await delay(100);
  if(model)await writeFile('artifacts/P16-codex-events.jsonl',events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  assert.equal(exit.code,0,`Codex exit ${JSON.stringify(exit)} ${stderr}`);
  if(!previewV11){
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
  }
} catch(error){
  if(latestPreview){
    const observed=protectedExec?await metrics?.().catch(()=>undefined):undefined;
    await writeFile(`${evidence}-failure.json`,JSON.stringify({result:'FAIL',calls:directCalls.map(call=>call.tool),error:error.message,
      fixtureExecRequests:observed?.exec_calls.length,fixtureTerminalInputBytes:observed?.received.flat().length},null,2)+'\n');
  }
  console.error(model?stderr:rpc?.stderr??'');throw error;
} finally {
  await writeFile(model?'artifacts/P16-codex-events.jsonl':`${evidence}-client-calls.json`,model?events.map(e=>JSON.stringify(e)).join('\n')+'\n':JSON.stringify(directCalls,null,2)+'\n');
  clearTimeout(watchdog);if(rpc)await rpc.close();if(codex&&codex.exitCode===null&&codex.signalCode===null){codex.kill();await completion;}
  await ui?.close();fixture?.kill();if(fixture&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(resolve=>fixture.once('exit',resolve));
  if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-codex-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
}
if(previewV11){
  if(latestPreview)Object.assign(previewEvidence,{fixtureExited:true,rootReleased:true});
  await writeFile(`${evidence}-result.json`,JSON.stringify(previewEvidence,null,2)+'\n');
  console.log(protectedExec?'PASS official Codex app-server protected Single Exec on the original synthetic SSH generation.'
    :protectedExport?'PASS official Codex app-server protected export on the original ended synthetic SSH generation.'
    :'PASS official Codex app-server, ordinary v11 preview, 29 discovered, protected bounded read and literal wait on the shared synthetic SSH generation.');
}
