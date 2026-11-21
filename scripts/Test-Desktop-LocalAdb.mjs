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
const prompt = '.local-terminal:not([hidden]) input[aria-label="本地命令输入"]';
const output = '.local-terminal:not([hidden]) .local-terminal-output';
const key = async (key, code, windowsVirtualKeyCode) => {
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
};
let ui;
const evidence = {result:'IN_PROGRESS', executable:executable??path.resolve('target/debug/shared-terminal-desktop.exe'), cases:[]};
const idle = () => ui.waitFor(`document.activeElement?.matches(${JSON.stringify(prompt)})`);
const text = () => ui.evaluate(`document.querySelector(${JSON.stringify(output)})?.innerText`);
const show = value => ui.waitFor(`document.querySelector('.local-terminal:not([hidden])')?.innerText.includes(${JSON.stringify(value)})`);
const log = async () => (await readFile(calls,'utf8').catch(()=> '')).trim().split(/\r?\n/).filter(Boolean);
const actions = async () => (await log()).filter(line=>line.startsWith('pull|'));
const setInventory = (...lines) => writeFile(inventory,lines.map(line=>line+'\n').join(''));
async function run(line) {
  await idle();
  await ui.command('Input.insertText',{text:line});
  await key('Enter','Enter',13);
}
async function openLocal() {
  await ui.click('本地命令行');
  await idle();
  await run('cd "'+workspace+'"');
  await ui.waitFor(`document.querySelector(${JSON.stringify(prompt)})?.previousElementSibling.title===${JSON.stringify(workspace)}`);
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
  await ui.click('管理 ADB 按钮');
  await ui.waitFor('!!document.querySelector("[aria-label=\'ADB 程序路径\']")');
  await ui.fill('ADB 程序路径',adb);
  await ui.click('新建按钮');
  await ui.fill('按钮名称','设备列表');
  await ui.fill('完整 ADB 命令','adb devices -l');
  await ui.click('新建按钮');
  await ui.fill('按钮名称','导出样本');
  await ui.fill('完整 ADB 命令','adb pull "/sdcard/a b" "./导出 文件.txt"');
  await ui.click('保存 ADB 快捷设置');
  await ui.waitFor('!document.querySelector("dialog[aria-label=\'ADB 快捷操作设置\']")');
}

