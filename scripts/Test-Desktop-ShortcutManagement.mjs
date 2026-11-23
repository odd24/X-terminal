import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const previous=path.resolve('artifacts/SharedTerminal-0.1.19-windows-x64/shared-terminal-desktop.exe');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-shortcut-management-中文-'));
const result={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),
  checks:[],screenshots:[],measurements:{}};
const q=JSON.stringify;
const panel='.pane-active .adb-shortcut-panel:not([hidden])';
const body=panel+' .adb-panel-body';
const modal='dialog:modal[aria-label="移除快捷指令"]';
const query=css=>`document.querySelector(${q(css)})`;
const row=item=>query(panel+` [data-shortcut-id="${item.id}"]`);
const handle=item=>query(panel+` [data-sort-handle="${item.id}"]`);
const ids=rows=>rows.map(item=>item.id);
const names=items=>items.map(item=>item.name);
const settings=()=>ui.invoke('local_adb_settings',{settings:null});
let ui;

async function tool(name){
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click(name);
}
async function stop(confirm){
  await tool('退出桌面');
  if(confirm){
    await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
    await ui.click('确认退出并停止服务');
  }
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();ui=undefined;
}
async function openPanel(){
  await ui.waitFor("!!document.querySelector('.pane-active .adb-panel-toggle')");
  if(!await ui.evaluate(`!!${query(panel)}`))await ui.evaluate("document.querySelector('.pane-active .adb-panel-toggle').click()");
  await ui.waitFor(`!!${query(panel+' .adb-shortcut-run')}`);
}
async function openLocal(){
  await tool('轻量命令行');
  await ui.waitFor("document.activeElement?.matches('.pane-active .local-terminal:not([hidden]) .xterm-helper-textarea')");
}
async function selected(expected,total){
  await ui.waitFor(`${query(panel+' [aria-label="已选指令"]')}?.textContent===${q(`已选 ${expected} / ${total}`)}`);
}
async function checked(...items){
  for(const item of items){
    await ui.evaluate(`${row(item)}.querySelector('input').click()`);
  }
}
function storageOrder(expected){
  return ui.waitFor(`JSON.stringify([...document.querySelectorAll(${q(panel+' [data-shortcut-id]')})].map(row=>row.dataset.shortcutId))===${q(JSON.stringify(ids(expected)))}`);
}
const saved=message=>ui.waitFor(`${query(panel+' .adb-panel-footer [role="status"]')}?.textContent===${q(message)}`);
async function columns(count){
  await ui.waitFor(`${query(panel)}?.dataset.columns===${q(String(count))}`);
  const computed=await ui.evaluate(`getComputedStyle(${query(panel+' .adb-shortcut-list')}).gridTemplateColumns`);
  assert.equal(computed.split(' ').length,count);
}
const coordinates=(expression,x=.5,y=.5)=>ui.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`);
async function pointerDrag(from,to,preview,cancel=false){
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
  await ui.waitFor(preview);
  if(cancel)await key('Escape',27);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
}
async function key(key,windowsVirtualKeyCode){
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode});
}
async function clickAt(expression){
  await ui.evaluate(`${expression}.scrollIntoView({block:'nearest',inline:'nearest'})`);
  const point=await coordinates(expression);
  assert.equal(await ui.evaluate(`${expression}.contains(document.elementFromPoint(${point.x},${point.y}))`),true);
  for(const type of ['mousePressed','mouseReleased'])await ui.command('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
}
const edgeTrigger=item=>`${row(item)}.querySelector('.adb-row-menu-trigger')`;
const edgeMenu=item=>query(`[aria-label="${item.name} 的管理菜单"]`);
const edgeItem=(item,label)=>`[...${edgeMenu(item)}.querySelectorAll('button')].find(b=>b.textContent===${q(label)})`;
async function openEdges(item){
  await clickAt(edgeTrigger(item));
  await ui.waitFor(`!!${edgeMenu(item)}?.dataset.positioned`);
}
async function moveEdge(item,label,expected){
  await openEdges(item);
  assert.equal(await ui.evaluate(`${edgeItem(item,label)}.disabled`),false);
  await clickAt(edgeItem(item,label));
  await storageOrder(expected);await saved('顺序已保存');
  await ui.waitFor(`document.activeElement===${edgeTrigger(item)}`);
  assert.deepEqual(ids((await settings()).shortcuts),ids(expected));
}
async function sort(source,target,isHorizontal,after,cancel=false){
  const from=await coordinates(handle(source));
  const to=await coordinates(row(target),isHorizontal?(after ? .82 : .23):.5,isHorizontal ? .5 : (after ? .76 : .23));
  const hint=`${row(target)}?.dataset.drop===${q(after?'after':'before')}`;
  await pointerDrag(from,to,`${hint}&&(${row(target)}.dataset.dropHorizontal==='true')===${isHorizontal}`,cancel);
  await ui.waitFor(`!${query(panel+' [data-drop]')}`);
}
const layout=(columns,expanded)=>ui.waitFor(`${query(panel)}?.dataset.columns===${q(String(columns))}&&${query(panel)}.dataset.expanded===${q(String(expanded))}`);
async function screenshot(name){
  await ui.screenshot(name);
  result.screenshots.push(name);
}
function onDisk(adb){
  return Promise.all([readFile(adb,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return '';}),
    readFile(path.join(root,'script-executed.txt'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return '';})]);
}
async function resize(width,height){
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),
    '-ExpectedExecutable',executable,'-Width',String(width),'-Height',String(height)],{windowsHide:true,timeout:12000});
  await ui.waitFor(`Math.abs(innerWidth-${width})<=24`);
}
async function openRemoval(count){
  await ui.click('移除所选');
  await ui.waitFor(`${query(modal)}?.textContent.includes(${q(`移除 ${count} 条快捷入口`)})`);
  assert.equal(await ui.evaluate("document.activeElement?.textContent"),'取消移除');
}

try{
  const adb=path.join(root,'adb.exe');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:12000});
  await writeFile(path.join(root,'fixture-root.txt'),root);
  await writeFile(path.join(root,'inventory.txt'),'mock  device product:synthetic\n');
  const directory=path.join(root,'脚本 路径 '.repeat(7).trimEnd());await mkdir(directory);
  const script=path.join(directory,'批处理样本.cmd');
  const scriptBytes=Buffer.from('@echo off\r\necho mark>"%~dp0..\\script-executed.txt"\r\n');
  await writeFile(script,scriptBytes);
  const retained=path.join(directory,'长路径批处理保留.bat');
  await writeFile(retained,scriptBytes);
  const adbLog=path.join(root,'adb-calls.txt');
  const long='adb shell echo "'+'包含中文与空格的合成参数 '.repeat(16)+'命令结尾"';
  const legacy=Array.from({length:32},(_,i)=>({id:crypto.randomUUID(),name:`指令 ${String(i+1).padStart(2,'0')}`,command:'adb devices -l'}));
  const [a,b,c,d,e,f,g,...rest]=legacy;
  delete b.command;b.script_path=await realpath(script);b.name='批处理样本';
  delete f.command;f.script_path=await realpath(retained);f.name='长路径批处理';
  c.command=long;
  ui=await launchDesktop(root,{executable:previous,webviewDirectory:path.join(root,'old-webview')});
  const old=await ui.invoke('local_adb_settings',{settings:{revision:null,executable:await realpath(adb),shortcuts:legacy}});
  await stop(false);

  ui=await launchDesktop(root,{executable});
  await openLocal();await openPanel();
  assert.deepEqual(await settings(),old);
  await columns(1);await storageOrder(legacy);
  result.measurements.compact=await ui.evaluate(`(()=>{const row=${row(c)},code=row.querySelector('code');return {cssPixels:row.getBoundingClientRect().height,truncated:code.scrollWidth>code.clientWidth};})()`);
  assert.ok(result.measurements.compact.cssPixels<45&&result.measurements.compact.truncated,JSON.stringify(result.measurements.compact));
  result.checks.push('0.1.19 mixed 32-item settings load exactly; compact single-column rows and clipped commands');

  await ui.click('管理');await checked(a,b,c);await ui.click('置顶');await saved('已置顶');
  await ui.click('完成管理');
  await ui.waitFor(`${row(a)}?.dataset.pinned==='true'`);
  await moveEdge(b,'移到最前',[b,a,c,d,e,f,g,...rest]);
  await openEdges(b);
  assert.equal(await ui.evaluate(`${edgeItem(b,'移到最前')}.disabled`),true);
  await screenshot('windows-0.1.26-shortcuts-pinned-first.png');
  await key('Escape',27);
  await moveEdge(a,'移到最后',[b,c,a,d,e,f,g,...rest]);
  await openEdges(a);
  assert.equal(await ui.evaluate(`${edgeItem(a,'移到最后')}.disabled`),true);
  await key('Escape',27);
  await ui.click('双列显示');await columns(2);
  await moveEdge(f,'移到最前',[b,c,a,f,d,e,g,...rest]);
  await moveEdge(d,'移到最后',[b,c,a,f,e,g,...rest,d]);
  await openEdges(d);
  assert.equal(await ui.evaluate(`${edgeItem(d,'移到最后')}.disabled`),true);
  await screenshot('windows-0.1.26-shortcuts-regular-last.png');
  const oldEdge=await settings();
  const concurrentName={...g,name:'并发改名保留'};
  const external=await ui.invoke('local_adb_settings',{settings:{...oldEdge,shortcuts:oldEdge.shortcuts.map(item=>item.id===g.id?concurrentName:item)}});
  await clickAt(edgeItem(d,'移到最前'));
  await ui.waitFor(`${query(panel+' .adb-panel-error')}?.textContent.includes('已更新')`);
  assert.deepEqual(await settings(),external);
  await storageOrder([b,c,a,f,e,g,...rest,d]);
  await ui.click('重新读取快捷指令');
  await ui.waitFor(`${row(g)}.textContent.includes(${q(concurrentName.name)})`);
  const persisted=[b,c,a,d,f,e,concurrentName,...rest];
  await moveEdge(d,'移到最前',persisted);
  const finalEdge=await settings();
  await stop(true);
  ui=await launchDesktop(root,{executable});
  await openLocal();await openPanel();await columns(2);await storageOrder(persisted);
  assert.deepEqual(await settings(),finalEdge);
  assert.deepEqual((await settings()).shortcuts.filter(item=>item.pinned).map(item=>item.id),ids([b,c,a]));
  assert.deepEqual(await onDisk(adbLog),['','']);
  assert.deepEqual(await readFile(script),scriptBytes);
  assert.deepEqual(await readFile(retained),scriptBytes);
  result.checks.push('row menu first and last preserve both regions and stable peer order for ADB, BAT and CMD; disabled edges, single and dual columns, stale CAS rejection, explicit refresh and restart, zero command or script execution');
  await ui.invoke('local_adb_settings',{settings:{...old,revision:finalEdge.revision}});
  await stop(true);
  ui=await launchDesktop(root,{executable});
  await openLocal();await openPanel();await columns(1);await storageOrder(legacy);

  await ui.click('管理');await selected(0,32);
  await ui.click('全选');await selected(32,32);
  await ui.click('清除');await selected(0,32);
  assert.equal(await ui.evaluate(`document.querySelectorAll(${q(panel+' .adb-shortcut-run')}).length`),0);
  await sort(c,a,false,false,true);await storageOrder(legacy);
  await sort(c,a,false,false);await saved('顺序已保存');
  await storageOrder([c,a,b,d,e,f,g,...rest]);
  await ui.waitFor(`document.activeElement===${handle(c)}`);
  await key('ArrowDown',40);
  await storageOrder([a,c,b,d,e,f,g,...rest]);
  await ui.waitFor(`document.activeElement===${handle(c)}`);

  await ui.click('双列显示');await columns(2);
  assert.ok(await ui.evaluate(`${row(a)}.getBoundingClientRect().top<${row(d)}.getBoundingClientRect().top`));
  await sort(a,d,true,true);await storageOrder([c,b,d,a,e,f,g,...rest]);
  await checked(c,d);await selected(2,32);
  await ui.click('置顶');await saved('已置顶');
  await storageOrder([c,d,b,a,e,f,g,...rest]);
  await ui.click('清除');await checked(a,e);await selected(2,32);
  await ui.click('下移');await storageOrder([c,d,b,f,a,e,g,...rest]);
  await sort(a,g,true,true);await storageOrder([c,d,b,f,g,a,e,...rest]);
  await ui.click('清除');await checked(c,d);
  await ui.click('取消置顶');await storageOrder([b,f,g,a,e,...rest,c,d]);
  await ui.click('置顶');await storageOrder([c,d,b,f,g,a,e,...rest]);
  await saved('已置顶');
  await screenshot('windows-0.1.20-shortcuts-bulk.png');
  result.checks.push('actual pointer reorder in one column, Escape cancellation, keyboard focus, cross-row dual column drop, stable batch reorder and pin/unpin');

  await ui.click('清除');await checked(b,d);await openRemoval(2);
  const before=await settings();
  await ui.click('取消移除');
  assert.deepEqual(await settings(),before);
  await openRemoval(2);
  const replacement={...rest[rest.length-1],name:'并发修改保留'};
  const concurrent=await ui.invoke('local_adb_settings',{settings:{...before,shortcuts:before.shortcuts.map(item=>item.id===replacement.id?replacement:item)}});
  await ui.click('确认移除 2 条');
  await ui.waitFor(`${query(modal+' [role="alert"]')}?.textContent.includes('已更新')`);
  assert.deepEqual(await settings(),concurrent);
  await storageOrder([c,d,b,f,g,a,e,...rest]);
  await ui.click('取消移除');
  await ui.click('重新读取快捷指令');
  await ui.waitFor(`${row(replacement)}?.textContent.includes(${q(replacement.name)})`);
  await openRemoval(2);await ui.click('确认移除 2 条');
  await ui.waitFor(`!${query(modal)}`);
  await saved('已移除 2 条入口');await selected(0,30);
  let savedState=await settings();
  assert.deepEqual(ids(savedState.shortcuts),[c,f,g,a,e,...rest].map(item=>item.id));
  assert.deepEqual(await readFile(script),scriptBytes);
  assert.deepEqual(await onDisk(adbLog),['','']);
  result.checks.push('cancelled and stale confirmation left originals intact; exact two deleted, concurrent rename survived, script file preserved and all management did zero executions');

  await ui.click('完成管理');await ui.click('全部展开');await layout(2,true);
  assert.ok(await ui.evaluate(`(()=>{
    const p=${query(panel)},r=p.getBoundingClientRect(),b=p.parentElement.getBoundingClientRect();
    const command=${row(c)}.querySelector('code'),script=${row(f)}.querySelector('code');
    return Math.abs(r.width-b.width)<2&&command.textContent.endsWith('命令结尾"')&&script.textContent.endsWith(${q(f.script_path)})
      &&[command,script].every(code=>code.scrollWidth<=code.clientWidth+1&&getComputedStyle(code).whiteSpace==='pre-wrap');
  })()`));
  await screenshot('windows-0.1.20-shortcuts-expanded.png');
  await resize(690,520);
  await ui.evaluate(`${row(replacement)}.querySelector('.adb-shortcut-run').focus()`);
  await ui.waitFor(`${query(body)}.scrollTop>0&&document.activeElement===${row(replacement)}.querySelector('.adb-shortcut-run')`);
  await ui.click('收起总览');await layout(2,false);
  await ui.click('全部展开');await layout(2,true);
  await openLocal();
  const source=await ui.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='本地 2').getBoundingClientRect().toJSON()");
  const to=await coordinates(query('.pane-active .local-pane-body'),.85,.5);
  await pointerDrag({x:source.left+source.width/2,y:source.top+source.height/2},to,"!!document.querySelector('.tab-split-preview[data-edge=right]')");
  await ui.waitFor("document.querySelectorAll('[data-pane]').length===2");
  await ui.waitFor("document.querySelector('.pane-active [role=tab][aria-selected=true]')?.textContent==='本地 2'");
  await openPanel();
  result.measurements.narrowSplit=await ui.evaluate(`(()=>{
    const p=${query(panel)},r=p.getBoundingClientRect(),b=p.parentElement.getBoundingClientRect();
    return {paneWidth:b.width,panelWidth:r.width,overflow:p.scrollWidth-p.clientWidth,columns:getComputedStyle(p.querySelector('.adb-shortcut-list')).gridTemplateColumns.split(' ').length};
  })()`);
  const split=result.measurements.narrowSplit;
  assert.ok(Math.abs(split.panelWidth-split.paneWidth)<2&&split.paneWidth<270&&split.overflow<=1&&split.columns===1,JSON.stringify(split));
  await screenshot('windows-0.1.20-shortcuts-split.png');
  await stop(true);

  ui=await launchDesktop(root,{executable});
  await openLocal();await openPanel();await layout(2,true);
  savedState=await settings();
  assert.deepEqual(savedState.layout,{columns:2,expanded:true});
  assert.deepEqual(names(savedState.shortcuts.filter(item=>item.pinned)),[c.name]);
  await ui.evaluate(`${row(a)}.scrollIntoView({block:'nearest'})`);
  const click=await coordinates(`${row(a)}.querySelector('.adb-shortcut-run')`);
  for(const type of ['mousePressed','mouseReleased'])await ui.command('Input.dispatchMouseEvent',{type,...click,button:'left',clickCount:1});
  await ui.waitFor("document.querySelector('.pane-active .local-terminal:not([hidden])')?.innerText.includes('List of devices attached')");
  const [ran,scriptRun]=await onDisk(adbLog);
  assert.equal(ran.trim().split(/\r?\n/).length,1);assert.match(ran,/^devices\|/);
  assert.equal(scriptRun,'');
  await stop(true);
  result.checks.push('full pane overview wraps long content, scrolls and keeps focus for 30 items, fits a narrow split, collapses in one action, persists layout and pins after restart, and daily click executes exactly once');
  result.result='PASS';
  console.log('PASS native Windows shortcut management, CAS, migration, compact layouts and mixed entry integrity');
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)await ui.screenshot('windows-0.1.20-shortcuts-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  await writeFile('artifacts/shortcut-management-software-result.json',JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
