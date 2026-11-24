import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {connectDesktopPage,createSshFixtureScope,delay,desktopEvidence,detachOwnedSession,launchDesktop} from './lib/DesktopHarness.mjs';

const [candidate,previous,output]=process.argv.slice(2).map(value=>path.resolve(value));
const temp=await realpath(tmpdir());
const prefix='shared-terminal-context-menu-中文-';
const root=await mkdtemp(path.join(temp,prefix));
const evidence={result:'IN_PROGRESS',...await desktopEvidence(candidate),checks:[]};
const q=JSON.stringify;
const node=selector=>`document.querySelector(${q(selector)})`;
const sidebar='.pane-active .adb-shortcut-panel:not([hidden])';
const shortcut=sidebar+' .adb-shortcut-run';
const treeItem='#connection-library [data-profile-id]';
const configModal='dialog:modal[aria-label="连接配置"]';
const nameField=configModal+' [aria-label="配置名称"]';
const browserItem=/返回|后退|刷新|打印|另存为|共享|Back|Reload|Refresh|Print|Save as|Share/i;
const editorItem=/^\s*(撤[消销]|重做|剪切|复制|粘贴|删除|全选|选择全部|Undo|Redo|Cut|Copy|Paste|Delete|Select all)(?:\s|\(|$)/i;
const nativeItems=(ui,executable,choose)=>JSON.parse(execFileSync('pwsh',[
  '-NoProfile','-File','scripts/lib/Inspect-NativeContextMenu.ps1','-TargetProcessId',String(ui.app.pid),
  '-ExpectedExecutable',executable,...(choose?['-Choose',choose]:[])
],{encoding:'utf8',windowsHide:true,timeout:15000})).items;
let ui,detached,fixtures;

async function tool(label){
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click(label);
}
async function press(page,key){
  const values={ContextMenu:[93,0],F10:[121,8],Escape:[27,0],B:[66,10,'KeyB']};
  const [windowsVirtualKeyCode,modifiers,code=key]=values[key];
  for(const type of ['keyDown','keyUp'])await page.command('Input.dispatchKeyEvent',{
    type,key,code,windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode,modifiers
  });
}
async function pointer(page,selector,button='right',vertical=.5){
  await page.waitFor(`!!${node(selector)}?.getClientRects().length`);
  const point=await page.evaluate(`(()=>{const r=${node(selector)}.getBoundingClientRect();return{x:r.left+r.width*.5,y:r.top+r.height*${vertical}}})()`);
  assert.ok(await page.evaluate(`${node(selector)}.contains(document.elementFromPoint(${point.x},${point.y}))`),selector);
  for(const type of ['mousePressed','mouseReleased'])await page.command('Input.dispatchMouseEvent',{
    type,...point,button,clickCount:1
  });
}
async function showShortcuts(){
  await tool('轻量命令行');
  await ui.waitFor("!!document.querySelector('.pane-active .adb-panel-toggle')");
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:null,shortcuts:[{
    id:crypto.randomUUID(),name:'右键验证指令',desktop_kind:'local',command:'echo SHORTCUT_EXPLICIT_ONLY'
  }]}});
  if(!await ui.evaluate(`!!${node(sidebar)}`))await ui.evaluate("document.querySelector('.pane-active .adb-panel-toggle').click()");
  await ui.waitFor(`!!${node(shortcut)}?.getClientRects().length`);
}
async function trace(page){
  await page.evaluate(`(()=>{
    window.menuTest={events:[],localRuns:0};
    for(const type of ['contextmenu','keydown'])document.addEventListener(type,event=>{
      if(event.type==='contextmenu'||['ContextMenu','F10'].includes(event.key))
        window.menuTest.events.push({type,key:event.key,trusted:event.isTrusted});
    },true);
    const original=window.fetch;
    window.fetch=function(input,init){
      if(new URL(String(input)).pathname==='/local_terminal'&&JSON.parse(init.body).action?.kind==='run')
        window.menuTest.localRuns++;
      return original.call(this,input,init);
    };
  })()`);
}
async function expectNoMenu(label,page=ui){
  assert.deepEqual(nativeItems(ui,candidate),[],label);
  assert.equal(await page.evaluate("!!document.querySelector('[role=menu][data-positioned]')"),false,label);
}
async function setupSsh(){
  fixtures=await createSshFixtureScope('shared-terminal-context-menu-ssh-');
  const server=await fixtures.start('ssh');
  const id=crypto.randomUUID();
  await ui.invoke('config_request',{request:{op:'save_profile',profile:{id,folder_id:null,name:'会话菜单探针',
    settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}},
    credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
  const visible="!!document.querySelector('#connection-library')?.getClientRects().length";
  if(!await ui.evaluate(visible))await ui.click('会话导航');
  await ui.waitFor(visible);
  await ui.click('刷新会话树');
  await ui.waitFor(`!!${node(treeItem)}`);
}

try {
  const baselineRoot=path.join(root,'baseline');
  ui=await launchDesktop(baselineRoot,{executable:previous,webviewDirectory:path.join(baselineRoot,'webview')});
  await showShortcuts();
  await pointer(ui,shortcut);
  const baseline=nativeItems(ui,previous);
  assert.ok(baseline.filter(item=>browserItem.test(item.name)).length>=2,JSON.stringify(baseline));
  evidence.baselineNativeItems=baseline;
  await ui.close();ui=undefined;

  const candidateRoot=path.join(root,'candidate');
  ui=await launchDesktop(candidateRoot,{executable:candidate,webviewDirectory:path.join(candidateRoot,'webview')});
  await showShortcuts();
  await trace(ui);
  const count=await ui.evaluate("document.querySelectorAll('[role=tab]').length");
  await pointer(ui,shortcut);await expectNoMenu('shortcut right click');
  await pointer(ui,sidebar+' .adb-panel-body','right',.87);await expectNoMenu('sidebar empty space');
  await ui.evaluate(`${node(shortcut)}.focus()`);
  await press(ui,'ContextMenu');await expectNoMenu('shortcut menu key');
  await press(ui,'F10');await expectNoMenu('shortcut Shift+F10');
  const traceResult=await ui.evaluate('window.menuTest');
  assert.ok(traceResult.events.filter(event=>event.type==='contextmenu'&&event.trusted).length>=2);
  for(const key of ['ContextMenu','F10'])assert.ok(traceResult.events.some(event=>event.key===key&&event.trusted));
  assert.equal(traceResult.localRuns,0);
  assert.equal(await ui.evaluate("document.querySelectorAll('[role=tab]').length"),count);
  await pointer(ui,sidebar+' .adb-row-menu-trigger','left');
  await ui.waitFor(`!!${node('.adb-row-menu[data-positioned]')}`);
  assert.ok(await ui.evaluate(`${node('.adb-row-menu')}.textContent.includes('编辑')`));
  await press(ui,'Escape');
  await ui.waitFor(`!${node('.adb-row-menu[data-positioned]')}`);
  await press(ui,'B');await ui.waitFor(`!${node(sidebar)}`);
  await press(ui,'B');await ui.waitFor(`!!${node(shortcut)}?.getClientRects().length`);
  evidence.checks.push('native browser menu positive control, no shortcut or empty sidebar menu or run, management button and Ctrl+Shift+B');

  await tool('连接配置');
  await ui.waitFor(`!!${node(nameField)}`);
  await pointer(ui,configModal+' .config-notice');await expectNoMenu('configuration dialog text');
  await ui.fill('配置名称','编辑菜单样本');
  await pointer(ui,nameField);
  const mouseEditor=nativeItems(ui,candidate);
  assert.ok(mouseEditor.some(item=>editorItem.test(item.name)),JSON.stringify(mouseEditor));
  assert.ok(mouseEditor.every(item=>editorItem.test(item.name)&&!browserItem.test(item.name)),JSON.stringify(mouseEditor));
  evidence.mouseEditorNativeItems=mouseEditor;
  const selectAll=mouseEditor.find(item=>item.enabled&&/^\s*(全选|选择全部|Select all)(?:\s|\(|$)/i.test(item.name));
  assert.ok(selectAll,JSON.stringify(mouseEditor));
  nativeItems(ui,candidate,selectAll.name);
  await ui.waitFor(`${node(nameField)}.selectionStart===0&&${node(nameField)}.selectionEnd===${node(nameField)}.value.length`);
  await ui.evaluate(`${node(nameField)}.focus()`);
  await press(ui,'ContextMenu');
  const keyboardEditor=nativeItems(ui,candidate);
  evidence.keyboardEditorEvents=(await ui.evaluate('window.menuTest.events')).slice(-5);
  assert.ok(keyboardEditor.length&&keyboardEditor.every(item=>editorItem.test(item.name)&&!browserItem.test(item.name)),JSON.stringify(keyboardEditor));
  evidence.keyboardEditorNativeItems=keyboardEditor;
  nativeItems(ui,candidate,keyboardEditor.find(item=>item.name===selectAll.name&&item.enabled).name);
  await ui.click('关闭配置');
  evidence.checks.push('modal page surface suppressed, native text-only menus by mouse and keyboard, Select All acts on the same field');

  await setupSsh();
  await pointer(ui,treeItem);
  await ui.waitFor(`!!${node('[role="menu"][aria-label="会话配置菜单"]')}`);
  assert.deepEqual(nativeItems(ui,candidate),[]);
  await ui.click('删除');
  await ui.waitFor(`!!${node('dialog:modal[aria-label="删除会话配置"]')}`);
  assert.equal(await ui.evaluate(`!!${node(configModal)}`),false);
  await ui.click('取消删除');
  await ui.evaluate(`${node(treeItem)}.focus()`);
  await press(ui,'ContextMenu');
  await ui.waitFor(`!!${node('[role="menu"][aria-label="会话配置菜单"]')}`);
  await press(ui,'Escape');
  await ui.waitFor(`!${node('[role="menu"][aria-label="会话配置菜单"]')}`);
  await ui.evaluate(`${node(treeItem)}.focus()`);
  await press(ui,'F10');
  await ui.waitFor(`!!${node('[role="menu"][aria-label="会话配置菜单"]')}`);
  await ui.click('连接');
  await ui.waitFor('document.activeElement?.textContent==="暂不连接"');
  await ui.click('指纹一致，信任并继续');
  let connection;
  for(let attempt=0;attempt<150;attempt++){
    connection=(await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
    if(connection)break;
    await delay(50);
  }
  assert.ok(connection,'synthetic SSH must connect');
  await ui.waitFor("!document.querySelector('dialog:modal')");
  const activeScreen='.pane-active .terminal > .xterm .xterm-screen';
  await pointer(ui,activeScreen);
  await ui.waitFor(`!!${node('[role="menu"][aria-label="终端日志菜单"]')}`);
  assert.deepEqual(nativeItems(ui,candidate),[]);
  await press(ui,'Escape');
  const owner=await ui.invoke('service_status');
  await detachOwnedSession(ui,{executable:candidate,serviceId:owner.service_id,
    connection:{connection_id:connection.connection_id,generation:connection.generation}});
  let target;
  for(let attempt=0;attempt<100&&!target;attempt++){
    [target]=await ui.otherPages();
    if(!target)await delay(60);
  }
  assert.ok(target);
  detached=await connectDesktopPage(target);
  await detached.waitFor(`!!${node(activeScreen)}?.getClientRects().length`);
  await trace(detached);
  await pointer(detached,'.window-title');
  await expectNoMenu('independent window title',detached);
  assert.ok((await detached.evaluate('window.menuTest.events')).some(event=>event.type==='contextmenu'&&event.trusted));
  await pointer(detached,activeScreen);
  await detached.waitFor(`!!${node('[role="menu"][aria-label="终端日志菜单"]')}`);
  assert.deepEqual(nativeItems(ui,candidate),[]);
  await press(detached,'Escape');
  evidence.checks.push('tree mouse and keyboard menu, preserved dedicated delete dialog, SSH main and detached terminal business menu');
  evidence.result='PASS';
  console.log('PASS Windows native WebView menu policy, editable items and application input routes');
}catch(error){
  evidence.result='FAIL';
  evidence.error=String(error.stack);
  await ui?.screenshot('P26.72-context-menu-failure.png').catch(()=>{});
  throw error;
}finally{
  detached?.close();await ui?.close();await fixtures?.close();
  assert.equal(path.dirname(root),temp);
  assert.ok(path.basename(root).startsWith(prefix));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  await writeFile(output,JSON.stringify({...evidence,isolatedRootRemoved:true},null,2)+'\n');
}
