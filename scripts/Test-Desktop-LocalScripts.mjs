import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const runNative=promisify(execFile);
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-local-scripts-中文-'));
const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const result={result:'IN_PROGRESS',executable,sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),checks:[]};
const sampleDir=path.join(root,'程序 & 测试');
const first=path.join(sampleDir,'测试 & ! ^ (一), 选中.cmd');
const second=path.join(sampleDir,'停止样本.bat');
const movedDir=path.join(root,'已移动');
const moved=path.join(movedDir,'移动脚本.cmd');
const firstName=path.basename(first);
const secondName=path.basename(second);
const priorImage=path.resolve('artifacts/SharedTerminal-0.1.15-windows-x64/shared-terminal-desktop.exe');
const panel='.adb-shortcut-panel:not([hidden])';
const consoleView='.local-terminal:not([hidden])';
let ui, prior;
const q=value=>JSON.stringify(value);
const text=`document.querySelector('${consoleView} .local-terminal-output')?.innerText`;
const see=marker=>ui.waitFor(`${text}?.includes(${q(marker)})`);
const focused=()=>ui.waitFor(`document.activeElement?.matches('${consoleView} .xterm-helper-textarea')`);
const picked=name=>ui.waitFor(`document.querySelector('.pane-active [role="tab"][aria-selected="true"]')?.textContent===${q(name)}`);
const tab=name=>`[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent===${q(name)})`;
const point=(element,fraction=.5)=>ui.evaluate(`(()=>{const r=(${element}).getBoundingClientRect();return{x:r.left+r.width*${fraction},y:r.top+r.height/2}})()`);
const mouse=(type,position,clickCount=1)=>ui.command('Input.dispatchMouseEvent',{
  ...position,type,button:'left',buttons:type==='mouseReleased'?0:1,clickCount,
});
const key=async(key,code,windowsVirtualKeyCode,modifiers=0)=>{
  for(const type of ['keyDown','keyUp']) await ui.command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode,modifiers});
};
const type=text=>ui.command('Input.insertText',{text});
const enter=()=>key('Enter','Enter',13);
const order=()=>ui.evaluate(`[...document.querySelectorAll('${panel} .adb-shortcut-run')].map(row=>row.getAttribute('aria-label'))`);
const execute=name=>ui.evaluate(`[...document.querySelectorAll('${panel} .adb-shortcut-run')].find(row=>row.getAttribute('aria-label')===${q(name)}).click()`);
const stored=()=>ui.invoke('local_adb_settings',{settings:null});
const existingExplorer=()=>runNative('pwsh',['-NoProfile','-Command',
  'ConvertTo-Json -Compress -InputObject @((New-Object -ComObject Shell.Application).Windows() | ForEach-Object {[string]$_.HWND})'],
  {windowsHide:true,encoding:'utf8',timeout:8000});
