import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
import { processRpc } from './jsonrpc-client.mjs';

const serial=process.argv.includes('--serial');
const build=fixture=>{const result=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});assert.equal(result.status,0,'memory fixture/ordinary restore must actually succeed');};
let directory,ui,fixture,rpc;
try {
  if (serial) build(true);
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-mcp-ui-中文-'));
  ui=await launchDesktop(directory,{fixture:true});
  let connection,metrics;
  if (serial) {
    const profile={id:randomUUID(),folder_id:null,name:'MCP合成串口',settings:{protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8'}};
    await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'keep'}}});
    await ui.click('串口连接');await ui.click('刷新串口配置与设备');
    await ui.waitFor(`document.querySelector('[aria-label="串口配置"]').options.length===2&&document.querySelector('[aria-label="串口设备"]').options.length===2`);
    await ui.fill('串口配置',profile.id);await ui.fill('串口设备',await ui.evaluate(`document.querySelector('[aria-label="串口设备"]').options[1].value`));
    await ui.evaluate(`document.querySelector('[aria-label="确认串口设备与控制线"]').click()`);
    await ui.click('打开串口');await ui.waitFor(`document.querySelector('[aria-label="串口状态"]')?.textContent.startsWith('CONNECTED')`);
    connection=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL');
  } else {
    fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
    const next=async()=>{let timer;try {return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
    const server=await next();metrics=async()=>{fixture.stdin.write(JSON.stringify({op:'metrics'})+'\n');return next();};
    const profile={id:randomUUID(),folder_id:null,name:'MCP合成SSH',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
    await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
    await ui.click('SSH2 连接');await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length===2`);await ui.fill('SSH2 配置',profile.id);await ui.click('建立 SSH2 连接');
    await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='拒绝 SSH2 主机')`);
    assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`),server.pin);
    await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);await ui.click('信任本次 SSH2 主机');
    await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='使用保存的 SSH2 凭据')`);await ui.click('使用保存的 SSH2 凭据');
    await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith('CONNECTED')`);
    connection=(await ui.invoke('service_list')).find(c=>c.protocol==='SSH2');
  }
  const ref={connection_id:connection.connection_id,generation:connection.generation},transport=serial?'SERIAL':'SSH2';
  const other=await ui.invoke('fixture_create');
  const management=request=>ui.invoke('agent_management_request',{request});
  const broker=request=>ui.invoke('bridge_management_request',{request});
  const info=await broker({op:'info'});
  const grantId=randomUUID();
  const baseGrant={request_id:grantId,scopes:['READ','WRITE'].map(action=>({target:{kind:'connection',connection:ref},action})),lifetime_ms:120000};
  const signed=await management(serial?{...baseGrant,op:'grant_protected',form:{kind:'scoped'},redaction:{sensitive_fields:false,literals:['P15_PRIVATE']}}:{...baseGrant,op:'grant'});
  assert.equal(JSON.stringify(signed).includes('token'),false);
  rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
  const initialized=await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'p15-real-stdio',version:'0.1.0'}});assert.ok(initialized.result.capabilities.tools);rpc.notify('notifications/initialized',{});
  const catalog=(await rpc.request('tools/list',{})).result.tools;
  assert.deepEqual({tools:catalog},JSON.parse(await readFile('contracts/mcp/initial-tools.json','utf8')),'actual stdio tool schema matches the versioned initial contract');
  await writeFile(`artifacts/P15-mcp-tools-${serial?'serial':'ssh'}.json`,JSON.stringify({tools:catalog},null,2)+'\n');
  assert.equal(catalog.length,9);assert.equal(catalog.find(t=>t.name==='terminal_send').annotations.readOnlyHint,false);
  const call=async(name,args={})=>(await rpc.request('tools/call',{name,arguments:args})).result;
  const success=async(name,args={})=>{const result=await call(name,args);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.structuredContent.mock,false);return result.structuredContent.reply;};
  const pending=await success('agent_status');assert.equal(pending.data.paired_ticket,null);assert.equal(pending.data.peer_pid,rpc.child.pid);
  assert.equal((await call('sessions_list')).structuredContent.error_code,'PERMISSION_DENIED','no pairing means no service access');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(o=>o.value===${JSON.stringify(ref.connection_id)})`);await ui.fill('会话',ref.connection_id);await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="Agent签发编号"]')`);await ui.fill('Agent签发编号',grantId);await ui.click('查询原Agent编号');await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(x=>x.textContent==='MCP 初版连接').click()`);
  await ui.click('刷新MCP连接状态');await ui.waitFor(`!!document.querySelector('[aria-label="MCP本次启动参数"]')`);
  await ui.click('预览MCP绑定原授权');await ui.waitFor(`!!document.querySelector('[aria-label="MCP固定配对预览"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').checked`),false);
  const previewText=await ui.evaluate(`document.querySelector('[aria-label="MCP固定配对预览"]').textContent`);assert.ok(previewText.includes(String(rpc.child.pid)));assert.ok(previewText.includes(grantId));assert.ok(!previewText.includes('P15_PRIVATE'));
  await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').click()`);await ui.click('确认MCP绑定');await ui.waitFor(`document.querySelector('[aria-label="MCP配对状态"]').textContent.includes('已绑定独立Agent身份')`);
  let paired;for(let i=0;i<100;i++){paired=await success('agent_status');if(paired.data.paired_ticket)break;await delay(20);}assert.equal(paired.data.paired_ticket,signed.data.summary.ticket_id);
  const visible=await success('sessions_list');assert.deepEqual(visible.data.map(c=>c.connection_id),[ref.connection_id]);
  assert.equal((await call('terminal_read',{connection:{connection_id:other.connection_id,generation:other.generation},window:null,view:{kind:'info'}})).isError,true);
  const text='MCP共享 P15_PRIVATE\r\n',request_id=randomUUID(),send={transport,connection:ref,request_id,text};
  assert.equal((await call('terminal_send',send)).structuredContent.error_code,'INPUT_BUSY','Write grant without lease cannot dispatch');
  const lease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;assert.ok(lease.lease_id);
  const before=metrics?(await metrics()).received.flat().length:0;
  await success('terminal_send',send);
  let desktopText='';for(let i=0;i<100;i++){desktopText=(await ui.invoke('service_read_text',{connection:ref,cursor:1})).events.map(e=>e.text).join('');if(desktopText.includes(text))break;await delay(30);}assert.ok(desktopText.includes(text),'the actual Desktop connection sees the MCP echo');
  await success('terminal_send',send);await delay(50);
  if(metrics)assert.equal(Buffer.from((await metrics()).received.flat().slice(before)).toString(),text,'same original write UUID does not duplicate actual wire bytes');
  const receipt=await success('terminal_input_status',{transport,connection:ref,request_id});assert.equal(receipt.data.request_id,request_id);
  const output=await success('terminal_read',{connection:ref,window:null,view:{kind:'info'}});assert.equal(output.result,serial?'protected_context':'context');
  const through=output.data.context.through_cursor;
  const read=await success('terminal_read',{connection:ref,window:null,view:{kind:'text',cursor:1,through_cursor:through,max_bytes:65536}});
  const protectedText=read.data.page.events.map(e=>e.text).join('');assert.ok(protectedText.includes('MCP共享'));assert.equal(protectedText.includes('P15_PRIVATE'),!serial,'only the explicitly protected grant changes the Agent projection');
  await success('terminal_screen',{connection:ref,window:null,through_cursor:through});
  assert.equal((await call('terminal_send',{...send,request_id:randomUUID(),role:'desktop'})).isError,true);
  await management({op:'takeover',connection:ref});assert.equal((await call('terminal_send',{...send,request_id:randomUUID(),text:'MUST_NOT_SEND'})).isError,true);
  await success('terminal_input_status',{transport,connection:ref,request_id});
  await management({op:'grant_revoke',request_id:grantId});assert.equal((await call('terminal_read',{connection:ref,window:null,view:{kind:'info'}})).isError,true);
  const audit=await management({op:'audit',cursor:0,limit:128});assert.ok(audit.data.events.some(e=>e.kind==='DISPATCHED'&&e.client_id===signed.data.summary.ticket_id&&e.request_id===request_id));
  const ownedService=(await ui.invoke('service_status')).pid;process.kill(ownedService);
  assert.equal((await call('terminal_input_status',{transport,connection:ref,request_id})).structuredContent.error_code,'UNKNOWN_DELIVERY','actual service loss invalidates the bridge stream, without replay or a fabricated known result');
  assert.ok(!rpc.stderr.includes('P15_PRIVATE'));assert.equal((await rpc.close()).code,0);rpc=undefined;
  console.log(`PASS real MCP ${transport}: native fixed-process/original-grant GUI approval, default-none, no unpaired access/bearer, same shared connection exact send/receipt/protected read/screen, lease and dedup, unrelated session denied, takeover/revoke rejected, Agent source audit and stdio EOF cleanup; synthetic only`);
} finally {
  try {if(rpc)await rpc.close();await ui?.close();fixture?.kill();if(fixture)await new Promise(resolve=>{if(fixture.exitCode!==null||fixture.signalCode!==null)resolve();else fixture.once('exit',resolve);});if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-mcp-ui-中文-'));await rm(target,{recursive:true,force:true});}}
  finally {if(serial)build(false);}
}
