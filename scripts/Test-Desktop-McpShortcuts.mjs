import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {access,copyFile,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {delay,desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';
import {openCodexMcpClient} from './lib/CodexMcpClient.mjs';
import {readMcpCatalog} from './lib/McpCatalog.mjs';

const executable=path.resolve(process.argv[2]);
const previous=process.argv[3]&&path.resolve(process.argv[3]);
let desktop=previous??executable;
let catalogVersion=previous?12:14;
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-mcp-shortcuts-中文-'));
const evidence={result:'IN_PROGRESS',...await desktopEvidence(executable),observations:[],checks:[],modelTurns:0};
const nil='00000000-0000-0000-0000-000000000000';
const script=path.join(root,'保留原文件.cmd');
const replacement=path.join(root,'未创建目标.bat');
const adb=path.join(root,'adb.exe');
const q=JSON.stringify;
const state='[aria-label="快捷指令授权状态"]';
const preview='fieldset[aria-label="快捷指令授权预览"]';
const sidebar='.pane-active .adb-shortcut-panel:not([hidden])';
const query=selector=>`document.querySelector(${q(selector)})`;
const project=items=>items.map(item=>item.id);
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const sha256Content=Buffer.from('@echo off\r\necho RUN>"%~dp0script-executed.txt"\r\n');
const adbItem=(name,command,pinned=false)=>({name,target:{type:'adb',command},pinned});
const scriptItem=(name,target,pinned=false)=>({name,target:{type:'script',path:target},pinned});
const mut=(revision,args)=>({request_id:requestId(),revision,...args});
const broker=request=>ui.invoke('bridge_management_request',{request});
const setting=()=>ui.invoke('local_adb_settings',{settings:null});
let ui,client,info,fixture;

async function tool(name) {
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click(name);
}
async function openApprovalPanel() {
  await tool('Agent 授权');
  await ui.waitFor('!![...document.querySelectorAll("summary")].find(el=>el.textContent==="MCP 初版连接")');
  await ui.evaluate('[...document.querySelectorAll("summary")].find(el=>el.textContent==="MCP 初版连接").click()');
}
async function boot() {
  ui=await launchDesktop(root,{executable:desktop});
  assert.equal((await ui.invoke('service_status')).fixture,false);
  assert.deepEqual(await ui.invoke('service_list'),[]);
  await openApprovalPanel();
  await ui.click('刷新MCP连接状态');
  const args=query('[aria-label="MCP本次启动参数"]');
  await ui.waitFor(`!!${args}`);
  info=await broker({op:'info'});
  assert.deepEqual(JSON.parse(await ui.evaluate(`${args}.textContent`)),{
    command:info.executable,args:['--stdio','--broker',info.instance,'--desktop-pid',String(info.desktop_pid)],
  });
  assert.equal(info.executable.toLowerCase(),path.join(path.dirname(desktop),'terminal-mcp.exe').toLowerCase());
  const contract=await readMcpCatalog(catalogVersion);
  client=await openCodexMcpClient({directory:root,info,broker,catalog:contract.tools,observations:evidence.observations});
  await ui.click('刷新快捷指令授权');
  await waitStatus('已刷新');
}
async function shutdown(activeLocal) {
  assert.equal((await client.close()).code,0);
  client=undefined;
  await tool('退出桌面');
  if(activeLocal){
    await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
    await ui.click('确认退出并停止服务');
  }
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
  ui=undefined;
}
const waitStatus=message=>ui.waitFor(`${query(state)}?.textContent.includes(${q(message)})`);
async function approve(scope,seconds=60) {
  await ui.fill('快捷指令授权期限',String(seconds));
  await ui.click(`预览${scope}快捷指令授权`);
  await ui.waitFor(`!!${query(preview)}`);
  const text=await ui.evaluate(`${query(preview)}.textContent`);
  assert.ok(text.includes(String(client.child.pid)));
  assert.ok(text.includes((await broker({op:'info'})).peer.pending_id));
  assert.ok(text.includes(String(seconds)+' 秒'));
  if(scope.startsWith('扩展'))assert.match(text,/本地命令.*会话发送文本/);
  assert.equal(await ui.evaluate(`${query('[aria-label="同意快捷指令授权"]')}.checked`),false);
  assert.equal(await ui.evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="确认快捷指令授权").disabled'),true);
  await ui.evaluate(`${query('[aria-label="同意快捷指令授权"]')}.click()`);
  await ui.click('确认快捷指令授权');
  await waitStatus(`已批准${scope}`);
}
async function revoke(scope) {
  await ui.click(`撤销${scope}快捷指令授权`);
  await waitStatus(`已撤销${scope}`);
}
async function call(name,arguments_={}) {
  return (await client.request('tools/call',{name,arguments:arguments_})).result;
}
async function success(name,arguments_={}) {
  const result=await call(name,arguments_);
  assert.equal(result.isError,false,`${name}: ${result.structuredContent.error_code}`);
  return result.structuredContent.reply.data;
}
async function denied(name,arguments_,error='PERMISSION_DENIED') {
  const result=await call(name,arguments_);
  assert.equal(result.isError,true,`${name} must fail with ${error}`);
  assert.deepEqual(result.structuredContent,{mock:false,error_code:error});
}
const list=args=>success('shortcuts_list',args);
const receipt=id=>list({receipt_request_id:id});
const sidebarIds=ids=>ui.waitFor(`JSON.stringify([...document.querySelectorAll(${q(sidebar+' [data-shortcut-id]')})].map(row=>row.dataset.shortcutId))===${q(JSON.stringify(ids))}`);
async function openSidebar() {
  await tool('轻量命令行');
  await ui.waitFor("!!document.querySelector('.pane-active .adb-panel-toggle')");
  if(!await ui.evaluate(`!!${query(sidebar)}`))await ui.click('快捷指令');
}
async function absent(file) {
  await assert.rejects(access(file),{code:'ENOENT'});
}

async function loopback() {
  const work=path.join(root,'owned-ssh');
  await mkdir(work);
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[work],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
  async function next() {
    let timer;
    try {
      const line=await Promise.race([lines.next(),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('owned SSH timeout')),8000);
      })]);
      return JSON.parse(line.value);
    } finally {clearTimeout(timer);}
  }
  const {port,pin,password}=await next();
  const ssh=request=>ui.invoke('ssh_request',{request});
  const {connection}=await ssh({op:'quick_start',request_id:requestId(),cols:80,rows:24,
    settings:{protocol:'ssh2',host:'127.0.0.1',port,username:'synthetic',auth:'password',encoding:'utf8'}});
  const ref={connection_id:connection.connection_id,generation:connection.generation};
  const answered=new Set();
  let connected=false;
  for(let retry=0;retry<160;retry++){
    const status=await ssh({op:'status',connection:ref});
    assert.notEqual(status.connection.state,'FAILED');
    if(status.connection.state==='CONNECTED'){connected=true;break;}
    const challenge=status.challenge;
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,pin);
        await ssh({op:'answer_host',connection:ref,challenge_id:challenge.id,approve:true});
      }else await ssh({op:'authenticate',connection:ref,challenge_id:challenge.id,use_saved:false,password});
    }
    await delay(30);
  }
  assert.equal(connected,true);
  await ui.selectTab(ref.connection_id);
  return {ref,received:async()=>{
    fixture.stdin.write(JSON.stringify({op:'metrics'})+'\n');
    return (await next()).received;
  }};
}