const scriptSource=marker=>Buffer.from([
  '@echo off',`echo ${marker}`,'cd','set /p "answer=TYPE_HERE: "', 'echo ANSWER_%answer%', 'pause','exit /b 7','',
].join('\r\n'));
async function choose(paths) {
  const args=['-NoProfile','-File','scripts/lib/NativeImportDialog.ps1','-TargetProcessId',String(ui.app.pid),'-Root',root,
    '-Purpose','LocalScripts','-Action',paths?'select':'cancel'];
  if(paths)args.push('-TargetsBase64',Buffer.from(JSON.stringify(paths)).toString('base64'));
  const native=await runNative('pwsh',args,{windowsHide:true,encoding:'utf8',timeout:18000});
  assert.match(native.stdout,/PASS native LocalScripts picker/);
}
async function addWithPicker(paths) {
  await ui.waitFor("document.querySelector('[aria-label=\"新建快捷指令\"]')?.disabled===false");
  await ui.click('新建快捷指令');
  await ui.waitFor('!!document.querySelector("[aria-label=\'新建指令类型\'][data-positioned]")');
  await ui.click('本地脚本');
  await choose(paths);
  if(paths){
    await ui.waitFor("!!document.querySelector('dialog:modal[aria-label=\"命名本地脚本\"]')");
    await ui.click('确定导入');
  }
  await ui.waitFor("document.querySelector('[aria-label=\"新建快捷指令\"]')?.disabled===false");
}
async function management(name,action) {
  await ui.click(name+' 的管理操作');
  await ui.waitFor('!!document.querySelector(".adb-row-menu[data-positioned]")');
  await ui.evaluate(`[...document.querySelectorAll('.adb-row-menu button')].find(b=>b.textContent===${q(action)}).click()`);
}
async function exit(app, confirmation) {
  await app.evaluate("document.querySelector('details.tools-menu').open=true");
  await app.click('退出桌面');
  if(confirmation){
    await app.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
    await app.click('确认退出并停止服务');
  }
  for(let n=0;n<200&&app.app.exitCode===null;n++)await delay(50);
  assert.equal(app.app.exitCode,0);
  await app.close();
}
async function open() {
  await ui.click('本地终端（PowerShell）');
  await focused();
  await ui.waitFor(`/PS [^\\n]+>\\s*$/.test(${text}??'')`);
  if(!await ui.evaluate(`!!document.querySelector('${panel}')`))await ui.click('快捷指令');
  await ui.waitFor(`!!document.querySelector('${panel} .adb-shortcut-run')`);
}
try {
  await mkdir(sampleDir);await mkdir(movedDir);
  await writeFile(first,scriptSource('SCRIPT_ORIGINAL'));
  await writeFile(second,Buffer.from('@echo off\r\necho RUNNING_BATCH\r\nping -n 16 127.0.0.1 >nul\r\necho SHOULD_NOT_REACH\r\n'));
  const adb=path.join(root,'adb.exe');
  await runNative('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,timeout:12000});
  await writeFile(path.join(root,'fixture-root.txt'),await realpath(root));
  await writeFile(path.join(root,'inventory.txt'),'mock       device product:fixture\n');
  prior=await launchDesktop(root,{executable:priorImage,webviewDirectory:path.join(root,'prior-webview')});
  const legacy={id:crypto.randomUUID(),name:'原有 ADB 指令',command:'adb shell'};
  const legacySettings=await prior.invoke('local_adb_settings',{settings:{revision:null,executable:await realpath(adb),shortcuts:[legacy]}});
  await exit(prior,false);prior=undefined;
  ui=await launchDesktop(root,{executable});
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.empty-actions button')].map(b=>b.textContent)"),
    ['新建 SSH','新建串口','本地终端（PowerShell）']);
  await open();
  await ui.evaluate("document.querySelector('.new-menu').open=true");
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.new-menu button')].map(b=>b.textContent)"),
    ['本地终端','SSH 连接','串口连接']);
  await ui.evaluate("document.querySelector('.new-menu').open=false");
  await addWithPicker();
  assert.deepEqual((await stored()).shortcuts,[legacy]);
  await addWithPicker([first,second]);
  await ui.waitFor(`document.querySelectorAll('${panel} .adb-shortcut-run').length===3`);
  const imported=await stored();
  assert.deepEqual(imported.shortcuts[0],legacy);
  assert.equal(imported.executable,legacySettings.executable);
  assert.deepEqual(new Set(imported.shortcuts.slice(1).map(item=>item.script_path)),
    new Set([await realpath(first),await realpath(second)]));
  assert.equal(await ui.evaluate("document.querySelectorAll('.local-terminal').length"),1);
  result.checks.push('native cancel, native multi-select, no execution on import, old ADB record preserved');
  await ui.click('原有 ADB 指令 的管理操作');
  await ui.waitFor('!!document.querySelector(".adb-row-menu[data-positioned]")');
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.adb-row-menu button')].some(button=>button.textContent==='打开文件所在位置')"),false);
  await key('Escape','Escape',27);
  const chosen=imported.shortcuts.find(item=>item.name===firstName);
  const request={id:chosen.id,revision:imported.revision};
  await assert.rejects(ui.invoke('reveal_local_script',{request:{...request,id:legacy.id}}),/已登记/);
  await assert.rejects(ui.invoke('reveal_local_script',{request:{...request,revision:legacySettings.revision}}),/已更新/);
  await assert.rejects(ui.invoke('reveal_local_script',{request:{...request,path:first}}));
  const windows=await existingExplorer();
  await management(firstName,'打开文件所在位置');
  const selected=await runNative('pwsh',['-NoProfile','-File','scripts/lib/ObserveLogShell.ps1','-Root',root,
    '-TargetPath',first,'-Action','script-file','-ExistingExplorerWindows',windows.stdout.trim()],
    {windowsHide:true,encoding:'utf8',timeout:16000});
  assert.match(selected.stdout,/PASS exact owned script selection/);
  assert.equal(await ui.evaluate("document.querySelectorAll('.local-terminal').length"),1);
  assert.deepEqual(await stored(),imported);
  assert.deepEqual(await readFile(first),scriptSource('SCRIPT_ORIGINAL'));
  result.checks.push('Explorer selected the exact registered Chinese script with spaces and a comma; management click and rejected requests did not start a script or change settings');
  await exit(ui,true);
  ui=await launchDesktop(root,{executable});
  await open();
  assert.deepEqual(await stored(),imported);
  const draftFile=path.join(root,'draft.txt');
  await focused();
  await type(`Set-Content -LiteralPath '${draftFile.replaceAll("'","''")}' 'draft-preserved'`);
  await execute(firstName);await picked(firstName);await focused();await see('SCRIPT_ORIGINAL');
  const note=await ui.evaluate("document.querySelector('.local-terminal:not([hidden]) .local-script-info span').title");
  assert.equal(note,await realpath(sampleDir));
  await see('TYPE_HERE:');
  const scriptTab=tab(firstName);
  const scriptId=await ui.evaluate(`${scriptTab}.dataset.connectionId`);
  const start=await point(scriptTab);
  const before=await point(tab('本地 1'),.1);
  await mouse('mousePressed',start);
  await mouse('mouseMoved',before);
  await ui.waitFor(`!!document.querySelector('[data-insertion="before"]')`);
  await mouse('mouseReleased',before);
  await ui.waitFor(`${scriptTab}.closest('.connection-tab').nextElementSibling?.querySelector('[role=tab]')===${tab('本地 1')}`);
  const at=await point(scriptTab);
  for(const clicks of [1,2]){
    await mouse('mousePressed',at,clicks);
    await mouse('mouseReleased',at,clicks);
  }
  await picked(firstName);await focused();await see('TYPE_HERE:');
  assert.equal(await ui.evaluate(`${scriptTab}.dataset.connectionId`),scriptId);
  assert.equal(await ui.evaluate("document.querySelectorAll('[role=tab]').length"),2);
  result.checks.push('script tab moves in the rail and double-click preserves the original foreground session and tab count');
  assert.ok((await ui.evaluate(text)).replace(/\r?\n/g,'').includes(note));
  const existing=await existingExplorer();
  await ui.click('打开工作目录');
  const opened=await runNative('pwsh',['-NoProfile','-File','scripts/lib/ObserveLogShell.ps1','-Root',root,
    '-TargetPath',sampleDir,'-Action','script-directory','-ExistingExplorerWindows',existing.stdout.trim()],
    {windowsHide:true,encoding:'utf8',timeout:16000});
  assert.match(opened.stdout,/PASS exact owned test directory/);
  await ui.evaluate("document.querySelector('.local-terminal:not([hidden]) .xterm-helper-textarea').focus()");
  await type('hello');await enter();await see('ANSWER_hello');
  await key('x','KeyX',88);await see('前台进程退出（7）');
  await ui.screenshot('windows-0.1.16-local-script.png');
  await ui.click('本地 1');await picked('本地 1');await focused();await enter();
  for(let n=0;n<100&&!(await readFile(draftFile,'utf8').catch(()=>'' )).includes('draft-preserved');n++)await delay(50);
  assert.match(await readFile(draftFile,'utf8'),/draft-preserved/);
  result.checks.push('special and Chinese path, exact working directory, direct input, pause, exit 7, original PowerShell draft');
  await writeFile(first,scriptSource('SCRIPT_UPDATED'));
  await execute(firstName);await picked(firstName);await focused();await see('SCRIPT_UPDATED');
  await type('updated');await enter();await see('ANSWER_updated');await key('x','KeyX',88);await see('前台进程退出（7）');
  await execute(secondName);await picked(secondName);await focused();await see('RUNNING_BATCH');
  await key('c','KeyC',67,2);
  await delay(350);
  if(await ui.evaluate(`document.querySelector('${consoleView}')?.dataset.foreground==='true'`)){
    await type('y');await enter();
  }
  await ui.waitFor(`document.querySelector('${consoleView}')?.dataset.foreground==='false'`);
  assert.equal((await ui.evaluate(text)).includes('SHOULD_NOT_REACH'),false);
  await rename(first,moved);
  await management(firstName,'打开文件所在位置');
  await ui.waitFor("document.querySelector('.adb-panel-error')?.textContent.includes('重新定位')");
  await execute(firstName);
  await ui.waitFor("document.body.innerText.includes('脚本不可用')");
  await management(firstName,'重新定位');await choose([moved]);
  await ui.waitFor(`(async()=> (await window.__TAURI_INTERNALS__.invoke('local_adb_settings',{settings:null})).shortcuts.some(item=>item.script_path===${q(await realpath(moved))}))()`);
  await management(firstName,'编辑');await ui.fill('指令名称','重新定位样本');await ui.click('保存指令');
  await ui.waitFor(`!!document.querySelector('${panel} .adb-shortcut-run[aria-label="重新定位样本"]')`);
  const beforeMove=await order();
  const shift=beforeMove.indexOf('重新定位样本')===1?'上移':'下移';
  await management('重新定位样本',shift);
  await ui.waitFor(`JSON.stringify([...document.querySelectorAll('${panel} .adb-shortcut-run')].map(row=>row.getAttribute('aria-label'))) !== ${q(JSON.stringify(beforeMove))}`);
  await ui.click('本地 1');await picked('本地 1');
  await execute('原有 ADB 指令');await picked('本地 2');await focused();await see('ADB_FIXTURE_FOREGROUND');
  await execute('重新定位样本');await picked('重新定位样本');await see('SCRIPT_UPDATED');
  await ui.click('本地 2');await picked('本地 2');await focused();await type('continuation');await enter();
  await see('ADB_FIXTURE_ECHO:continuation');
  result.checks.push('original simulated ADB shell accepts input after launching a script');
  await management('重新定位样本','删除');
  await ui.waitFor(`document.querySelectorAll('${panel} .adb-shortcut-run').length===2`);
  assert.match(await readFile(moved,'utf8'),/SCRIPT_UPDATED/);
  assert.match(await readFile(second,'utf8'),/RUNNING_BATCH/);
  result.checks.push('latest file on click, Ctrl+C stops batch, missing path reported, native relocation, rename/order/delete preserve files');
  await exit(ui,true);ui=undefined;
  prior=await launchDesktop(root,{executable:priorImage,webviewDirectory:path.join(root,'prior-webview')});
  assert.deepEqual(await prior.invoke('local_adb_settings',{settings:null}),legacySettings);
  await exit(prior,false);prior=undefined;
  result.result='PASS';
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui){result.window=await ui.evaluate('document.body.innerText').catch(String);await ui.screenshot('windows-0.1.16-local-script-failure.png').catch(()=>{});}
  throw error;
}finally{
  await writeFile('artifacts/local-scripts-software-result.json',JSON.stringify(result,null,2));
  await ui?.close();await prior?.close();
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
