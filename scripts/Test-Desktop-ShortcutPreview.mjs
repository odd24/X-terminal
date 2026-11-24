import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const version=path.basename(path.dirname(executable)).match(/^SharedTerminal-(\d+\.\d+\.\d+)-windows-x64$/)?.[1]
  ??JSON.parse(await readFile('package.json','utf8')).version;
const reportVersion=process.argv.includes('--description-candidate')?`${version}-descriptions`:version;
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-local-scripts-中文-preview-'));
const result={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),
  checks:[],screenshots:[]};
const q=JSON.stringify, node=selector=>`document.querySelector(${q(selector)})`;
const panel='.pane-active .adb-shortcut-panel:not([hidden])', card='.shortcut-preview[data-positioned]';
const dialog='dialog:modal[aria-label="命名本地脚本"]', shortcut=name=>panel+` [aria-label="${name}"]`;
const closeOption='form[aria-label="快捷指令编辑"] .shortcut-checkbox input';
const descriptionSelector='.shortcut-description';
const longDescription='长脚本说明\n第二行用于核对';
const missingDescription='原脚本说明仍可读';
const stored=()=>ui.invoke('local_adb_settings',{settings:null});
const area=name=>node(shortcut(name));
const count=()=>ui.evaluate("document.querySelectorAll('[role=tab]').length");
let ui;