async function descriptionChecks(received, priorRequest, priorReceipt) {
  const v2={version:'v2'}, v3={version:'v3'};
  const descriptions=()=>list(v3);
  const put=(revision,changes)=>({...v3,...mut(revision,{changes})});
  const before=await setting();
  const marker='描述里的专用哨兵';
  const sentText='P26_DESCRIBED_BODY';
  const create={...v3,...mut(before.revision,{items:[
    {...adbItem('描述 ADB','adb version'),description:'设备版本\r\n第二行'},
    {name:'描述脚本',target:{type:'script',path:script},description:'脚本描述'},
    {name:'描述本地命令',target:{type:'local',command:'echo LOCAL'},description:'🙂'.repeat(500)},
    {name:'描述会话发送',target:{type:'send',text:sentText},description:marker,append_enter:true},
  ]})};
  await denied('shortcuts_list',v3);
  await denied('shortcuts_create',create);
  await approve('扩展查看',300);
  await approve('扩展管理',300);
  await denied('shortcuts_create',create);
  await approve('描述查看',300);
  assert.deepEqual((await descriptions()).items.filter(item=>item.description),[]);
  await denied('shortcuts_create',create);
  await approve('描述管理',300);
  assert.deepEqual(await list({...v3,receipt_request_id:priorRequest.request_id}),priorReceipt);

  const originalReceived=Buffer.from((await received()).flat());
  const created=await success('shortcuts_create',create);
  const [adbId,scriptId,localId,sendId]=created.ids;
  const find=(snapshot,id)=>snapshot.items.find(item=>item.id===id);
  const initial=await descriptions();
  assert.equal(initial.version,'v3');
  assert.equal(find(initial,adbId).description,'设备版本\n第二行');
  assert.equal(find(initial,scriptId).description,'脚本描述');
  assert.equal(find(initial,localId).description,'🙂'.repeat(500));
  assert.equal(find(initial,sendId).description,marker);
  assert.ok((await list(v2)).items.every(item=>!('description' in item)));
  await denied('shortcuts_list',{...v2,receipt_request_id:create.request_id},'NOT_FOUND');
  await denied('shortcuts_create',{...create,...v2,items:[adbItem('跨版本重复编号','adb version')]},'REQUEST_CONFLICT');
  await denied('shortcuts_update',put(created.revision,[{id:adbId,description:'首项也不能保存'},
    {id:localId,description:'🙂'.repeat(501)}]),'INVALID_ARGUMENT');
  await denied('shortcuts_update',put(created.revision,[{id:localId,description:'\u0000'}]),'INVALID_ARGUMENT');
  assert.deepEqual(await descriptions(),initial);
  const oldUpdate={...v2,...mut(initial.revision,{changes:[{id:adbId,name:'v2 保留描述'}]})};
  await denied('shortcuts_update',{...oldUpdate,changes:[{id:adbId,description:'旧契约越界'}]},'INVALID_ARGUMENT');
  const oldChanged=await success('shortcuts_update',oldUpdate);
  assert.equal(find(await descriptions(),adbId).description,'设备版本\n第二行');
  assert.deepEqual(await list({...v3,receipt_request_id:oldUpdate.request_id}),oldChanged);
  await denied('shortcuts_update',put(initial.revision,[{id:adbId,description:'过期修订'}]),'REVISION_CONFLICT');

  const update=put(oldChanged.revision,[{id:adbId,name:'v3 省略描述'},
    {id:scriptId,description:''},{id:localId,description:null}]);
  const pending=client.begin('tools/call',{name:'shortcuts_update',arguments:update},4000);
  client.discardResponse(pending.id);
  await assert.rejects(pending.promise,/RPC timeout/);
  const saved=await list({...v3,receipt_request_id:update.request_id});
  assert.deepEqual(await success('shortcuts_update',update),saved);
  await denied('shortcuts_update',{...update,changes:[{id:adbId,description:'替换旧编号'}]},'REQUEST_CONFLICT');
  const final=await descriptions();
  assert.equal(find(final,adbId).description,'设备版本\n第二行');
  assert.equal(find(final,scriptId).description,undefined);
  assert.equal(find(final,localId).description,undefined);
  const fileHash=await hash(script);
  const removal={...v3,...mut(final.revision,{ids:[scriptId]})};
  const removed=await success('shortcuts_remove',removal);
  assert.deepEqual(removed.ids,[scriptId]);
  assert.deepEqual(await list({...v3,receipt_request_id:removal.request_id}),removed);
  assert.equal(await hash(script),fileHash);
  assert.deepEqual(Buffer.from((await received()).flat()),originalReceived);
  await absent(path.join(root,'adb-calls.txt'));
  await absent(path.join(root,'script-executed.txt'));
  await sidebarIds(project((await descriptions()).items));
  await ui.click('描述会话发送');
  const expected=Buffer.concat([originalReceived,Buffer.from(sentText+'\r')]);
  let actual=originalReceived;
  for(let attempt=0;attempt<120&&actual.length<expected.length;attempt++){
    actual=Buffer.from((await received()).flat());
    if(actual.length<expected.length)await delay(40);
  }
  assert.deepEqual(actual,expected,'only the command and requested Enter reach loopback SSH');
  await revoke('描述查看');
  await denied('shortcuts_list',v3);
  await revoke('描述管理');
  await denied('shortcuts_list',{...v3,receipt_request_id:update.request_id});
  evidence.checks.push('v3 independent view/manage, four descriptions, 500 Unicode boundaries, lost receipt, exact input, v2 projection and preservation, cross-version conflicts and revocation');
  return {v3,requestId:update.request_id,receipt:saved,adbId,sendId,marker};
}