try {
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true,stdio:'inherit'});
  await mkdir(workspace);
  await setInventory('good\tdevice product:fixture');
  const originalEnv = process.env.ANDROID_SERIAL;
  delete process.env.ANDROID_SERIAL;
  try {ui=await launchDesktop(root,{executable});}
  finally {if(originalEnv!==undefined)process.env.ANDROID_SERIAL=originalEnv;}
  await openLocal();
  await setOptions();
  await ui.click('设备列表');
  await show('List of devices attached');
  assert.equal((await log()).length,1);
  await controlledExit();
  delete process.env.ANDROID_SERIAL;
  try {ui=await launchDesktop(root,{executable,webviewDirectory:path.join(root,'webview-reopen')});}
  finally {if(originalEnv!==undefined)process.env.ANDROID_SERIAL=originalEnv;}
  await openLocal();
  assert.equal((await log()).length,1,'opening does not execute saved button');
  await ui.waitFor("Array.from(document.querySelectorAll('.local-adb-actions button')).some(b=>b.textContent==='导出样本')");
  await ui.click('导出样本');
  await show('ADB_FIXTURE_PULLED');
  assert.equal(await readFile(path.join(workspace,'导出 文件.txt'),'utf8'),'observed fixture download');
  assert.equal((await actions()).at(-1),'pull|good|-s|good|pull|/sdcard/a b|./导出 文件.txt');
  evidence.cases.push('persisted across application and WebView profile reopen; executable, argv, cwd and exported bytes verified');
  await idle();
  await ui.command('Input.insertText',{text:'半条草稿'});
  await ui.click('导出样本');
  await show('ADB_FIXTURE_PULLED');
  await ui.click('本地 1');
  await idle();
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`),'半条草稿');
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
  await run('adb shell');
  await show('ADB_FIXTURE_FOREGROUND');
  const pid = Number((await text()).match(/ADB_FIXTURE_FOREGROUND:(\d+)/)?.[1]);
  assert.ok(pid>0);
  await ui.click('导出样本');
  await show('ADB_FIXTURE_PULLED');
  assert.doesNotThrow(()=>process.kill(pid,0));
  await ui.click('关闭 本地 1');
  await ui.waitFor('!document.querySelector("[aria-label=\'关闭 本地 1\']")');
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  evidence.cases.push('busy and draft routed to new local tabs with original working directory; original foreground survives until its own close');
  await ui.click('本地 2');
  await idle();
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
  await ui.click('管理 ADB 按钮');
  await ui.waitFor('!!document.querySelector("[aria-label=\'已保存 ADB 按钮\']")');
  await ui.fill('已保存 ADB 按钮',await ui.evaluate(`Array.from(document.querySelector('[aria-label="已保存 ADB 按钮"]').options).find(o=>o.textContent==='导出样本').value`));
  await ui.fill('完整 ADB 命令','git --version');
  await ui.click('保存 ADB 快捷设置');
  await ui.waitFor(`document.querySelector('dialog [role="alert"]')?.textContent.includes('完整的 adb 命令')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="完整 ADB 命令"]').value`),'git --version');
  await ui.fill('完整 ADB 命令','adb -s good pull /sdcard/ok edited.txt');
  await ui.click('保存 ADB 快捷设置');
  await ui.waitFor('!document.querySelector("dialog[aria-label=\'ADB 快捷操作设置\']")');
  await ui.click('导出样本');
  await show('ADB_FIXTURE_PULLED');
  await idle();
  assert.equal(await readFile(path.join(workspace,'edited.txt'),'utf8'),'observed fixture download');
  assert.match((await actions()).at(-1),/^pull\|good\|-s\|good\|pull\|\/sdcard\/ok\|edited.txt$/);
  await ui.screenshot('local-adb-software.png');
  evidence.cases.push('invalid edit retained without applying; explicit serial and corrected saved command preserved');
  await ui.click('管理 ADB 按钮');
  await ui.waitFor('!!document.querySelector("[aria-label=\'ADB 程序路径\']")');
  await ui.click('新建按钮');
  await ui.fill('按钮名称','环境目标');
  await ui.fill('完整 ADB 命令','adb pull /sdcard/ok environment.txt');
  await ui.click('保存 ADB 快捷设置');
  await ui.waitFor('!document.querySelector("dialog[aria-label=\'ADB 快捷操作设置\']")');
  await controlledExit();
  process.env.ANDROID_SERIAL='other';
  try {ui=await launchDesktop(root,{executable,webviewDirectory:path.join(root,'webview-environment')});}
  finally {
    if(originalEnv!==undefined)process.env.ANDROID_SERIAL=originalEnv;
    else delete process.env.ANDROID_SERIAL;
  }
  await setInventory('good\tdevice','other\tdevice');
  await openLocal();
  await ui.waitFor("Array.from(document.querySelectorAll('.local-adb-actions button')).some(b=>b.textContent==='环境目标')");
  const callCount=(await log()).length;
  await ui.click('环境目标');
  await show('ADB_FIXTURE_PULLED');
  await idle();
  assert.equal((await log()).length,callCount+1,'inherited device does not enumerate or rewrite');
  assert.equal((await actions()).at(-1),'pull|other|pull|/sdcard/ok|environment.txt');
  assert.equal(await readFile(path.join(workspace,'environment.txt'),'utf8'),'observed fixture download');
  await ui.click('导出样本');
  await idle();
  await ui.waitFor(`document.querySelector('.local-terminal-output')?.innerText.includes('edited.txt')`);
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