async function tool(label){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(label);
}
async function key(key,vk){
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key,code:key,
    windowsVirtualKeyCode:vk,text:key==='Enter'&&type==='keyDown'?'\r':undefined});
}
async function open(){
  await ui.click('本地终端（PowerShell）');
  await ui.waitFor("!!document.querySelector('.pane-active .adb-panel-toggle')");
  if(!await ui.evaluate(`!!${node(panel)}`))await ui.click('快捷指令');
  await ui.waitFor(`!!${node(panel+' .adb-shortcut-run')}`);
}
async function stop(confirm=true){
  await tool('退出桌面');
  if(confirm){
    await ui.waitFor("!!document.querySelector('dialog[aria-label=\"退出桌面确认\"]')");
    await ui.click('确认退出并停止服务');
  }
  for(let i=0;i<200&&ui.app.exitCode===null;i++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();ui=undefined;
}
async function choose(paths){
  await ui.waitFor("document.querySelector('[aria-label=\"新建快捷指令\"]')?.disabled===false");
  await ui.click('新建快捷指令');
  await ui.waitFor("!!document.querySelector('[aria-label=\"新建指令类型\"][data-positioned]')");
  await ui.click('本地脚本');
  const output=execFileSync('pwsh',['-NoProfile','-File','scripts/lib/NativeImportDialog.ps1','-TargetProcessId',String(ui.app.pid),
    '-Root',root,'-Purpose','LocalScripts','-Action','select','-TargetsBase64',Buffer.from(JSON.stringify(paths)).toString('base64')],
  {encoding:'utf8',windowsHide:true,timeout:18000});
  assert.match(output,/PASS native LocalScripts picker/);
  await ui.waitFor(`!!${node(dialog)}`);
}
async function manage(name,action){
  await ui.click(name+' 的管理操作');
  await ui.waitFor("!!document.querySelector('.adb-row-menu[data-positioned]')");
  await ui.evaluate(`[...document.querySelectorAll('.adb-row-menu button')].find(button=>button.textContent===${q(action)}).click()`);
}
async function addCommand(menuItem,name,label,body,description){
  await ui.click('新建快捷指令');
  await ui.waitFor("!!document.querySelector('[aria-label=\"新建指令类型\"][data-positioned]')");
  await ui.click(menuItem);
  await ui.fill('指令名称',name);
  await ui.fill(label,body);
  await ui.fill('指令描述',description);
  await ui.click('保存指令');
  await ui.waitFor(`!!${area(name)}`);
  assert.equal((await stored()).shortcuts.find(item=>item.name===name).description,description);
}
async function screenshot(suffix){
  const file=`windows-${reportVersion}-shortcuts-${suffix}.png`;
  await ui.screenshot(file);result.screenshots.push(file);
}
const point=selector=>ui.evaluate(`(()=>{const r=${node(selector)}.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
const move=p=>ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
const hover=async name=>{await ui.evaluate(`${area(name)}.scrollIntoView({block:'nearest'})`);await move(await point(shortcut(name)));};
const peek=text=>ui.waitFor(`${node(card)}?.textContent.includes(${q(text)})`);
const gone=()=>ui.waitFor(`!${node('.shortcut-preview')}`);
const calls=()=>ui.evaluate('window.previewTest.calls');
const invokes=()=>ui.evaluate('window.previewTest.reads');
async function instrument(){
  await ui.evaluate(`(()=>{
    const probe=window.previewTest={calls:0,closes:0,reads:0,pending:[],hold:false};
    const fetch=window.fetch;
    window.fetch=async function(input,init){
      const name=new URL(String(input)).pathname;
      const action=name==='/local_terminal'?JSON.parse(init.body).action.kind:undefined;
      if(name==='/prepare_local_adb'||action==='open')probe.calls++;
      if(action==='close')probe.closes++;
      if(name!=='/preview_local_script')return fetch.call(this,input,init);
      probe.reads++;
      const response=await fetch.call(this,input,init);
      if(probe.hold)await new Promise(resolve=>probe.pending.push(resolve));
      return response;
    };
  })()`);
}

try{
  const runPath=path.join(root,'执行样本.cmd'),longPath=path.join(root,'长预览.bat');
  const utf16Path=path.join(root,'UTF16.cmd'),legacyPath=path.join(root,'既有脚本.cmd');
  const markerPath=path.join(root,'executed.txt'),adb=path.join(root,'adb.exe');
  const runSource='@echo off\r\necho EXECUTED_ONLY_ON_CLICK>"%~dp0executed.txt"\r\necho EXPLICIT_SHORTCUT_RUN\r\n';
  await writeFile(runPath,runSource);
  await writeFile(longPath,':: <b>合成脚本头</b>\r\n:: \u202e\r\n'+Array.from({length:1200},(_,i)=>`:: 第 ${i} 行的受控预览文本\r\n`).join('')+':: END_OUTSIDE_PREVIEW\r\n');
  await writeFile(utf16Path,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(':: UTF16 可见文本\r\n','utf16le')]));
  await writeFile(legacyPath,Buffer.from([0x3a,0x3a,0x20,0xb2,0xe2,0xca,0xd4,0x0d,0x0a]));
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:15000});
  await writeFile(path.join(root,'fixture-root.txt'),root);
  await writeFile(path.join(root,'inventory.txt'),'synthetic device product:mock\n');
  const adbRow={id:randomUUID(),name:'进入测试 Shell',command:'adb shell'};
  const old={id:randomUUID(),name:'以前的自定义名称',script_path:legacyPath,pinned:true};
  ui=await launchDesktop(root,{executable:path.resolve('artifacts/SharedTerminal-0.1.28-windows-x64/shared-terminal-desktop.exe'),webviewDirectory:path.join(root,'old-webview')});
  const seeded=await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts:[old,adbRow]}});
  await stop(false);
  ui=await launchDesktop(root,{executable});
  assert.equal((await ui.invoke('service_status')).fixture,false);
  await open();await instrument();
  assert.deepEqual(await stored(),seeded);
  assert.equal(await ui.evaluate(`!!${area(old.name)}&&!${node(panel+' .adb-shortcut-run code')}`),true);

  await choose([runPath]);await ui.fill('显示名称 执行样本.cmd','取消的名称');
  await ui.click('取消导入');assert.deepEqual(await stored(),seeded);
  await choose([runPath]);await ui.fill('显示名称 执行样本.cmd','执行验证');
  await ui.fill('描述 执行样本.cmd','执行样本的描述');
  await ui.click('确定导入');await ui.waitFor(`!!${area('执行验证')}`);
  const single=(await stored()).shortcuts.find(item=>item.name==='执行验证');
  assert.equal(single.script_path,await realpath(runPath));
  assert.equal(single.description,'执行样本的描述');
  await choose([longPath,utf16Path]);
  const fields=await ui.evaluate(`[...${node(dialog)}.querySelectorAll('input')].map(input=>input.getAttribute('aria-label'))`);
  assert.equal(fields.length,2);
  assert.equal(await ui.evaluate("document.activeElement?.getAttribute('aria-label')"),fields[0]);
  await key('Tab',9);
  assert.equal(await ui.evaluate("document.activeElement?.getAttribute('aria-label')"),fields[0].replace('显示名称 ','描述 '));
  await key('Tab',9);
  assert.equal(await ui.evaluate("document.activeElement?.getAttribute('aria-label')"),fields[1]);
  await ui.fill('显示名称 长预览.bat','查看长脚本');
  await ui.fill('描述 长预览.bat',longDescription);
  await ui.fill('描述 UTF16.cmd','   \n');
  await screenshot('01-batch-naming');
  await ui.click('确定导入');
  await ui.waitFor(`!!${area('查看长脚本')}&&!!${area('UTF16.cmd')}`);
  assert.equal((await stored()).shortcuts.find(item=>item.name==='查看长脚本').description,longDescription);
  assert.equal((await stored()).shortcuts.find(item=>item.name==='UTF16.cmd').description,undefined);
  assert.equal(await ui.evaluate(`!!${node(panel+' '+descriptionSelector)}`),false);
  assert.equal(await count(),1);assert.equal(await calls(),0);
  assert.equal(await readFile(markerPath,'utf8').catch(()=>''),'');
  await screenshot('02-names-only');
  result.checks.push('previous alias unchanged; native single cancel and confirm; one multi-file naming form with Tab, optional names and stable identity; compact list has no details');

  await manage('执行验证','编辑');
  assert.equal(await ui.evaluate(`document.querySelector('form[aria-label="快捷指令编辑"] input[readonly]').value`),single.script_path);
  assert.equal(await ui.evaluate(`${node(closeOption)}.checked`),false);
  await ui.fill('指令名称','尚未保存');
  await ui.evaluate(`${node(closeOption)}.click()`);
  const beforeConflict=await stored();
  const concurrent=await ui.invoke('local_adb_settings',{settings:{...beforeConflict,shortcuts:beforeConflict.shortcuts.map(item=>
    item.id===adbRow.id?{...item,name:'并发保留',description:'ADB 可见用途'}:
      item.id===old.id?{...item,description:missingDescription}:item)}});
  await ui.click('保存指令');await ui.waitFor("document.querySelector('.adb-panel-error')?.textContent.includes('已更新')");
  assert.deepEqual(await stored(),concurrent);
  await ui.click('重新读取快捷指令');
  await ui.click('取消编辑');
  await ui.waitFor("!!document.querySelector('dialog:modal[aria-label=更改尚未保存]')");
  await ui.click('放弃更改');
  await ui.waitFor(`!!${area('并发保留')}`);
  await manage('执行验证','编辑');
  await ui.fill('指令描述','🙂'.repeat(501));
  assert.equal(await ui.evaluate('document.querySelector(\'[aria-label="快捷指令编辑"] button[type=submit]\').disabled'),true);
  await ui.fill('指令描述','🙂'.repeat(500));
  await ui.fill('指令名称','');
  await ui.evaluate(`${node(closeOption)}.click()`);
  await ui.click('保存指令');
  await ui.waitFor(`!!${area('执行样本.cmd')}`);
  const renamed=await stored();
  assert.deepEqual(renamed.shortcuts.find(item=>item.id===single.id),{...single,name:'执行样本.cmd',
    description:'🙂'.repeat(500),close_on_success:true});
  assert.equal(await readFile(runPath,'utf8'),runSource);
  assert.equal(await calls(),0);
  result.checks.push('Edit keeps exact id/path/file, saves alias and auto-close together without execution, rejects stale save, and restores full filename when alias is cleared');

  const request=id=>({request:{id,revision:renamed.revision}});
  const uid=name=>renamed.shortcuts.find(row=>row.name===name).id;
  await assert.rejects(ui.invoke('preview_local_script',request(randomUUID())),/已登记/);
  await assert.rejects(ui.invoke('preview_local_script',request(adbRow.id)),/已登记/);
  await assert.rejects(ui.invoke('preview_local_script',{request:{...request(single.id).request,revision:seeded.revision}}),/已更新/);
  await assert.rejects(ui.invoke('preview_local_script',{request:{...request(single.id).request,path:legacyPath}}));
  const utf16=await ui.invoke('preview_local_script',request(uid('UTF16.cmd')));
  assert.equal(utf16.encoding,'UTF-16 LE');assert.match(utf16.text,/UTF16 可见文本/);
  const ansi=await ui.invoke('preview_local_script',request(old.id));
  assert.match(ansi.encoding,/^Windows CP\d+$/);
  result.ansi=ansi.encoding;
  const large=await ui.invoke('preview_local_script',request(uid('查看长脚本')));
  assert.equal(large.truncated,true);assert.ok(!large.text.includes('END_OUTSIDE_PREVIEW'));

  const initial=await invokes();
  await hover('查看长脚本');await delay(110);await move({x:16,y:500});await delay(440);
  assert.equal(await invokes(),initial);await gone();
  await hover('并发保留');await peek('adb shell');
  assert.equal(await invokes(),initial,'ADB preview uses saved command only');
  assert.equal(await ui.evaluate(`${node(card)}.querySelector(${q(descriptionSelector)}).textContent`),'ADB 可见用途');
  await screenshot('03-adb-hover');
  await hover('查看长脚本');await peek('仅显示前 32 KiB');
  assert.equal(await ui.evaluate(`(()=>{const card=${node(card)},text=card.querySelector(${q(descriptionSelector)});
    return text.textContent===${q(longDescription)}&&!!(text.compareDocumentPosition(card.querySelector('pre'))&4);})()`),true);
  assert.equal(await ui.evaluate(`${node(card)}.querySelector('strong').textContent`),'长预览.bat');
  assert.equal(await ui.evaluate(`${node(card)}.querySelector('pre b')`),null);
  assert.equal(await ui.evaluate(`${node(card)}.querySelector('pre').textContent.includes('\\\\u202e')`),true);
  const bounds=await ui.evaluate(`(()=>{
    const p=${node(panel)}.getBoundingClientRect(),c=${node(card)}.getBoundingClientRect();
    return {left:c.left,right:c.right,top:c.top,bottom:c.bottom,panelLeft:p.left,viewport:innerHeight};
  })()`);
  assert.ok(bounds.left>=7&&bounds.right<=bounds.panelLeft-6&&bounds.top>=7&&bounds.bottom<=bounds.viewport-7,JSON.stringify(bounds));
  await screenshot('04-script-hover');
  await ui.evaluate(`(() => {
    const trace=window.previewPointerTrace=[];
    for(const name of ['pointerover','pointerout','wheel','blur'])window.addEventListener(name,event=>{
      if(trace.length>=30)trace.shift();
      trace.push([name,event.target instanceof Element?event.target.closest('.shortcut-preview,.adb-shortcut-run')?.className:event.target===window?'window':null,
        event.clientX,event.clientY,document.hasFocus()]);
    },true);
  })()`);
  const inside=await point(card);
  result.scrollProbe={inside,before:await ui.evaluate(`({height:${node(card)}.clientHeight,scrollHeight:${node(card)}.scrollHeight,hit:!!document.elementFromPoint(${inside.x},${inside.y})?.closest('.shortcut-preview')})`)};
  await move(inside);await delay(245);
  result.scrollProbe.afterMove=await ui.evaluate(`!!${node(card)}`);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseWheel',...inside,deltaX:0,deltaY:470});
  await ui.waitFor(`${node(card)}?.scrollTop>0`);
  for(const type of ['mousePressed','mouseReleased'])await ui.command('Input.dispatchMouseEvent',{type,...inside,button:'left',clickCount:1});
  assert.equal(await calls(),0);assert.equal(await count(),1);
  await key('Escape',27);await gone();
  await move({x:16,y:500});await key('Tab',9);
  await ui.evaluate(`${area('UTF16.cmd')}.focus()`);
  await peek('UTF16 可见文本');
  await key('ArrowLeft',37);assert.equal(await ui.evaluate(`document.activeElement===${node(card)}`),true);
  await key('Escape',27);await gone();assert.equal(await ui.evaluate(`document.activeElement===${area('UTF16.cmd')}`),true);

  await ui.evaluate('window.previewTest.hold=true');
  await hover('查看长脚本');await ui.waitFor('window.previewTest.pending.length===1');
  await peek('正在读取脚本预览');
  await peek('第二行用于核对');
  await hover('并发保留');await peek('adb shell');
  await ui.evaluate('window.previewTest.hold=false;window.previewTest.pending.splice(0).forEach(resolve=>resolve())');
  await delay(180);assert.equal(await ui.evaluate(`${node(card)}.textContent.includes('合成脚本头')`),false);
  assert.equal(await ui.evaluate(`${node(card)}.textContent.includes(${q(longDescription)})`),false);
  await move({x:16,y:500});await gone();
  await rename(legacyPath,legacyPath+'.gone');
  await key('Tab',9);await ui.evaluate(`${area(old.name)}.focus()`);
  await peek('脚本不可用');
  await peek(missingDescription);
  await key('Escape',27);await gone();
  await rename(legacyPath+'.gone',legacyPath);
  assert.equal(await calls(),0);
  assert.equal(await readFile(path.join(root,'adb-calls.txt'),'utf8').catch(()=>''),'');
  assert.equal(await readFile(markerPath,'utf8').catch(()=>''),'');
  result.checks.push('bounded native UTF-8/UTF-16/ANSI read with id/revision and strict request; fast hover, safe text, left placement, wheel scrolling, keyboard escape, stale reply discard and missing file; opening and clicking card execute zero commands');

  await ui.click('全部展开');
  await ui.waitFor(`${node(panel)}.dataset.expanded==='true'&&!!${node(panel+' .adb-shortcut-run code')}`);
  assert.ok(await ui.evaluate(`${area('并发保留')}.querySelector('code').textContent.includes('adb shell')`));
  assert.equal(await ui.evaluate(`${area('查看长脚本')}.querySelector(${q(descriptionSelector)}).nextElementSibling.tagName`),'CODE');
  if(await ui.evaluate("document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')==='true'"))
    await ui.click('会话导航');
  await hover('并发保留');await peek('adb shell');
  assert.equal(await ui.evaluate(`(()=>{
    const preview=${node(card)},list=${node(panel+' .adb-panel-body')};
    return preview.dataset.docked==='true'&&preview.getBoundingClientRect().top>=list.getBoundingClientRect().bottom;
  })()`),true);
  await key('Escape',27);await gone();
  assert.equal(await calls(),0);
  await ui.click('收起总览');
  await ui.waitFor(`${node(panel)}.dataset.expanded==='false'`);
  await ui.click('双列显示');
  await ui.waitFor(`${node(panel)}.dataset.columns==='2'`);
  await addCommand('ADB 命令','新增 ADB 描述','完整 ADB 命令','adb version','ADB 用途');
  await addCommand('本地命令','新增本地命令描述','Windows 本地命令','echo LOCAL','本机用途\n第二行');
  await addCommand('发送到当前会话','新增发送描述','发送文本','UNSENT','会话用途');
  const persistent=await stored();
  await assert.rejects(ui.invoke('local_adb_settings',{settings:{...persistent,shortcuts:persistent.shortcuts.map(item=>
    item.id===single.id?{...item,description:'🙂'.repeat(501)}:item)}}),/500/);
  assert.deepEqual(await stored(),persistent);
  await stop();
  ui=await launchDesktop(root,{executable});await open();await instrument();
  assert.deepEqual(await stored(),persistent);
  await ui.waitFor(`!!${area('执行样本.cmd')}&&${node(panel)}.dataset.columns==='2'`);
  assert.equal(await count(),1);
  await ui.click('执行样本.cmd');
  await ui.waitFor('window.previewTest.calls===1&&window.previewTest.closes===1');
  assert.match(await readFile(markerPath,'utf8'),/EXECUTED_ONLY_ON_CLICK/);
  await ui.waitFor("document.querySelectorAll('[role=tab]').length===1");
  await stop();
  ui=await launchDesktop(root,{executable:path.resolve('artifacts/SharedTerminal-0.1.37-windows-x64/shared-terminal-desktop.exe')});
  const previous=await stored();
  assert.equal(previous.shortcuts.length,persistent.shortcuts.length);
  assert.ok(previous.shortcuts.every(item=>!('description' in item)));
  const previousEdit=await ui.invoke('local_adb_settings',{settings:{...previous,shortcuts:previous.shortcuts.map(item=>
    item.id===adbRow.id?{...item,name:'旧桌面改名'}:item)}});
  await stop(false);
  ui=await launchDesktop(root,{executable});
  const reopened=await stored();
  assert.equal(reopened.revision,previousEdit.revision);
  assert.equal(reopened.shortcuts.find(item=>item.id===adbRow.id).name,'旧桌面改名');
  assert.deepEqual(reopened.shortcuts.map(item=>[item.id,item.description]),persistent.shortcuts.map(item=>[item.id,item.description]));
  await stop(false);
  result.checks.push('multi-line descriptions, Unicode limit, per-script import, compact and expanded layout, async preview failure and switch, and real 0.1.37 rollback editing without losing descriptions');
  result.checks.push('expanded details and compact dual columns persist, configuration reopens, and one explicitly launched script exits successfully and auto-closes');
  result.result='PASS';
  console.log('PASS Windows shortcut aliases and bounded local previews, passive interaction, restart and explicit execution');
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)result.pointerTrace=await ui.evaluate('window.previewPointerTrace').catch(()=>undefined);
  if(ui)await screenshot('failure').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  await writeFile(`artifacts/windows-${reportVersion}-shortcuts-preview-result.json`,JSON.stringify(result,null,2)+'\n');
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
