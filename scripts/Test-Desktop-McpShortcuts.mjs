import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';
import {openCodexMcpClient} from './lib/CodexMcpClient.mjs';
import {readMcpCatalog} from './lib/McpCatalog.mjs';

const executable=path.resolve(process.argv[2]);
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-mcp-shortcuts-中文-'));
const evidence={result:'IN_PROGRESS',executable,observations:[],checks:[],modelTurns:0};
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
let ui,client,info;

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
  ui=await launchDesktop(root,{executable});
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
  assert.equal(info.executable.toLowerCase(),path.join(path.dirname(executable),'terminal-mcp.exe').toLowerCase());
  const contract=await readMcpCatalog();
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
  await writeFile('artifacts/mcp-shortcuts-software-result.json',JSON.stringify(evidence,null,2)+'\n');
  assert.equal(path.dirname(root).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
  assert.ok(path.basename(root).startsWith('shared-terminal-mcp-shortcuts-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
