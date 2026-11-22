import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
import { processRpc } from './jsonrpc-client.mjs';
import { prepareSecuritySentinels, checkMcpSecurity } from './lib/McpSecurityChecks.mjs';
import {checkMcpExec} from './lib/McpExecChecks.mjs';
import {checkMcpWait} from './lib/McpWaitChecks.mjs';
import {checkProtectedExport} from './lib/McpProtectedExportChecks.mjs';
import {checkMcpSshResize} from './lib/McpSshResizeChecks.mjs';
import {checkMcpSerialConnect} from './lib/McpSerialConnectChecks.mjs';
import {checkMcpConnect} from './lib/McpConnectChecks.mjs';
import {checkMcpReconnect} from './lib/McpReconnectChecks.mjs';
import {checkMcpForget} from './lib/McpForgetChecks.mjs';
import {checkMcpDisconnect} from './lib/McpDisconnectChecks.mjs';
import {checkMcpSerial} from './lib/McpSerialChecks.mjs';
import {checkSshInterruption} from './lib/SshInterruptionChecks.mjs';
import {checkServiceInterruption} from './lib/ServiceInterruptionChecks.mjs';
import {checkSilentLink, openSilentLink} from './lib/SshSilentLink.mjs';
import {closeSoakDesktop} from './lib/LoadSoak.mjs';
import {openCodexMcpClient} from './lib/CodexMcpClient.mjs';
import {readMcpCatalog} from './lib/McpCatalog.mjs';

