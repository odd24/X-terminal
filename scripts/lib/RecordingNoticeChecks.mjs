import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {delay} from './DesktopHarness.mjs';

const notice='document.querySelector(".recording-notice")';
const noticeFile=`${notice}?.querySelector('.recording-notice-file')`;
const legacyPanel='document.querySelector(\'[aria-label="终端右键日志操作"]\')';

function powerShell(args) {
  return execFileSync('pwsh',['-NoProfile','-STA',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
}

export async function observeLogDirectory(page,root,activate) {
  const windows=powerShell(['-Command',
    "ConvertTo-Json -Compress -InputObject @((New-Object -ComObject Shell.Application).Windows() | ForEach-Object {[string]$_.HWND})"]);
  await activate();
  const opened=powerShell(['-File','scripts/lib/ObserveLogShell.ps1','-Root',root,'-TargetPath',path.join(root,'logs'),
    '-Action','directory','-ExistingExplorerWindows',windows]);
  assert.match(opened,/PASS exact shared test log directory/);
  await page.command('Page.bringToFront');
  assert.equal(await page.evaluate(`!!${legacyPanel}`),false);
  assert.equal(await page.evaluate(`!!document.querySelector('.log-directory-error')`),false);
}

export async function checkToolbarDirectory(page,root) {
  const button='document.querySelector(".toolbar-log-directory")';
  assert.equal(await page.evaluate(`${button}.getAttribute('aria-label')`),'打开日志目录');
  assert.equal(await page.evaluate(`${button}.disabled`),false);
  const click=()=>page.evaluate(`${button}.click()`);
  await observeLogDirectory(page,root,click);
  assert.equal(await page.evaluate(`!!${notice}`),false);
  const logs=path.join(root,'logs'),backup=path.join(root,'empty-logs-before-fault');
  await rename(logs,backup);
  try{
    await writeFile(logs,'owned synthetic directory obstruction',{flag:'wx'});
    try{
      await click();
      await page.waitFor(`document.querySelector('.log-directory-error[role="alert"]')?.textContent.includes('日志目录')`);
      assert.equal(await page.evaluate(`!!${legacyPanel}||!!${notice}`),false);
    }finally{await unlink(logs);}
  }finally{await rename(backup,logs);}
  await observeLogDirectory(page,root,click);
}

export async function waitForStopNotice(page,label,log) {
  await page.waitFor(`${noticeFile}?.textContent===${JSON.stringify(log.readable.filename)}`);
  const data=await page.evaluate(`(() => {
    const card=${notice},rect=card.getBoundingClientRect();
    return {status:card.querySelector('[role=status]').textContent,
      actions:[...card.querySelectorAll('button')].map(x=>x.textContent),right:innerWidth-rect.right,bottom:innerHeight-rect.bottom};
  })()`);
  assert.ok(data.status.includes(label)&&data.status.includes('记录已停止并同步'));
  assert.ok(data.status.includes(log.readable.synced_bytes.toLocaleString('zh-CN')+' 字节'));
  assert.deepEqual(data.actions,['打开该日志','打开日志目录']);
  assert.ok(data.right>=8&&data.right<=24&&data.bottom>=8&&data.bottom<=24);
}

export async function checkNoticeActions(page,root,log,resumeRecording,switchTab,version='0.1.5') {
  assert.equal(await page.evaluate(`document.activeElement.classList.contains('xterm-helper-textarea')`),true,'toast did not move focus');
  await page.screenshot(`desktop-${version}-recording-stopped.png`);
  const xy=await page.evaluate(`(()=>{const r=${notice}.getBoundingClientRect();return{x:r.left+12,y:r.top+12};})()`);
  await page.command('Input.dispatchMouseEvent',{type:'mouseMoved',...xy});
  await delay(5200);
  assert.equal(await page.evaluate(`!!${notice}`),true,'hover paused dismissal');
  await switchTab();
  await resumeRecording();
  const directoryButton=`${notice}.querySelector('button:last-child')`;
  await page.evaluate(`${directoryButton}.focus()`);
  await page.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:90});
  await delay(5200);
  assert.equal(await page.evaluate(`document.activeElement===${directoryButton}`),true,'keyboard focus paused dismissal');
  await observeLogDirectory(page,root,()=>page.evaluate(`${directoryButton}.click()`));

  const fileButton=`${notice}.querySelector('button:first-child')`;
  assert.equal(await page.evaluate(`${noticeFile}.textContent`),log.readable.filename);
  await page.evaluate(`${fileButton}.focus()`);
  const opened=await page.interceptIpc({command:'terminal_log_request',op:'open_file'});
  try{
    await page.evaluate(`${fileButton}.click()`);
    for(let i=0;i<50&&!(await opened.count());i++)await delay(50);
    assert.equal(await opened.count(),1,'one real native file-open response after activating the notice button');
  }finally{await opened.restore();}
  const file=powerShell(['-File','scripts/lib/ObserveLogShell.ps1','-Root',root,'-TargetPath',path.join(root,'logs',log.readable.filename),
    '-Action','file','-LogId',log.log_id]);
  assert.match(file,/PASS actual readable log and exact header/);
  await page.command('Page.bringToFront');
  const idleStart=await page.evaluate(`document.querySelector('[data-active="true"] .xterm-helper-textarea').focus();performance.now()`);
  await page.waitFor(`!${notice}`);
  const idleMs=Math.round((await page.evaluate('performance.now()'))-idleStart);
  assert.ok(idleMs>=4750&&idleMs<7000,`idle notice dismissal took ${idleMs}ms`);
  return {hoverPaused:true,keyboardPaused:true,originalFileInNotepad:true,idleMs};
}