async function expandedChecks({legacyIds, desktopOnly, priorRequest, priorReceipt, scriptHash}) {
  const compatibility=path.join(root,'legacy-bridge-install');
  await mkdir(compatibility);
  for(const file of ['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe']){
    await copyFile(path.join(path.dirname(file==='terminal-mcp.exe'?previous:executable),file),path.join(compatibility,file));
  }
  desktop=path.join(compatibility,'shared-terminal-desktop.exe');
  catalogVersion=12;
  await boot();
  await denied('shortcuts_list',{});
  await approve('查看');
  await approve('管理');
  assert.deepEqual(project((await list()).items),legacyIds);
  assert.deepEqual(await list({query:'PRIVATE_SEND'}),{revision:(await setting()).revision,items:[]});
  assert.deepEqual(await receipt(priorRequest.request_id),priorReceipt);
  assert.deepEqual(await success('shortcuts_remove',priorRequest),priorReceipt);
  await shutdown(false);
  evidence.checks.push('actual v12 bridge against updated Desktop, including persisted pre-upgrade receipt and identical legacy replay');

  desktop=executable;
  catalogVersion=14;
  await boot();
  const legacyArgs={};
  const v2={version:'v2'};
  const expanded=(extra={})=>list({...v2,...extra});
  const versioned=(revision,args)=>({...v2,...mut(revision,args)});
  const put=(revision,args)=>success('shortcuts_update',versioned(revision,args));
  await denied('shortcuts_list',legacyArgs);
  await denied('shortcuts_list',v2);
  await approve('查看',300);
  await approve('管理',300);
  assert.deepEqual(project((await list()).items),legacyIds);
  assert.deepEqual((await list({query:'PRIVATE_SEND'})).items,[]);
  await denied('shortcuts_list',v2);
  await denied('shortcuts_list',{...v2,receipt_request_id:priorRequest.request_id});
  await denied('shortcuts_update',mut((await list()).revision,{changes:[{id:desktopOnly[0].id,name:'旧授权不可改'}]}),'NOT_FOUND');
  await denied('shortcuts_remove',mut((await list()).revision,{ids:[desktopOnly[1].id]}),'NOT_FOUND');
  await denied('shortcuts_list',{version:'v3'},'PERMISSION_DENIED');
  await denied('shortcuts_list',{version:'v4'},'INVALID_ARGUMENT');

  const {ref,received}=await loopback();
  const initialReceived=await received();
  await openSidebar();
  await ui.selectTab(ref.connection_id);
  await sidebarIds(project((await setting()).shortcuts));
  await approve('扩展查看',300);
  const initial=await expanded();
  assert.equal(initial.version,'v2');
  assert.deepEqual(project((await expanded({query:'PRIVATE_SEND'})).items),[desktopOnly[1].id]);
  await denied('shortcuts_create',versioned(initial.revision,{items:[adbItem('未批准新建','adb devices')]}));
  await revoke('查看');
  await denied('shortcuts_list',legacyArgs);
  await approve('扩展管理',300);
  assert.deepEqual(await expanded({receipt_request_id:priorRequest.request_id}),priorReceipt);
  await denied('sessions_list',{});
  await denied('terminal_send',{transport:'SSH2',connection:ref,request_id:requestId(),text:'UNAPPROVED'});

  const rootShell='adb root\r\nadb shell';
  const otherBody='adb shell "dmesg -w | cat" | Select-String power\nprobe.exe "one two"';
  const make=({name,type,body,pinned=false,...options})=>({name,pinned,...options,target:{
    type,...(type==='script'?{path:body}:type==='send'?{text:body}:{command:body}),
  }});
  const batch=versioned(initial.revision,{items:[
    make({name:'新版 ADB',type:'adb',body:'adb devices -l',pinned:true,close_on_success:true}),
    make({type:'script',body:script,pinned:true,close_on_success:true}),
    make({name:'两行本地命令',type:'local',body:rootShell,close_on_success:true}),
    make({name:'单行会话模板',type:'send',body:'echo UNSENT',append_enter:true}),
    make({name:'混合换行和引号',type:'local',body:otherBody}),
  ]});
  const created=await success('shortcuts_create',batch);
  const [adbId,scriptId,localId,sendId,otherId]=created.ids;
  const view=async()=>{const value=await expanded();await sidebarIds(project(value.items));return value;};
  const by=(value,id)=>value.items.find(item=>item.id===id);
  const createdView=await view();
  assert.deepEqual(by(createdView,localId).target,{type:'local',command:rootShell});
  assert.deepEqual(by(createdView,otherId).target,{type:'local',command:otherBody});
  assert.deepEqual(by(createdView,sendId).target,{type:'send',text:'echo UNSENT'});
  assert.equal(by(createdView,scriptId).name,path.basename(script));
  assert.equal(by(createdView,scriptId).close_on_success,true);
  assert.equal(by(createdView,sendId).append_enter,true);
  assert.equal(by(createdView,sendId).close_on_success,undefined);
  await denied('shortcuts_list',{receipt_request_id:batch.request_id},'NOT_FOUND');
  assert.deepEqual(await success('shortcuts_create',batch),created);
  await denied('shortcuts_create',{...batch,items:[adbItem('重复编号','adb version')]},'REQUEST_CONFLICT');
  await denied('shortcuts_create',{request_id:batch.request_id,revision:initial.revision,items:[adbItem('旧版重复编号','adb version')]},'REQUEST_CONFLICT');
  await denied('shortcuts_update',versioned(initial.revision,{changes:[{id:localId,name:'过期'}]}),'REVISION_CONFLICT');
  await denied('shortcuts_update',versioned(created.revision,{changes:[{id:sendId,close_on_success:false}]}),'INVALID_ARGUMENT');
  await denied('shortcuts_update',versioned(created.revision,{changes:[{id:localId,append_enter:false}]}),'INVALID_ARGUMENT');
  await denied('shortcuts_update',versioned(created.revision,{changes:[{id:localId,name:'🙂'.repeat(65)}]}),'INVALID_ARGUMENT');
  await denied('shortcuts_update',versioned(created.revision,{changes:[{id:sendId,target:{type:'send',text:'one\ntwo'}}]}),'INVALID_ARGUMENT');
  await denied('shortcuts_list',{...v2,path:script},'INVALID_ARGUMENT');
  await denied('shortcuts_create',versioned(created.revision,{items:[make({type:'script',body:'relative.cmd'})]}),'INVALID_ARGUMENT');
  assert.deepEqual(await view(),createdView);

  const patched=await put(created.revision,{changes:[
    {id:localId,name:'两行命令改名',close_on_success:false},
    {id:sendId,append_enter:false},
    {id:scriptId,name:'用户别名'},
  ]});
  const longScript=path.join(root,'长'.repeat(65)+'.cmd');
  const changedPath=await put(patched.revision,{changes:[{id:scriptId,target:{type:'script',path:longScript}}]});
  const renamed=await view();
  assert.equal(by(renamed,scriptId).name,'用户别名');
  assert.equal(by(renamed,scriptId).close_on_success,true);
  assert.equal(by(renamed,localId).close_on_success,false);
  assert.equal(by(renamed,localId).target.command,rootShell);
  assert.equal(by(renamed,sendId).append_enter,false);
  assert.equal(by(renamed,sendId).target.text,'echo UNSENT');
  assert.equal((await setting()).shortcuts.find(item=>item.id===localId).command,rootShell);
  const cleared=await put(changedPath.revision,{changes:[{id:scriptId,name:''}]});
  const shortName='长'.repeat(60)+'.cmd';
  const clearedView=await view();
  assert.equal(by(clearedView,scriptId).name,shortName);
  assert.equal(Array.from(shortName).length,64);
  const legacyChanged=await success('shortcuts_update',mut(cleared.revision,{changes:[{id:adbId,name:'旧客户端改名'}],
    moves:[{ids:[scriptId],anchor:adbId,side:'before'}]}));
  const edgeBase=await view();
  assert.equal(by(edgeBase,adbId).close_on_success,true);
  const pinnedOrder=edgeBase.items.filter(item=>item.pinned).map(item=>item.id);
  const ordinaryOrder=edgeBase.items.filter(item=>!item.pinned).map(item=>item.id);
  const ordinaryBlock=ordinaryOrder.filter(id=>[sendId,localId].includes(id));
  await denied('shortcuts_update',versioned(legacyChanged.revision,{
    changes:[{id:otherId,name:'原子拒绝'}],moves:[{ids:[localId,adbId],edge:'first'}],
  }),'INVALID_ARGUMENT');
  assert.deepEqual(await view(),edgeBase);
  const first=await put(legacyChanged.revision,{moves:[
    {ids:[sendId,localId],edge:'first'},{ids:[adbId],edge:'last'},
  ]});
  const expectedPinned=[...pinnedOrder.filter(id=>id!==adbId),adbId];
  assert.deepEqual(project((await view()).items),[
    ...expectedPinned,...ordinaryBlock,...ordinaryOrder.filter(id=>!ordinaryBlock.includes(id)),
  ]);
  const last=await put(first.revision,{moves:[{ids:[localId,sendId],edge:'last'},{ids:[adbId],edge:'first'}]});
  assert.deepEqual(project((await view()).items),[
    adbId,...expectedPinned.filter(id=>id!==adbId),...ordinaryOrder.filter(id=>!ordinaryBlock.includes(id)),...ordinaryBlock,
  ]);
  assert.deepEqual((await expanded({query:'混合换行'})).items.map(item=>item.target.command),[otherBody]);
  const remove=versioned(last.revision,{ids:created.ids});
  const dropped=client.begin('tools/call',{name:'shortcuts_remove',arguments:remove},4000);
  client.discardResponse(dropped.id);
  await assert.rejects(dropped.promise,/RPC timeout/);
  const removed=await expanded({receipt_request_id:remove.request_id});
  assert.deepEqual(removed.ids,created.ids);
  assert.equal(client.discardedResponses,1);
  await denied('shortcuts_list',{receipt_request_id:remove.request_id},'NOT_FOUND');
  await view();
  assert.equal(await hash(script),scriptHash);
  await absent(longScript);
  await absent(path.join(root,'script-executed.txt'));
  await absent(path.join(root,'adb-calls.txt'));
  assert.deepEqual(await received(),initialReceived);
  await revoke('扩展查看');
  await denied('shortcuts_list',v2);
  await revoke('扩展管理');
  await denied('shortcuts_list',{...v2,receipt_request_id:remove.request_id});
  assert.deepEqual(await receipt(priorRequest.request_id),priorReceipt);
  const descriptions=await descriptionChecks(received,priorRequest,priorReceipt);
  await shutdown(true);
  await boot();
  await denied('shortcuts_list',v2);
  await denied('shortcuts_list',{...v2,receipt_request_id:remove.request_id});
  await approve('扩展管理');
  assert.deepEqual(await expanded({receipt_request_id:remove.request_id}),removed);
  assert.deepEqual(await expanded({receipt_request_id:priorRequest.request_id}),priorReceipt);
  await denied('shortcuts_list',descriptions.v3);
  await approve('描述查看');
  await approve('描述管理');
  const reloaded=await list(descriptions.v3);
  assert.equal(reloaded.items.find(item=>item.id===descriptions.sendId).description,descriptions.marker);
  assert.deepEqual(await list({...descriptions.v3,receipt_request_id:descriptions.requestId}),descriptions.receipt);
  await shutdown(false);
  const priorV13=path.resolve('artifacts/SharedTerminal-0.1.37-windows-x64/terminal-mcp.exe');
  const compatibleV13=path.join(root,'v13-bridge-install');
  await mkdir(compatibleV13);
  for(const file of ['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe']){
    await copyFile(file==='terminal-mcp.exe'?priorV13:path.join(path.dirname(executable),file),path.join(compatibleV13,file));
  }
  desktop=path.join(compatibleV13,'shared-terminal-desktop.exe');
  catalogVersion=13;
  await boot();
  await approve('扩展查看');
  await approve('扩展管理');
  const v13=await expanded();
  assert.ok(v13.items.some(item=>item.id===descriptions.sendId));
  assert.ok(v13.items.every(item=>!('description' in item)));
  assert.deepEqual(await expanded({receipt_request_id:priorRequest.request_id}),priorReceipt);
  await denied('shortcuts_list',descriptions.v3,'INVALID_ARGUMENT');
  await success('shortcuts_update',versioned(v13.revision,{changes:[{id:descriptions.adbId,name:'真实 v13 桥改名'}]}));
  await shutdown(false);
  desktop=executable;
  catalogVersion=14;
  await boot();
  await approve('描述查看');
  const afterLegacy=await list(descriptions.v3);
  assert.equal(afterLegacy.items.find(item=>item.id===descriptions.adbId).description,'设备版本\n第二行');
  await shutdown(false);
  evidence.checks.push('v3 descriptions and receipt survive restart and a v2 edit from the actual 0.1.37 v13 bridge');
  evidence.checks.push('v13 metadata-only four-type CRUD, exact CR/LF and quoted pipelines, alias fallback at 64, explicit false, legacy field preservation, full-section stable moves, receipts before and after upgrades, zero execution or SSH input');
}

