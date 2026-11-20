import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { processRpc } from '../jsonrpc-client.mjs';
import { delay } from './DesktopHarness.mjs';

// Official explicit client calls. No model turn or automated approval callback.
export async function openCodexMcpClient({ directory, info, broker, catalog, observations }) {
  const home=path.join(directory,'codex-client');
  await mkdir(home,{recursive:true});
  const overrides=[
    `mcp_servers.windows_terminal.command=${JSON.stringify(info.executable)}`,
    `mcp_servers.windows_terminal.args=${JSON.stringify(['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)])}`,
    'mcp_servers.windows_terminal.startup_timeout_sec=15','mcp_servers.windows_terminal.tool_timeout_sec=45','web_search="disabled"',
  ];
  const rpc=processRpc('codex',['app-server','--stdio',
    ...['shell_tool','unified_exec','apps','plugins','multi_agent'].flatMap(name=>['--disable',name]),
    ...overrides.flatMap(value=>['-c',value])],{env:{...process.env,CODEX_HOME:home}});
  try {
    assert.ok((await rpc.request('initialize',{clientInfo:{name:'p16_catalog_matrix',version:'1'},capabilities:{experimentalApi:true}})).result);
    rpc.notify('initialized',{});
    const started=await rpc.request('thread/start',{cwd:directory,ephemeral:true,sandbox:'read-only',approvalPolicy:'never'},30000);
    const thread=started.result?.thread;
    assert.ok(thread?.ephemeral,JSON.stringify(started.error));
    const threadId=thread.id;
    const inventory=await rpc.request('mcpServerStatus/list',{threadId,serverName:'windows_terminal'},30000);
    const server=inventory.result?.data.find(item=>item.name==='windows_terminal');
    assert.ok(server,JSON.stringify(inventory.error));
    assert.equal(inventory.result.nextCursor,null);
    assert.deepEqual(Object.keys(server.tools).sort(),catalog.map(tool=>tool.name).sort());
    const tools=catalog.map(expected=>{
      const {name,description,inputSchema,annotations}=server.tools[expected.name];
      return {name,description,inputSchema,annotations};
    });
    assert.deepEqual(tools,catalog);
    let peer;
    for(let attempt=0;attempt<100;attempt++){
      peer=(await broker({op:'info'})).peer;
      if(peer?.pid)break;
      await delay(30);
    }
    assert.ok(Number.isSafeInteger(peer?.pid));
    const child=JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId=${peer.pid}' | Select-Object ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`],
      {encoding:'utf8',windowsHide:true}));
    assert.equal(child.ParentProcessId,rpc.child.pid);
    assert.equal(path.resolve(child.ExecutablePath).toLowerCase(),path.resolve(info.executable).toLowerCase());
    const pendingObservations=new Map();
    function checkReply(response){
      assert.ok(response.result,JSON.stringify(response.error));
      const result=response.result;
      const structuredContent=result.structuredContent??result.structured_content;
      assert.equal(structuredContent?.mock,false);
      for(const item of result.content)assert.deepEqual(JSON.parse(item.text),structuredContent);
      const isError=(result.isError??result.is_error)===true;
      return {...result,isError,structuredContent};
    }
    const outcome=result=>result.isError?result.structuredContent.error_code:'OK';
    function begin(method,params,timeout=30000){
      assert.equal(method,'tools/call');
      const entry={tool:params.name};
      observations.push(entry);
      const pending=rpc.begin('mcpServer/tool/call',{threadId,server:'windows_terminal',tool:params.name,arguments:params.arguments},timeout);
      pendingObservations.set(pending.id,entry);
      return {id:pending.id,promise:pending.promise.then(response=>{
        const result=checkReply(response);
        entry.outcome=outcome(result);
        return {result};
      },error=>{entry.outcome='CLIENT_NO_REPLY';throw error;}).finally(()=>pendingObservations.delete(pending.id))};
    }
    return {
      child:{pid:peer.pid},tools,get stderr(){return rpc.stderr;},
      begin,
      discardResponse(id){
        const entry=pendingObservations.get(id);
        assert.ok(entry,'only send a loss injection for an in-flight call');
        rpc.discardResponse(id,response=>{
          entry.appServerReplyBeforeInjectedLoss=outcome(checkReply(response));
        });
      },
      get discardedResponses(){return rpc.discardedResponses;},
      request(method,params){
        return begin(method,params).promise;
      },
      async close(){
        const outcome=await rpc.close();
        for(let attempt=0;attempt<50;attempt++){
          try{process.kill(peer.pid,0);}catch(error){if(error.code==='ESRCH')return outcome;throw error;}
          await delay(30);
        }
        throw new Error('Owned Codex stdio bridge did not exit');
      },
    };
  }catch(error){await rpc.close();throw error;}
}
