import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
import { processRpc } from './jsonrpc-client.mjs';
import { prepareSecuritySentinels, checkMcpSecurity } from './lib/McpSecurityChecks.mjs';
import {checkMcpExec} from './lib/McpExecChecks.mjs';
import {checkMcpConnect} from './lib/McpConnectChecks.mjs';
import {checkMcpReconnect} from './lib/McpReconnectChecks.mjs';
import {checkMcpForget} from './lib/McpForgetChecks.mjs';
import {checkMcpDisconnect} from './lib/McpDisconnectChecks.mjs';
import {checkMcpSerial} from './lib/McpSerialChecks.mjs';

const serialControl=process.argv.includes('--serial-control');
const disconnect=process.argv.includes('--disconnect');
const forget=process.argv.includes('--forget');
const reconnect=process.argv.includes('--reconnect');
const connect=process.argv.includes('--connect');
const serial=process.argv.includes('--serial')||serialControl;
const countedSerial=serialControl||((disconnect||forget)&&serial);
const security=process.argv.includes('--security');
const exec=process.argv.includes('--exec');
const evidence=connect?'P15-connect-v7':reconnect?'P15-connect-impact-reconnect-v7':forget?'P15-connect-impact-forget-v7':disconnect?'P15-connect-impact-disconnect-v7':serialControl?'P15-connect-impact-serial-v7':security?'P22-security-v7':exec?'P15-connect-impact-exec-v7':'P15-mcp-v7';
assert.ok(!(exec||reconnect||connect)||!serial,'exec, reconnect and connect fixtures are SSH2 only');
const rootPrefix=countedSerial?'shared-terminal-mcp-serial-control-中文-':security?'shared-terminal-security-ui-中文-':'shared-terminal-mcp-ui-中文-';
const build=fixture=>{const result=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});assert.equal(result.status,0,'memory fixture/ordinary restore must actually succeed');};
let directory,ui,fixture,rpc,failed=false;
try {
  if (serial&&!countedSerial) build(true);
  directory=await mkdtemp(path.join(tmpdir(),rootPrefix));
  ui=await launchDesktop(directory,{fixture:true,...(countedSerial?{executable:path.resolve('target/serial-mcp-fixture/shared-terminal-desktop.exe'),extraArgs:['--serial-mcp-fixture']}: {})});
  let connection,metrics,control,profileId,sshPin;
  if (serial) {
    const profile={id:randomUUID(),folder_id:null,name:'MCP合成串口',settings:{protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8'}};
    profileId=profile.id;
    await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'keep'}}});
    await ui.click('串口高级工具');await ui.click('刷新串口配置与设备');
    await ui.waitFor(`document.querySelector('[aria-label="串口配置"]').options.length===2&&document.querySelector('[aria-label="串口设备"]').options.length===2`);
    await ui.fill('串口配置',profile.id);await ui.fill('串口设备',await ui.evaluate(`document.querySelector('[aria-label="串口设备"]').options[1].value`));
    await ui.evaluate(`document.querySelector('[aria-label="确认串口设备与控制线"]').click()`);
    await ui.click('打开串口');await ui.waitFor(`document.querySelector('[aria-label="串口状态"]')?.textContent.startsWith('CONNECTED')`);
    connection=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL');
  } else {
    fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
    const next=async()=>{let timer;try {return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
    const server=await next();sshPin=server.pin;control=async value=>{fixture.stdin.write(JSON.stringify(value)+'\n');return next();};metrics=()=>control({op:'metrics'});
    const profile={id:randomUUID(),folder_id:null,name:'MCP合成SSH',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
    profileId=profile.id;
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
  const otherRef={connection_id:other.connection_id,generation:other.generation};
  const sentinels=security?await prepareSecuritySentinels({directory,ui,other:otherRef,ref,serial}):null;
  const management=request=>ui.invoke('agent_management_request',{request});
  const broker=request=>ui.invoke('bridge_management_request',{request});
  const info=await broker({op:'info'});
  const grantId=randomUUID();
  const baseGrant={request_id:grantId,scopes:['READ','WRITE',...(exec?['EXEC']:[]),...(serialControl?['CONTROL']:[])].map(action=>({target:{kind:'connection',connection:ref},action})),lifetime_ms:120000};
  const signed=await management(serial||security||exec?{...baseGrant,op:'grant_protected',form:{kind:'scoped'},redaction:{sensitive_fields:false,literals:['P15_PRIVATE',...(exec?['synthetic-secret']:[]),...(security?[sentinels.literal]:[])]}}:{...baseGrant,op:'grant'});
  assert.equal(JSON.stringify(signed).includes('token'),false);
  rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
  const initialized=await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'p15-real-stdio',version:'0.1.0'}});assert.ok(initialized.result.capabilities.tools);rpc.notify('notifications/initialized',{});
  const catalog=(await rpc.request('tools/list',{})).result.tools;
  assert.deepEqual({version:7,tools:catalog},JSON.parse(await readFile('contracts/mcp/initial-tools.json','utf8')),'actual stdio tool schema matches the fixed v7 twenty-two-tool contract');
  await writeFile(`artifacts/${evidence}-tools-${serial?'serial':'ssh'}.json`,JSON.stringify({tools:catalog},null,2)+'\n');
  assert.equal(catalog.length,22);assert.equal(catalog.find(t=>t.name==='terminal_send').annotations.readOnlyHint,false);
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
  const text=security||exec?'MCP共享 P22_SAFE_PREFIX '+'.'.repeat(80)+' P15_PRIVATE\r\n':'MCP共享 P15_PRIVATE\r\n',request_id=randomUUID(),send={transport,connection:ref,request_id,text};
  assert.equal((await call('terminal_send',send)).structuredContent.error_code,'INPUT_BUSY','Write grant without lease cannot dispatch');
  const lease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;assert.ok(lease.lease_id);
  const before=metrics?(await metrics()).received.flat().length:0;
  await success('terminal_send',send);
  let desktopText='';for(let i=0;i<100;i++){desktopText=(await ui.invoke('service_read_text',{connection:ref,cursor:1})).events.map(e=>e.text).join('');if(desktopText.includes(text))break;await delay(30);}assert.ok(desktopText.includes(text),'the actual Desktop connection sees the MCP echo');
  await success('terminal_send',send);await delay(50);
  if(metrics)assert.equal(Buffer.from((await metrics()).received.flat().slice(before)).toString(),text,'same original write UUID does not duplicate actual wire bytes');
  const receipt=await success('terminal_input_status',{transport,connection:ref,request_id});assert.equal(receipt.data.request_id,request_id);
  const output=await success('terminal_read',{connection:ref,window:null,view:{kind:'info'}});assert.equal(output.result,serial||security||exec?'protected_context':'context');
  const through=output.data.context.through_cursor;
  const read=await success('terminal_read',{connection:ref,window:null,view:{kind:'text',cursor:1,through_cursor:through,max_bytes:65536}});
  const protectedText=read.data.page.events.map(e=>e.text).join('');assert.ok(protectedText.includes('MCP共享'));assert.equal(protectedText.includes('P15_PRIVATE'),!(serial||security||exec),'only the explicitly protected grant changes the Agent projection');
  await success('terminal_screen',{connection:ref,window:null,through_cursor:through});
  assert.equal((await call('terminal_send',{...send,request_id:randomUUID(),role:'desktop'})).isError,true);
  const securityChecks=security?await checkMcpSecurity({ui,call,success,catalog,ref,other:otherRef,transport,management,grantId,signed,lease,send,control,metrics,rpc,sentinels}):null;
  const rebind=async id=>{
    await rpc.close();assert.ok(!rpc.stderr.includes('synthetic-secret')&&!rpc.stderr.includes('P15_PRIVATE'));for(let i=0;i<100;i++){if((await broker({op:'info'})).peer===null)break;await delay(20);}
    rpc=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
    await rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'p15-exec-repair',version:'2'}});rpc.notify('notifications/initialized',{});
    await success('agent_status');await ui.fill('Agent签发编号',id);await ui.click('查询原Agent编号');await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
    await ui.click('刷新MCP连接状态');await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='预览MCP绑定原授权'&&!b.disabled)&&document.body.textContent.includes(${JSON.stringify('实际进程 PID '+rpc.child.pid)})`);await ui.click('预览MCP绑定原授权');await ui.waitFor(`!!document.querySelector('[aria-label="MCP固定配对预览"]')`);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').checked`),false);await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').click()`);await ui.click('确认MCP绑定');
    for(let i=0;i<100;i++){if((await success('agent_status')).data.paired_ticket)return;await delay(20);}throw new Error('rebind did not complete');
  };
  const execChecks=exec?await checkMcpExec({ui,call,success,ref,other:otherRef,management,grantId,signed,lease,metrics,rebind,getRpc:()=>rpc,evidencePrefix:evidence}):null;
  const serialChecks=serialControl?await checkMcpSerial({directory,ui,call,success,ref,other:otherRef,management,grantId,signed,lease,rebind,getRpc:()=>rpc,evidence}):null;
  if(disconnect||forget||reconnect||connect){
    const common={directory,ui,call,success,ref,other:otherRef,transport,management,grantId,lease,control,rebind,getRpc:()=>rpc};
    const report=connect
      ?await checkMcpConnect(common)
      :reconnect?await checkMcpReconnect({...common,profileId,sshPin,originalInput:send})
      :forget?await checkMcpForget({...common,profileId,sshPin})
      :await checkMcpDisconnect(common);
    assert.equal((await rpc.close()).code,0);rpc=undefined;
    await writeFile(`artifacts/${evidence}-${serial?'serial':'ssh'}.json`,JSON.stringify({...report,stdio_exit:0},null,2)+'\n');
    console.log(`PASS real MCP ${transport} ${connect?'Connect':reconnect?'Reconnect':forget?'Forget':'Disconnect'}, original receipt, permission boundaries and transport cleanup`);
  }else{
    await management({op:'takeover',connection:ref});assert.equal((await call('terminal_send',{...send,request_id:randomUUID(),text:'MUST_NOT_SEND'})).isError,true);
    await securityChecks?.afterTakeover();
    await execChecks?.afterTakeover();
    await serialChecks?.afterTakeover();
    await success('terminal_input_status',{transport,connection:ref,request_id});
    await management({op:'grant_revoke',request_id:grantId});assert.equal((await call('terminal_read',{connection:ref,window:null,view:{kind:'info'}})).isError,true);
    const securityReport=await securityChecks?.afterRevoke();
    await execChecks?.afterRevoke();
    await serialChecks?.afterRevoke();
    const audit=await management({op:'audit',cursor:0,limit:128});assert.ok(audit.data.events.some(e=>e.kind==='DISPATCHED'&&e.client_id===signed.data.summary.ticket_id&&e.request_id===request_id));
    const ownedService=(await ui.invoke('service_status')).pid;process.kill(ownedService);
    assert.equal((await call('terminal_input_status',{transport,connection:ref,request_id})).structuredContent.error_code,'UNKNOWN_DELIVERY','actual service loss invalidates the bridge stream, without replay or a fabricated known result');
    await execChecks?.afterServiceLoss();
    await serialChecks?.afterServiceLoss();
    assert.ok(!rpc.stderr.includes('P15_PRIVATE'));assert.equal((await rpc.close()).code,0);rpc=undefined;
    if(security)await writeFile(`artifacts/P22-security-v7-${serial?'serial':'ssh'}.json`,JSON.stringify({...securityReport,service_loss:'UNKNOWN_DELIVERY',stdio_exit:0},null,2)+'\n');
    console.log(`PASS real MCP ${transport}: native fixed-process/original-grant GUI approval, default-none, no unpaired access/bearer, same shared connection exact send/receipt/protected read/screen, lease and dedup, unrelated session denied, takeover/revoke rejected, Agent source audit and stdio EOF cleanup; synthetic only`);
  }
} catch(error) {
  failed=true;console.error('MCP deterministic test failed before cleanup:',error);
  if((exec||countedSerial||disconnect||forget||reconnect||connect)&&ui)await ui.screenshot(`${evidence}-${serial?'serial':'ssh'}-failure.png`).catch(()=>{});
  if(directory)console.error('Owned failed MCP root retained:',directory);throw error;
} finally {
  try {if(rpc)await rpc.close();await ui?.close();fixture?.kill();if(fixture)await new Promise(resolve=>{if(fixture.exitCode!==null||fixture.signalCode!==null)resolve();else fixture.once('exit',resolve);});if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith(rootPrefix));if(!failed)await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
  finally {if(serial&&!countedSerial)build(false);}
}