try {
  await writeFile(script,sha256Content);
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:15000});
  await writeFile(path.join(root,'fixture-root.txt'),root);
  const before=await hash(script);
  await boot();
  const createBefore=mut(nil,{items:[adbItem('未批准入口','adb version')]});
  const original=await setting();
  assert.equal(original.revision,null);
  await denied('shortcuts_list',{});
  await denied('shortcuts_create',createBefore);
  await denied('shortcuts_update',mut(nil,{changes:[{id:randomUUID(),name:'未批准更改'}]}));
  await denied('shortcuts_remove',mut(nil,{ids:[randomUUID()]}));
  await denied('shortcuts_list',{receipt_request_id:createBefore.request_id});
  await denied('sessions_list',{});
  await denied('shortcuts_list',{cwd:root},'INVALID_ARGUMENT');
  await ui.click('预览查看快捷指令授权');
  await ui.waitFor(`!!${query(preview)}`);
  await ui.click('取消快捷指令授权');
  await denied('shortcuts_list',{});
  await approve('查看');
  assert.deepEqual(await list(),{revision:nil,items:[]});
  await denied('shortcuts_create',createBefore);
  const pinned=randomUUID(),legacy=randomUUID();
  const seed=await ui.invoke('local_adb_settings',{settings:{
    revision:null,executable:adb,layout:{columns:2,expanded:true},
    shortcuts:[{id:pinned,name:'人工置顶',command:'adb devices',pinned:true},{id:legacy,name:'人工保留',command:'adb version'}],
  }});
  assert.deepEqual(project((await list()).items),[pinned,legacy]);
  await openSidebar();
  await sidebarIds([pinned,legacy]);
  await approve('管理',300);
  await revoke('查看');
  await denied('shortcuts_list',{});
  await denied('sessions_list',{});
  evidence.checks.push('default deny, cancelled preview, empty collection, separate View and Manage with no service pairing');

  const create=mut(seed.revision,{items:[adbItem('新增 ADB','adb devices -l'),scriptItem('登记脚本',script,true)]});
  const created=await success('shortcuts_create',create);
  const [newAdb,newScript]=created.ids;
  assert.equal(created.request_id,create.request_id);
  await sidebarIds([pinned,newScript,legacy,newAdb]);
  assert.deepEqual(await receipt(create.request_id),created);
  assert.deepEqual(await success('shortcuts_create',create),created);
  await denied('shortcuts_create',{...create,items:[adbItem('变更原编号','adb version')]},'REQUEST_CONFLICT');
  assert.equal((await setting()).revision,created.revision);
  await denied('shortcuts_list',{query:'ADB',receipt_request_id:create.request_id},'INVALID_ARGUMENT');
  await denied('shortcuts_list',{receipt_request_id:requestId()},'NOT_FOUND');

  await approve('查看',300);
  const filtered=await list({query:'保留原文件.CMD'});
  assert.deepEqual(filtered,{revision:created.revision,items:[
    {id:newScript,name:'登记脚本',target:{type:'script',path:script},pinned:true,order:2},
  ]});
  assert.deepEqual(project((await list({query:'DEVICES -L'})).items),[newAdb]);
  assert.deepEqual(project((await list({query:'人工置顶'})).items),[pinned]);
  const update=mut(created.revision,{
    changes:[{id:pinned,pinned:false},{id:newAdb,pinned:true,name:'MCP 改名',target:{type:'adb',command:'adb version'}},
      {id:newScript,target:{type:'script',path:replacement}}],
    moves:[{ids:[pinned],anchor:legacy,side:'before'}],
  });
  const updated=await success('shortcuts_update',update);
  const expected=[newScript,newAdb,pinned,legacy];
  await sidebarIds(expected);
  const updatedList=await list();
  assert.deepEqual(project(updatedList.items),expected);
  assert.deepEqual(updatedList.items.map(item=>[item.pinned,item.order]),[[true,1],[true,2],[false,3],[false,4]]);
  assert.deepEqual(updatedList.items[0].target,{type:'script',path:replacement});
  assert.equal(updatedList.items[1].name,'MCP 改名');
  assert.equal(updatedList.items[1].target.command,'adb version');
  await denied('shortcuts_update',mut(updated.revision,{
    changes:[{id:newAdb,name:'绝不能部分写入'}],moves:[{ids:[legacy],anchor:newAdb,side:'after'}],
  }),'INVALID_ARGUMENT');
  await denied('shortcuts_update',mut(updated.revision,{changes:[{id:newAdb,target:{type:'script',path:script}}]}),'INVALID_ARGUMENT');
  await denied('shortcuts_remove',mut(updated.revision,{ids:[newAdb,randomUUID()]}),'NOT_FOUND');
  await denied('shortcuts_create',mut(updated.revision,{items:[adbItem('批量有效','adb version'),scriptItem('非法路径','relative.cmd')]}),'INVALID_ARGUMENT');
  await denied('shortcuts_create',mut(updated.revision,{items:Array.from({length:29},(_,i)=>adbItem('超量 '+i,'adb version'))}),'CAPACITY_EXCEEDED');
  assert.deepEqual(await list(),updatedList);
  evidence.checks.push('live right-sidebar refresh, full metadata and search, stable reorder, pin/unpin, target updates, atomic rejection and exact request replay');

  await ui.click('关闭Agent授权');
  await ui.click('人工保留 的管理操作');
  await ui.waitFor('!!document.querySelector(".adb-row-menu[data-positioned]")');
  await ui.evaluate('[...document.querySelectorAll(".adb-row-menu button")].find(item=>item.textContent==="编辑").click()');
  await ui.fill('指令名称','人工改名');
  await ui.click('保存指令');
  await ui.waitFor(`!!${query(sidebar+' [aria-label="人工改名"]')}`);
  const manual=await list();
  assert.equal(manual.items.find(item=>item.id===legacy).name,'人工改名');
  assert.notEqual(manual.revision,updated.revision);
  await denied('shortcuts_remove',mut(updated.revision,{ids:[newScript]}),'REVISION_CONFLICT');

  await ui.click('人工改名 的管理操作');
  await ui.waitFor('!!document.querySelector(".adb-row-menu[data-positioned]")');
  await ui.evaluate('[...document.querySelectorAll(".adb-row-menu button")].find(item=>item.textContent==="编辑").click()');
  await ui.fill('指令名称','原人工草稿');
  const concurrent=await success('shortcuts_update',mut(manual.revision,{changes:[{id:newAdb,name:'MCP 并发改名'}]}));
  assert.equal(await ui.evaluate(`${query('[aria-label="指令名称"]')}.value`),'原人工草稿');
  await ui.click('保存指令');
  await ui.waitFor('document.body.innerText.includes("ADB 快捷设置已更新，请重新读取后保存")');
  await ui.click('取消编辑');
  await ui.waitFor("!!document.querySelector('dialog:modal[aria-label=更改尚未保存]')");
  await ui.click('放弃更改');
  await ui.waitFor(`!!${query(sidebar+' [aria-label="MCP 并发改名"]')}`);
  assert.equal((await list()).items.find(item=>item.id===legacy).name,'人工改名');

  const remove=mut(concurrent.revision,{ids:[newScript,newAdb]});
  const dropped=client.begin('tools/call',{name:'shortcuts_remove',arguments:remove},4000);
  client.discardResponse(dropped.id);
  await assert.rejects(dropped.promise,/RPC timeout/);
  assert.equal(client.discardedResponses,1);
  const removed=await receipt(remove.request_id);
  assert.deepEqual(removed.ids,[newScript,newAdb]);
  await sidebarIds([pinned,legacy]);
  assert.equal((await list()).revision,removed.revision);
  assert.equal(await hash(script),before);
  await absent(replacement);
  await absent(path.join(root,'script-executed.txt'));
  await absent(path.join(root,'adb-calls.txt'));
  assert.deepEqual((await setting()).layout,{columns:2,expanded:true});
  assert.equal((await setting()).executable,adb);
  evidence.checks.push('CAS in both directions with stale sidebar draft retained, lost reply recovered by original receipt, remove preserves files and executes nothing');

  await openApprovalPanel();
  await ui.click('刷新快捷指令授权');
  await waitStatus('已刷新');
  await approve('管理',15);
  await approve('查看',15);
  await receipt(remove.request_id);
  await list();
  await delay(15_100);
  await denied('shortcuts_list',{receipt_request_id:remove.request_id});
  await denied('shortcuts_list',{});
  await approve('管理');
  await revoke('管理');
  await denied('shortcuts_list',{receipt_request_id:remove.request_id});
  await shutdown(true);
  await boot();
  await denied('shortcuts_list',{receipt_request_id:remove.request_id});
  await denied('shortcuts_list',{});
  await approve('管理');
  assert.deepEqual(await receipt(remove.request_id),removed);
  await denied('shortcuts_list',{});
  await approve('查看');
  assert.deepEqual(project((await list()).items),[pinned,legacy]);
  const desktopOnly=[{id:randomUUID(),name:'仅桌面本机管道',desktop_kind:'local',command:'adb devices | Select-String device'},
    {id:randomUUID(),name:'仅桌面会话发送',desktop_kind:'send',command:'PRIVATE_SEND',append_enter:true}];
  const current=await setting();
  const privateRev=await ui.invoke('local_adb_settings',{settings:{...current,shortcuts:[...current.shortcuts,...desktopOnly]}});
  assert.deepEqual(project((await list()).items),[pinned,legacy]);
  assert.deepEqual((await list({query:'PRIVATE_SEND'})).items,[]);
  await denied('shortcuts_update',mut(privateRev.revision,{changes:[{id:desktopOnly[0].id,name:'不得编辑'}]}),'NOT_FOUND');
  await denied('shortcuts_remove',mut(privateRev.revision,{ids:[desktopOnly[1].id]}),'NOT_FOUND');
  await denied('shortcuts_create',mut(privateRev.revision,{items:[adbItem('不得扩写','adb devices | grep power')]}),'INVALID_ARGUMENT');
  assert.deepEqual((await setting()).shortcuts.filter(item=>item.desktop_kind),desktopOnly);
  evidence.checks.push('legacy MCP scopes cannot read, create, edit, or remove Desktop-only arbitrary commands or session sends');
  await shutdown(false);
  if(previous) await expandedChecks({legacyIds:[pinned,legacy],desktopOnly,priorRequest:remove,priorReceipt:removed,scriptHash:before});
  evidence.checks.push('both scopes expire, revoke is explicit, restart clears authority and exact protected receipt persists');
  evidence.result='PASS';
  console.log('PASS official stdio shortcut management, independent Desktop authority, transactional receipts and live sidebar');
}catch(error){
  evidence.result='FAIL';
  evidence.error=String(error.stack);
  await ui?.screenshot('mcp-shortcuts-failure.png').catch(()=>{});
  throw error;
}finally{
  await client?.close();
  await ui?.close();
  if(fixture&&fixture.exitCode===null&&fixture.signalCode===null){
    const exited=new Promise(resolve=>fixture.once('exit',resolve));
    fixture.stdin.end();
    await exited;
  }
  const release=JSON.parse(await readFile('package.json','utf8')).version;
  const report=previous?`windows-${release}-mcp-shortcuts-verification.json`:'mcp-shortcuts-software-result.json';
  await writeFile(path.join('artifacts',report),JSON.stringify(evidence,null,2)+'\n');
  assert.equal(path.dirname(root).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
  assert.ok(path.basename(root).startsWith('shared-terminal-mcp-shortcuts-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
