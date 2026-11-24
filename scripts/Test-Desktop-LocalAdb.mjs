import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop, delay} from './lib/DesktopHarness.mjs';

const root = await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-adb-ui-中文-'));
const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const adb = path.join(root,'adb.exe');
const workspace = path.join(root,'工作 目录');
const inventory = path.join(workspace,'inventory.txt');
const calls = path.join(workspace,'adb-calls.txt');
const prompt = '.local-terminal:not([hidden])[data-foreground="false"] .xterm-helper-textarea';
const output = '.local-terminal:not([hidden]) .local-terminal-output';
const panel = '.adb-shortcut-panel:not([hidden])';
const rows = () => ui.evaluate(`Array.from(document.querySelectorAll('${panel} .adb-shortcut-run')).map(row=>row.getAttribute('aria-label'))`);
const key = async (key, code, windowsVirtualKeyCode, modifiers=0) => {
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers});
};
let ui;
const evidence = {result:'IN_PROGRESS', executable:executable??path.resolve('target/debug/shared-terminal-desktop.exe'), cases:[]};
const idle = () => ui.waitFor(`document.activeElement?.matches(${JSON.stringify(prompt)})`);
const text = () => ui.evaluate(`document.querySelector(${JSON.stringify(output)})?.innerText`);
const show = value => ui.waitFor(`document.querySelector('.local-terminal:not([hidden])')?.innerText.includes(${JSON.stringify(value)})`);
const log = async () => (await readFile(calls,'utf8').catch(()=> '')).trim().split(/\r?\n/).filter(Boolean);
const actions = async () => (await log()).filter(line=>line.startsWith('pull|'));
const setInventory = (...lines) => writeFile(inventory,lines.map(line=>line+'\n').join(''));
const selected = name => ui.waitFor(`document.querySelector('.pane-active [role="tab"][aria-selected="true"]')?.textContent===${JSON.stringify(name)}`);
async function exported(name) {
  for(let attempt=0;attempt<120;attempt++){
    const bytes=await readFile(path.join(workspace,name),'utf8').catch(()=>null);
    if(bytes==='observed fixture download')return;
    await delay(50);
  }
  assert.fail('missing exact output from current ADB invocation: '+name);
}
async function run(line) {
  await idle();
  await ui.command('Input.insertText',{text:line});
  await ui.waitFor(`document.querySelector(${JSON.stringify(output)})?.innerText.trimEnd().endsWith(${JSON.stringify(line.slice(-12))})`);
  await key('Enter','Enter',13);
}
async function openLocal() {
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click('轻量命令行');
  await idle();
  await run('cd "'+workspace+'"');
  await ui.waitFor(`document.querySelector(${JSON.stringify(output)})?.title===${JSON.stringify(workspace)}`);
}
async function openPanel() {
  if(!await ui.evaluate(`!!document.querySelector('${panel}')`))await ui.click('快捷指令');
  await ui.waitFor(`!!document.querySelector('${panel}')`);
}
async function saveEditor(action='保存指令') {
  await ui.click(action);
  await ui.waitFor(`!document.querySelector('${panel} form')`);
}
async function addShortcut(name,command,action='新建快捷指令') {
  await ui.click(action);
  await ui.click('ADB 命令');
  await ui.fill('指令名称',name);
  await ui.fill('完整 ADB 命令',command);
  await saveEditor();
}
async function manage(name,action) {
  await ui.click(name+' 的管理操作');
  await ui.waitFor('!!document.querySelector(".adb-row-menu[data-positioned]")');
  await ui.evaluate(`Array.from(document.querySelectorAll('.adb-row-menu button')).find(button=>button.textContent===${JSON.stringify(action)}).click()`);
}
async function controlledExit() {
  await ui.evaluate("document.querySelector('details.tools-menu summary').click()");
  await ui.click('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
}
async function setOptions() {
  await ui.click('ADB 设置');
  await ui.fill('ADB 程序路径',adb);
  await saveEditor('保存 ADB 设置');
  await addShortcut('设备列表','adb devices -l','添加第一条指令');
  await addShortcut('导出样本','adb pull "/sdcard/a b" "./导出 文件.txt"');
}

try {
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,stdio:'inherit'});
  await mkdir(workspace);
  await setInventory('good       device product:fixture');
  const originalEnv = process.env.ANDROID_SERIAL;
  delete process.env.ANDROID_SERIAL;
  try {ui=await launchDesktop(root,{executable});}
  finally {if(originalEnv!==undefined)process.env.ANDROID_SERIAL=originalEnv;}
  await openLocal();
  assert.equal(await ui.evaluate('document.querySelector(".adb-panel-toggle").getAttribute("aria-expanded")'),'false');
  await openPanel();
  await ui.waitFor(`Array.from(document.querySelectorAll('${panel} button')).some(item=>item.textContent==='添加第一条指令')`);
  await setOptions();
  assert.deepEqual(await log(),[],'created and saved settings do not invoke adb');
  const row = await ui.evaluate(`document.querySelector('.adb-shortcut-run[aria-label="设备列表"]').getBoundingClientRect().toJSON()`);
  const click = {button:'left',x:row.right-10,y:row.top+row.height/2,clickCount:1};
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...click});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...click});
  await show('List of devices attached');
  await idle();
  assert.equal((await log()).length,1);
  await addShortcut('临时指令','adb devices -l');
  await manage('临时指令','上移');
  await ui.waitFor(`document.querySelectorAll('${panel} .adb-shortcut-run')[1]?.getAttribute('aria-label')==='临时指令'`);
  await manage('临时指令','下移');
  await ui.waitFor(`document.querySelectorAll('${panel} .adb-shortcut-run')[2]?.getAttribute('aria-label')==='临时指令'`);
  await manage('临时指令','编辑');
  await ui.fill('指令名称','取消的更改');
  await ui.click('取消编辑');
  await ui.waitFor("!!document.querySelector('dialog:modal[aria-label=更改尚未保存]')");
  await ui.click('放弃更改');
  assert.deepEqual(await rows(),['设备列表','导出样本','临时指令']);
  await manage('临时指令','删除');
  await ui.waitFor(`document.querySelectorAll('${panel} .adb-shortcut-run').length===2`);
  assert.equal((await log()).length,1,'edit, cancel, move and delete must not invoke adb');
  evidence.cases.push('initially collapsed, row hit executes once, management and settings do not invoke adb');
  await controlledExit();
  delete process.env.ANDROID_SERIAL;
  try {ui=await launchDesktop(root,{executable});}
  finally {if(originalEnv!==undefined)process.env.ANDROID_SERIAL=originalEnv;}
  await openLocal();
  assert.equal((await log()).length,1,'opening does not execute saved button');
  await ui.waitFor(`!!document.querySelector('${panel} .adb-shortcut-run[aria-label="导出样本"]')`);
  assert.equal(await ui.evaluate('document.querySelector(".adb-panel-toggle").getAttribute("aria-expanded")'),'true');
  await ui.click('导出样本');
  await show('ADB_FIXTURE_PULLED');
  await exported('导出 文件.txt');
  assert.equal((await actions()).at(-1),'pull|good|-s|good|pull|/sdcard/a b|./导出 文件.txt');
  evidence.cases.push('expanded preference and saved list survive application reopening; executable, argv, cwd and exported bytes verified');
  await idle();
  await ui.command('Input.insertText',{text:'半条草稿'});
  await ui.waitFor(`document.querySelector(${JSON.stringify(output)})?.innerText.trimEnd().endsWith('半条草稿')`);
  await ui.click('导出样本');
  await selected('本地 2');
  await show('ADB_FIXTURE_PULLED');
  await ui.click('本地 1');
  await selected('本地 1');
  await idle();
  await ui.waitFor(`document.querySelector(${JSON.stringify(output)})?.innerText.trimEnd().endsWith('半条草稿')`);
  await key('c','KeyC',67,2);
  await ui.waitFor(`document.querySelector(${JSON.stringify(output)})?.innerText.trimEnd().endsWith('>')`);
  await run('adb shell');
  await show('ADB_FIXTURE_FOREGROUND');
  const pid = Number((await text()).match(/ADB_FIXTURE_FOREGROUND:(\d+)/)?.[1]);
  assert.ok(pid>0);
  await ui.click('收起快捷指令');
  await ui.waitFor(`!document.querySelector('${panel}')`);
  assert.doesNotThrow(()=>process.kill(pid,0));
  await openPanel();
  await ui.click('导出样本');
  await selected('本地 3');
  await show('ADB_FIXTURE_PULLED');
  assert.doesNotThrow(()=>process.kill(pid,0));
  await ui.click('本地 1');
  await selected('本地 1');
  await ui.waitFor('document.activeElement?.matches(".local-terminal:not([hidden]) .xterm-helper-textarea")');
  await ui.command('Input.insertText',{text:'continued'});
  await key('Enter','Enter',13);
  await show('ADB_FIXTURE_ECHO:continued');
  await ui.click('关闭 本地 1');
  await ui.waitFor('!document.querySelector("[aria-label=\'关闭 本地 1\']")');
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  evidence.cases.push('busy and draft routed to new local tabs with original working directory; original foreground survives until its own close');
  await ui.click('本地 2');
  await selected('本地 2');
  await idle();
  await writeFile(path.join(workspace,'inventory-error.txt'),'fixture transport unavailable');
  await ui.click('导出样本');
  await show('ADB 枚举失败');
  await ui.click('导出样本 的失败详情');
  await ui.waitFor(`document.querySelector('[aria-label="ADB 枚举错误输出"]')?.textContent.includes('fixture transport unavailable')`);
  assert.ok(await ui.evaluate(`document.querySelector('[aria-label="最近 ADB 诊断"]').innerText.includes(${JSON.stringify(adb)})`));
  await ui.screenshot('windows-0.1.15-adb-diagnostic.png');
  await ui.click('关闭 ADB 诊断');
  await rm(path.join(workspace,'inventory-error.txt'));
  await ui.evaluate(`document.querySelector(${JSON.stringify(prompt)}).focus()`);
  evidence.cases.push('spaces and tabs parsed; failed enumeration shows stderr and exact executable beside shortcut');
  await setInventory('unauth\tunauthorized');
  const before = (await actions()).length;
  await ui.click('导出样本');
  await show('unauthorized');
  await idle();
  await setInventory();
  await ui.click('导出样本');
  await show('ADB 未发现设备');
  await idle();
  await setInventory('good\tdevice','other\tdevice','offline-one\toffline');
  await ui.click('导出样本');
  await ui.waitFor('!!document.querySelector("[aria-label=\'本次 ADB 设备\']")');
  await ui.click('取消本次操作');
  assert.equal((await actions()).length,before);
  await idle();
  await ui.click('导出样本');
  await ui.waitFor('!!document.querySelector("[aria-label=\'本次 ADB 设备\']")');
  await ui.fill('本次 ADB 设备','other');
  await setInventory('good\tdevice');
  await ui.click('执行到所选设备');
  await show('ADB_FIXTURE_TARGET_GONE');
  assert.equal((await actions()).length,before+1);
  assert.match((await actions()).at(-1),/^pull\|other\|-s\|other\|/);
  evidence.cases.push('no device, unauthorized, multi-device cancellation and target disappearance without retargeting');
  await idle();
  await manage('导出样本','编辑');
  await ui.fill('完整 ADB 命令','git --version');
  await ui.click('保存指令');
  await ui.waitFor(`document.querySelector('${panel} [role="alert"]')?.textContent.includes('完整的 adb 命令')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="完整 ADB 命令"]').value`),'git --version');
  await ui.fill('完整 ADB 命令','adb -s good pull /sdcard/ok edited.txt');
  await saveEditor();
  await ui.click('导出样本');
  await show('ADB_FIXTURE_PULLED');
  await idle();
  await exported('edited.txt');
  await idle();
  assert.match((await actions()).at(-1),/^pull\|good\|-s\|good\|pull\|\/sdcard\/ok\|edited.txt$/);
  await ui.screenshot('local-adb-software.png');
  evidence.cases.push('invalid edit retained without applying; explicit serial and corrected saved command preserved');
  await addShortcut('环境目标','adb pull /sdcard/ok environment.txt');
  await controlledExit();
  process.env.ANDROID_SERIAL='other';
  try {ui=await launchDesktop(root,{executable,webviewDirectory:path.join(root,'webview-environment')});}
  finally {
    if(originalEnv!==undefined)process.env.ANDROID_SERIAL=originalEnv;
    else delete process.env.ANDROID_SERIAL;
  }
  await setInventory('good\tdevice','other\tdevice');
  await openLocal();
  await openPanel();
  await ui.waitFor(`!!document.querySelector('${panel} .adb-shortcut-run[aria-label="环境目标"]')`);
  const callCount=(await log()).length;
  await ui.click('环境目标');
  await show('ADB_FIXTURE_PULLED');
  await idle();
  assert.equal((await log()).length,callCount+1,'inherited device does not enumerate or rewrite');
  assert.equal((await actions()).at(-1),'pull|other|pull|/sdcard/ok|environment.txt');
  await exported('environment.txt');
  await idle();
  await rm(path.join(workspace,'edited.txt'));
  await ui.click('导出样本');
  await exported('edited.txt');
  await idle();
  assert.equal((await log()).length,callCount+2);
  assert.match((await actions()).at(-1),/^pull\|good\|-s\|good\|/);
  evidence.cases.push('ANDROID_SERIAL inherited for device command; explicit serial takes priority over environment');
  evidence.calls = await log();
  await controlledExit();
  evidence.result='PASS';
} catch(error) {
  evidence.result='FAIL';evidence.error=String(error.stack);
  if(ui){await ui.screenshot('local-adb-software-failure.png').catch(()=>{});evidence.window=await ui.evaluate('document.body.innerText').catch(String);}
  throw error;
} finally {
  await writeFile('artifacts/local-adb-software-result.json',JSON.stringify(evidence,null,2));
  await ui?.close();
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
