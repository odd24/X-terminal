import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,realpath,rm,rmdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-local-directory-中文-'));
const runNative=promisify(execFile);
const result={result:'IN_PROGRESS',executable,checks:[]};
const visible='.local-terminal:not([hidden])';
const shellOutput=`document.querySelector('${visible} .local-terminal-output')`;
const setting=label=>`document.querySelector('.local-directory-settings [aria-label="${label}"]')?.textContent`;
const warning=selector=>`document.querySelector('${selector} [role="alert"]')?.textContent`;
const q=JSON.stringify;
const fallback='已保存的默认目录不存在或无法访问，已使用桌面';
let ui;

async function clickTools(name) {
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click(name);
}

async function settings(expected) {
  await clickTools('软件设置');
  await ui.click('本地终端');
  await ui.waitFor(`${setting('默认目录')}===${q(expected)}`);
}

async function picker(choice) {
  await ui.click('选择文件夹');
  const args=['-NoProfile','-File','scripts/lib/NativeImportDialog.ps1','-TargetProcessId',String(ui.app.pid),
    '-Root',root,'-Purpose','LocalDirectory','-Action',choice?'select':'cancel'];
  if(choice)args.push('-TargetPath',choice);
  const native=await runNative('pwsh',args,{windowsHide:true,encoding:'utf8',timeout:18000});
  assert.match(native.stdout,/PASS native LocalDirectory picker/);
}

async function openShell(fromPlus) {
  if(fromPlus)await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");
  else await ui.click('本地终端（PowerShell）');
  await ui.waitFor(`document.querySelector('${visible}')?.dataset.mode==='powershell'`);
}

async function checkShell(expected, probe) {
  await ui.waitFor(`document.activeElement?.matches('${visible} .xterm-helper-textarea')`);
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${shellOutput}?.innerText??'')`);
  const output=path.join(await realpath(root),probe+'.txt');
  const literal="'"+output.replaceAll("'","''")+"'";
  await ui.command('Input.insertText',{text:`Set-Content -LiteralPath ${literal} -Value (Get-Location).Path -Encoding UTF8`});
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  for(let n=0;n<120;n++){
    const actual=(await readFile(output,'utf8').catch(()=>'')).replace(/^\uFEFF/,'').trim();
    if(actual){
      assert.equal(path.normalize(actual).toLowerCase(),path.normalize(expected).toLowerCase());
      return;
    }
    await delay(50);
  }
  assert.fail('missing Windows PowerShell Get-Location evidence: '+probe);
}

async function openLight(expected) {
  await clickTools('轻量命令行');
  await ui.waitFor(`document.querySelector('${visible}')?.dataset.mode==='lightweight'&&${shellOutput}?.title===${q(expected)}`);
}

async function exit() {
  await clickTools('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
  ui=undefined;
}

try {
  const desktop=execFileSync('pwsh',['-NoProfile','-Command',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath("DesktopDirectory")',
  ],{windowsHide:true,encoding:'utf8'}).trim();
  assert.ok(desktop,'this test requires an accessible current-user desktop');
  const canonicalDesktop=await realpath(desktop);
  const profileDesktop=await realpath(path.join(process.env.USERPROFILE,'Desktop')).catch(()=>null);
  result.desktopRedirected=canonicalDesktop.toLowerCase()!==profileDesktop?.toLowerCase();
  const selected=path.join(root,'本地目录 中文');
  await mkdir(selected);
  const custom=await realpath(selected);
  ui=await launchDesktop(root,{executable});
  await settings(desktop);
  await ui.click('关闭软件设置');
  await openShell(false);await checkShell(desktop,'fresh');
  await openLight(desktop);
  result.checks.push('fresh default matches Windows DesktopDirectory in the empty-page PowerShell process and lightweight terminal');

  await settings(desktop);await picker(selected);
  await ui.waitFor(`${setting('默认目录')}===${q(custom)}`);
  await ui.waitFor("document.querySelector('.local-directory-settings [role=status]')?.textContent==='默认目录已保存'");
  await ui.screenshot('windows-0.1.17-local-directory.png');
  await picker();
  await ui.waitFor("document.querySelector('.local-directory-settings [role=status]')?.textContent==='已取消选择'");
  assert.equal(await ui.evaluate(setting('默认目录')),custom);
  await ui.click('关闭软件设置');
  assert.equal(await ui.evaluate(`${shellOutput}?.title`),desktop);
  await ui.click('本地 1');await checkShell(desktop,'existing');
  await openShell(true);await checkShell(custom,'configured');
  await openLight(custom);
  result.checks.push('native picker saves a Chinese path, Cancel preserves it, old tabs retain their directories, and both new modes use the selection');
  await exit();

  ui=await launchDesktop(root,{executable});
  await settings(custom);await ui.click('关闭软件设置');
  await openShell(false);await checkShell(custom,'reopened');
  await exit();
  await rmdir(selected);

  ui=await launchDesktop(root,{executable});
  await settings(custom);
  assert.equal(await ui.evaluate(setting('实际打开位置')),desktop);
  assert.equal(await ui.evaluate(warning('.local-directory-settings')),fallback);
  await ui.click('关闭软件设置');
  await openShell(false);await checkShell(desktop,'fallback');
  assert.equal(await ui.evaluate(warning(visible)),fallback);
  await openLight(desktop);
  assert.equal(await ui.evaluate(warning(visible)),fallback);
  result.checks.push('reopened app retains the preference, reports an unavailable directory in settings and both new tabs, and falls back to the actual desktop');
  await settings(custom);
  await ui.click('恢复桌面');
  await ui.waitFor(`${setting('默认目录')}===${q(desktop)}`);
  await ui.waitFor("document.querySelector('.local-directory-settings [role=status]')?.textContent==='已恢复使用桌面'");
  await ui.click('关闭软件设置');
  await exit();

  ui=await launchDesktop(root,{executable});
  await settings(desktop);
  assert.equal(await ui.evaluate(warning('.local-directory-settings')),undefined);
  await ui.click('关闭软件设置');
  await openShell(false);await checkShell(desktop,'restored');
  await openLight(desktop);
  assert.equal(await ui.evaluate(warning(visible)),undefined);
  await exit();
  result.checks.push('restore survives restart and both fresh terminals select the desktop without a fallback warning');
  result.result='PASS';
} catch(error) {
  result.result='FAIL';
  result.error=String(error.stack);
  if(ui)await ui.screenshot('windows-0.1.17-local-directory-failure.png').catch(()=>{});
  throw error;
} finally {
  await ui?.close();
  await writeFile('artifacts/local-directory-software-result.json',JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