const official=process.argv.includes('--official-client');
const readBoundaries=process.argv.includes('--read-boundaries');
const readPackage=readBoundaries&&process.argv[4];
const serialControl=process.argv.includes('--serial-control');
const disconnect=process.argv.includes('--disconnect');
const forget=process.argv.includes('--forget');
const reconnect=process.argv.includes('--reconnect');
const connect=process.argv.includes('--connect');
const serialConnect=process.argv.includes('--serial-connect');
const sshResize=process.argv.includes('--ssh-resize');
const wait=process.argv.includes('--wait');
const protectedExport=process.argv.includes('--protected-export');
const interruption=process.argv.includes('--ssh-interruption');
const silentLink=process.argv.includes('--ssh-silent-link');
const serviceInterruption=process.argv.includes('--service-interruption');
const serial=process.argv.includes('--serial')||serialControl||serialConnect;
const countedSerial=serialConnect||serialControl||((disconnect||forget||protectedExport)&&serial);
const security=process.argv.includes('--security');
const exec=process.argv.includes('--exec');
const suite=silentLink?'P24-ssh-silent-link':serviceInterruption?'P24-service-interruption':interruption?'P24-ssh-interruption':protectedExport?'P15-protected-export-v11':wait?'P15-terminal-wait-v11':sshResize?'P15-wait-impact-resize-v11':serialConnect?'P15-wait-impact-serial-connect-v11':connect?'P15-wait-impact-connect-v11':reconnect?'P15-wait-impact-reconnect-v11':forget?'P15-wait-impact-forget-v11':disconnect?'P15-wait-impact-disconnect-v11':serialControl?'P15-wait-impact-serial-v11':security?'P22-security-v11':exec?'P15-wait-impact-exec-v11':'P15-mcp-v11';
const evidence=readPackage?'windows-x64-release-terminal-read':readBoundaries?'P16-terminal-read-metadata':official?'P16-official-'+suite:suite;
const observations=[];
assert.ok(!silentLink||process.argv.length===3,'P24 silent link is an independent case');
assert.ok(!readBoundaries||official&&!serial&&process.argv.length<6,'read boundaries require the standalone official SSH case');
assert.ok(!(exec||reconnect||connect||sshResize||wait||interruption||serviceInterruption)||!serial,'SSH2 fixture required');
assert.ok(!(interruption||serviceInterruption)||!(interruption&&serviceInterruption||exec||reconnect||connect||sshResize||wait||protectedExport||disconnect||forget||security),'P24 interruption is an independent case');
const rootPrefix=countedSerial?'shared-terminal-mcp-serial-control-中文-':security?'shared-terminal-security-ui-中文-':'shared-terminal-mcp-ui-中文-';
const build=fixture=>{const result=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});assert.equal(result.status,0,'memory fixture/ordinary restore must actually succeed');};
let directory,ui,fixture,rpc,link,interruptionReport,serviceInterruptionReport,silentLinkReport,failed=false;
async function startSshFixture(root, port) {
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[root,...(port?[String(port)]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const child=fixture;
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>{let timer;try{return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
  const server=await next();
  const control=async value=>{child.stdin.write(JSON.stringify(value)+'\n');return next();};
  return {server,control};
}
async function killSshFixture() {
  const child=fixture;
  assert.ok(child&&child.exitCode===null&&child.signalCode===null);
  const ended=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  assert.equal(child.kill(),true);
  const exit=await ended;
  assert.notEqual(exit.code,0);
  fixture=undefined;
  return {pid:child.pid,...exit};
}
try {
  if (serial&&!countedSerial) build(true);
  directory=await mkdtemp(path.join(tmpdir(),rootPrefix));
  const packageManifest=readPackage?JSON.parse(await readFile(readPackage,'utf8')):undefined;
  const preview=readPackage?{
    result:'PASS',directory:path.dirname(path.resolve(readPackage)),
    files:packageManifest.files.filter(file=>file.name.endsWith('.exe')),
  }:readBoundaries?JSON.parse(await readFile('artifacts/terminal-read-metadata-preview.json','utf8')):
    interruption||serviceInterruption||silentLink?JSON.parse(await readFile('artifacts/P24-save-recovery-preview.json','utf8')):undefined;
  if(preview){assert.equal(preview.result,'PASS');if(!readPackage)assert.equal(path.dirname(path.resolve(preview.directory)),path.resolve('artifacts'));}
  if(readBoundaries||serviceInterruption||silentLink){
    assert.deepEqual(preview.files.map(file=>file.name).sort(),['session-service.exe','shared-terminal-desktop.exe','terminal-mcp.exe']);
    for(const file of preview.files){
      const bytes=await readFile(path.join(preview.directory,file.name));
      assert.equal(bytes.length,file.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    }
  }
  ui=await launchDesktop(directory,preview?{executable:path.join(preview.directory,'shared-terminal-desktop.exe')}:{fixture:true,...(countedSerial?{executable:path.resolve('target/serial-mcp-fixture/shared-terminal-desktop.exe'),extraArgs:['--serial-mcp-fixture']}: {})});
  if(preview)assert.equal((await ui.invoke('service_status')).fixture,false);
  let connection,metrics,control,profileId,sshPin,sshPort;
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
    const started=await startSshFixture(directory);
    const server=started.server;sshPin=server.pin;sshPort=server.port;control=started.control;metrics=()=>control({op:'metrics'});
    if(silentLink)link=await openSilentLink(server.port);
    const profile={id:randomUUID(),folder_id:null,name:'MCP合成SSH',settings:{protocol:'ssh2',host:'127.0.0.1',port:link?.port??server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
    profileId=profile.id;
    await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
    await ui.click('SSH2 连接');await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length===2`);await ui.fill('SSH2 配置',profile.id);await ui.click('建立 SSH2 连接');
    await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='拒绝 SSH2 主机')`);
    assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`),server.pin);
    await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);await ui.click('信任本次 SSH2 主机');
    await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='使用保存的 SSH2 凭据')`);await ui.click('使用保存的 SSH2 凭据');
    await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.dataset.state==='CONNECTED'`);
    connection=(await ui.invoke('service_list')).find(c=>c.protocol==='SSH2');
  }
  const ref={connection_id:connection.connection_id,generation:connection.generation},transport=serial?'SERIAL':'SSH2';
  const other=preview?undefined:await ui.invoke('fixture_create');
  const otherRef=other&&{connection_id:other.connection_id,generation:other.generation};
  const sentinels=security?await prepareSecuritySentinels({directory,ui,other:otherRef,ref,serial}):null;
  const management=request=>ui.invoke('agent_management_request',{request});
  const broker=request=>ui.invoke('bridge_management_request',{request});
  const info=await broker({op:'info'});
  const grantId=randomUUID();
  const baseGrant={request_id:grantId,scopes:['READ','WRITE',...(exec?['EXEC']:[]),...(serialControl?['CONTROL']:[])].map(action=>({target:{kind:'connection',connection:ref},action})),lifetime_ms:silentLink?300000:120000};
  const protectedGrant=serial||security||exec||(official&&wait);
  const signed=await management(protectedGrant?{...baseGrant,op:'grant_protected',form:{kind:'scoped'},redaction:{sensitive_fields:false,literals:['P15_PRIVATE',...(exec?['synthetic-secret']:[]),...(security?[sentinels.literal]:[])]}}:{...baseGrant,op:'grant'});
  assert.equal(JSON.stringify(signed).includes('token'),false);
  const catalogVersion=packageManifest?.mcpCatalogVersion??(preview?11:12);
  const contract=await readMcpCatalog(catalogVersion);
  async function openClient(){
    if(official)return openCodexMcpClient({directory,info,broker,catalog:contract.tools,observations});
    const client=processRpc(info.executable,['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)]);
    try{
      const initialized=await client.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'p15-real-stdio',version:'0.1.0'}});
      assert.ok(initialized.result.capabilities.tools);
      client.notify('notifications/initialized',{});
      return client;
    }catch(error){await client.close();throw error;}
  }
  rpc=await openClient();
  const catalog=official?rpc.tools:(await rpc.request('tools/list',{})).result.tools;
  assert.deepEqual(catalog,contract.tools,'actual tool schema matches the fixed contract');
  await writeFile(`artifacts/${evidence}-tools-${serial?'serial':'ssh'}.json`,JSON.stringify({tools:catalog},null,2)+'\n');
  assert.equal(catalog.find(t=>t.name==='terminal_send').annotations.readOnlyHint,false);
  const call=async(name,args={})=>(await rpc.request('tools/call',{name,arguments:args})).result;
  const success=async(name,args={})=>{const result=await call(name,args);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.structuredContent.mock,false);return result.structuredContent.reply;};
  const pending=await success('agent_status');assert.equal(pending.data.paired_ticket,null);assert.equal(pending.data.peer_pid,rpc.child.pid);
  assert.equal((await call('sessions_list')).structuredContent.error_code,'PERMISSION_DENIED','no pairing means no service access');
  await ui.waitFor(`[...document.querySelectorAll('[role=\"tab\"]')].some(tab=>tab.dataset.connectionId===${JSON.stringify(ref.connection_id)})`);await ui.selectTab(ref.connection_id);await ui.click('Agent 授权');
  await ui.waitFor(`!!document.querySelector('[aria-label="Agent签发编号"]')`);await ui.fill('Agent签发编号',grantId);await ui.click('查询原Agent编号');await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
  await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(x=>x.textContent==='MCP 初版连接').click()`);
  await ui.click('刷新MCP连接状态');await ui.waitFor(`!!document.querySelector('[aria-label="MCP本次启动参数"]')`);
  await ui.click('预览MCP绑定原授权');await ui.waitFor(`!!document.querySelector('[aria-label="MCP固定配对预览"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').checked`),false);
  const previewText=await ui.evaluate(`document.querySelector('[aria-label="MCP固定配对预览"]').textContent`);assert.ok(previewText.includes(String(rpc.child.pid)));assert.ok(previewText.includes(grantId));assert.ok(!previewText.includes('P15_PRIVATE'));
  await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').click()`);await ui.click('确认MCP绑定');await ui.waitFor(`document.querySelector('[aria-label="MCP配对状态"]').textContent.includes('已绑定独立Agent身份')`);
  let paired;for(let i=0;i<100;i++){paired=await success('agent_status');if(paired.data.paired_ticket)break;await delay(20);}assert.equal(paired.data.paired_ticket,signed.data.summary.ticket_id);
  const visible=await success('sessions_list');assert.deepEqual(visible.data.map(c=>c.connection_id),[ref.connection_id]);
  if(otherRef)assert.equal((await call('terminal_read',{connection:otherRef,window:null,view:{kind:'info'}})).isError,true);
  const text=security||exec?'MCP共享 P22_SAFE_PREFIX '+'.'.repeat(80)+' P15_PRIVATE\r\n':'MCP共享 P15_PRIVATE\r\n',request_id=randomUUID(),send={transport,connection:ref,request_id,text};
  assert.equal((await call('terminal_send',send)).structuredContent.error_code,'INPUT_BUSY','Write grant without lease cannot dispatch');
  const lease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;assert.ok(lease.lease_id);
  const before=metrics?(await metrics()).received.flat().length:0;
  await success('terminal_send',send);
  let desktopText='';for(let i=0;i<100;i++){desktopText=(await ui.invoke('service_read_text',{connection:ref,cursor:1})).events.map(e=>e.text).join('');if(desktopText.includes(text))break;await delay(30);}assert.ok(desktopText.includes(text),'the actual Desktop connection sees the MCP echo');
  await success('terminal_send',send);await delay(50);
  if(metrics)assert.equal(Buffer.from((await metrics()).received.flat().slice(before)).toString(),text,'same original write UUID does not duplicate actual wire bytes');
  const receipt=await success('terminal_input_status',{transport,connection:ref,request_id});assert.equal(receipt.data.request_id,request_id);
  const output=await success('terminal_read',{connection:ref,window:null,view:{kind:'info'}});assert.equal(output.result,protectedGrant?'protected_context':'context');
  const through=output.data.context.through_cursor;
  const read=await success('terminal_read',{connection:ref,window:null,view:{kind:'text',cursor:1,through_cursor:through,max_bytes:65536}});
  const protectedText=read.data.page.events.map(e=>e.text).join('');assert.ok(protectedText.includes('MCP共享'));assert.equal(protectedText.includes('P15_PRIVATE'),!protectedGrant,'only the explicitly protected grant changes the Agent projection');
  await success('terminal_screen',{connection:ref,window:null,through_cursor:through});
  assert.equal((await call('terminal_send',{...send,request_id:randomUUID(),role:'desktop'})).isError,true);
  const securityChecks=security?await checkMcpSecurity({ui,call,success,catalog,ref,other:otherRef,transport,management,grantId,signed,lease,send,control,metrics,rpc,sentinels}):null;
  const rebind=async id=>{
    await rpc.close();assert.ok(!rpc.stderr.includes('synthetic-secret')&&!rpc.stderr.includes('P15_PRIVATE'));for(let i=0;i<100;i++){if((await broker({op:'info'})).peer===null)break;await delay(20);}
    rpc=await openClient();
    await success('agent_status');await ui.fill('Agent签发编号',id);await ui.click('查询原Agent编号');await ui.waitFor(`document.querySelector('[aria-label="Agent授权详情"]')?.textContent.includes('ACTIVE')`);
    await ui.click('刷新MCP连接状态');await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='预览MCP绑定原授权'&&!b.disabled)&&document.body.textContent.includes(${JSON.stringify('实际进程 PID '+rpc.child.pid)})`);await ui.click('预览MCP绑定原授权');await ui.waitFor(`!!document.querySelector('[aria-label="MCP固定配对预览"]')`);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').checked`),false);await ui.evaluate(`document.querySelector('[aria-label="同意MCP绑定原授权"]').click()`);await ui.click('确认MCP绑定');
    for(let i=0;i<100;i++){if((await success('agent_status')).data.paired_ticket)return;await delay(20);}throw new Error('rebind did not complete');
  };
  const execChecks=exec?await checkMcpExec({ui,call,success,ref,other:otherRef,management,grantId,signed,lease,metrics,rebind,getRpc:()=>rpc,evidencePrefix:evidence}):null;
  const serialChecks=serialControl?await checkMcpSerial({directory,ui,call,success,ref,other:otherRef,management,grantId,signed,lease,rebind,getRpc:()=>rpc,evidence}):null;
  if(readBoundaries){
    const read=await checkReadBoundaries({catalog,ref,call,success,management,rebind});
    assert.equal((await rpc.close()).code,0);rpc=undefined;
    const owner=await ui.invoke('service_status');
    const close=await closeSoakDesktop(ui,directory,owner,{});
    await ui.close();ui=undefined;
    await writeFile(`artifacts/${evidence}-result.json`,JSON.stringify({
      result:'PASS',preview:preview.directory,ordinaryService:true,read,close,
    },null,2)+'\n');
    console.log('PASS official terminal_read metadata and ordinary/protected bounds on the copied preview');
  }else if(silentLink){
    const report=await checkSilentLink({ui,link,call,success,control,management,grantId,ref,send,sshPin});
    assert.equal((await rpc.close()).code,0);rpc=undefined;
    const owner=await ui.invoke('service_status');
    const close=await closeSoakDesktop(ui,directory,owner,{});
    await ui.close();ui=undefined;
    assert.equal(fixture.exitCode,null);
    const fixtureExit=new Promise(resolve=>fixture.once('exit',resolve));
    fixture.stdin.end();
    assert.equal(await fixtureExit,0);
    fixture=undefined;
    silentLinkReport={...report,sourcePreview:preview.directory,serviceClose:close,fixtureExit:0};
  }else if(serviceInterruption){
    serviceInterruptionReport=await checkServiceInterruption({
      directory,ui,call,success,ref,management,grantId,lease,control,send,
      serviceExecutable:await realpath(path.join(preview.directory,'session-service.exe')),
      reopen:async()=>{
        ui=await launchDesktop(directory,{
          executable:path.join(preview.directory,'shared-terminal-desktop.exe'),
          webviewDirectory:path.join(directory,'webview-restart'),
        });
        return ui;
      },
    });
    assert.equal((await rpc.close()).code,0);rpc=undefined;
  }else if(disconnect||forget||reconnect||connect||serialConnect||sshResize||wait||protectedExport||interruption){
    const common={directory,ui,call,success,ref,other:otherRef,transport,management,grantId,lease,control,rebind,getRpc:()=>rpc};
    const report=interruption
      ?await checkSshInterruption({...common,send,killSshFixture,restartPeer:async()=>{
        const replacementRoot=path.join(directory,'replacement-peer');
        await mkdir(replacementRoot);
        return startSshFixture(replacementRoot,sshPort);
      }})
      :protectedExport
      ?await checkProtectedExport(common)
      :wait
      ?official?await checkOfficialWait(common):await checkMcpWait(common)
      :sshResize?await checkMcpSshResize(common)
      :serialConnect?await checkMcpSerialConnect(common)
      :connect?await checkMcpConnect(common)
      :reconnect?await checkMcpReconnect({...common,profileId,sshPin,originalInput:send})
      :forget?await checkMcpForget({...common,profileId,sshPin})
      :await checkMcpDisconnect(common);
    assert.equal((await rpc.close()).code,0);rpc=undefined;
    if(interruption)interruptionReport=report;
    else{
      await writeFile(`artifacts/${evidence}-${serial?'serial':'ssh'}.json`,JSON.stringify({...report,stdio_exit:0},null,2)+'\n');
      console.log(`PASS real MCP ${transport} ${protectedExport?'Protected Export':wait?'Wait':sshResize?'Resize':connect||serialConnect?'Connect':reconnect?'Reconnect':forget?'Forget':'Disconnect'}, original receipt, permission boundaries and transport cleanup`);
    }
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
    if(security)await writeFile(`artifacts/${evidence}-${serial?'serial':'ssh'}.json`,JSON.stringify({...securityReport,service_loss:'UNKNOWN_DELIVERY',stdio_exit:0},null,2)+'\n');
    console.log(`PASS real MCP ${transport}: native fixed-process/original-grant GUI approval, default-none, no unpaired access/bearer, same shared connection exact send/receipt/protected read/screen, lease and dedup, unrelated session denied, takeover/revoke rejected, Agent source audit and stdio EOF cleanup; synthetic only`);
  }
} catch(error) {
  failed=true;console.error('MCP deterministic test failed before cleanup:',error);
  if((exec||countedSerial||disconnect||forget||reconnect||connect||sshResize||wait||protectedExport||interruption||serviceInterruption||silentLink)&&ui)await ui.screenshot(`${evidence}-${serial?'serial':'ssh'}-failure.png`).catch(()=>{});
  if(directory)console.error('Owned failed MCP root retained:',directory);throw error;
} finally {
  try {if(rpc)await rpc.close();await ui?.close();fixture?.kill();if(fixture)await new Promise(resolve=>{if(fixture.exitCode!==null||fixture.signalCode!==null)resolve();else fixture.once('exit',resolve);});if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith(rootPrefix));if(!failed)await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
  catch(error){failed=true;throw error;}
  finally {
    await link?.close();if(serial&&!countedSerial)build(false);
    if(official)await writeFile(`artifacts/${evidence}-${serial?'serial':'ssh'}-calls.json`,JSON.stringify({
      result:failed?'FAIL':'PASS',client:'official Codex app-server',modelTurns:0,observations,
    },null,2)+'\n');
  }
}
async function checkReadBoundaries({catalog,ref,call,success,management,rebind}){
  const read=catalog.find(tool=>tool.name==='terminal_read');
  const variants=read.inputSchema.$defs.View.oneOf.map(variant=>variant.properties);
  assert.deepEqual(variants.map(properties=>properties.kind.const),['info','text','screen']);
  assert.deepEqual(variants[1].max_bytes,{format:'uint',minimum:16384,maximum:65536,type:'integer'});
  assert.equal(variants[0].max_bytes,undefined);
  assert.equal(variants[2].max_bytes,undefined);
  const now=Date.now();
  const approvedWindow={from_ms:now-60000,until_ms:now+60000};
  const projections=[];
  for(const [projection,window] of [
    ['context',null],['protected_context',null],['context',approvedWindow],['protected_context',approvedWindow],
  ]){
    const protectedRead=projection==='protected_context';
    if(protectedRead||window){
      const id=randomUUID();
      const target=window?{kind:'output_window',connection:ref,window}:{kind:'connection',connection:ref};
      const grant={request_id:id,scopes:[{action:'READ',target}],lifetime_ms:120000};
      await management(protectedRead?
        {...grant,op:'grant_protected',form:{kind:'scoped'},redaction:{sensitive_fields:false,literals:['P15_PRIVATE']}}:
        {...grant,op:'grant'});
      await rebind(id);
    }
    const viewCall=view=>({connection:ref,window,view});
    if(window){
      const missing=await call('terminal_read',{...viewCall({kind:'info'}),window:null});
      assert.equal(missing.isError,true);
      assert.equal(missing.structuredContent.error_code,'PERMISSION_DENIED');
    }
    const info=await success('terminal_read',viewCall({kind:'info'}));
    assert.equal(info.result,projection);
    const through_cursor=info.data.context.through_cursor;
    const page=(max_bytes,kind='text')=>viewCall({kind,cursor:1,through_cursor,max_bytes});
    const accepted=[16384,65536],rejected=[4096,16383,65537];
    for(const size of accepted){
      const output=await success('terminal_read',page(size));
      assert.equal(output.result,projection);
      const text=output.data.page.events.map(event=>event.text).join('');
      assert.ok(text.includes('MCP共享'));
      assert.equal(text.includes('P15_PRIVATE'),projection==='context');
    }
    for(const args of [...rejected.map(size=>page(size)),page(4096,'raw')]){
      const error=await call('terminal_read',args);
      assert.equal(error.isError,true);
      assert.deepEqual(error.structuredContent,{mock:false,error_code:'INVALID_ARGUMENT'});
    }
    assert.equal((await success('terminal_read',viewCall({kind:'screen',through_cursor}))).result,projection);
    projections.push({projection,scope:window?'approved_window':'connection',accepted,rejected,rawRejected:true,infoAndScreen:true});
  }
  return projections;
}
async function checkOfficialWait({ref,other,control,success,call,management,grantId}){
  const info=await success('terminal_read',{connection:ref,window:null,view:{kind:'info'}});
  assert.equal(info.result,'protected_context');
  const {context}=info.data;
  const args={connection:ref,cursor:context.through_cursor,pattern:'P16_OFFICIAL_WAIT.*[FIXTURE]',timeout_ms:5000};
  assert.equal((await call('terminal_wait',{...args,connection:other,cursor:1})).structuredContent.error_code,'PERMISSION_DENIED');
  await control({op:'push',text:args.pattern+' P15_PRIVATE\r\n'});
  const matched=await success('terminal_wait',args);
  assert.equal(matched.data.state,'MATCHED');
  assert.equal(matched.data.evidence.text,args.pattern);
  await management({op:'grant_revoke',request_id:grantId});
  assert.equal((await call('terminal_wait',args)).structuredContent.error_code,'PERMISSION_DENIED');
  return {result:'PASS',protectedRead:true,literalMatch:true,foreignDenied:true,revokedDenied:true};
}
if(silentLinkReport){
  await writeFile(`artifacts/${evidence}-ssh.json`,JSON.stringify({...silentLinkReport,stdioExit:0,ownedResourcesReleased:true},null,2)+'\n');
  console.log('PASS ordinary Desktop SSH2 silent link, manual reconnect, and owned resource cleanup');
}
if(interruptionReport){
  await writeFile(`artifacts/${evidence}-ssh.json`,JSON.stringify({...interruptionReport,stdio_exit:0,owned_processes_exited:true,owned_root_removed:true},null,2)+'\n');
  console.log('PASS ordinary Desktop SSH2 peer interruption, manual reconnect, original receipts and owned resource cleanup');
}
if(serviceInterruptionReport){
  await writeFile(`artifacts/${evidence}-ssh.json`,JSON.stringify({...serviceInterruptionReport,stdio_exit:0,owned_processes_exited:true,owned_root_removed:true},null,2)+'\n');
  console.log('PASS ordinary Desktop owned service loss with active SSH2 and paired Agent, explicit restart and owned resource cleanup');
}
