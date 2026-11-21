import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {desktopKeyboard} from './DesktopKeyboard.mjs';
import {delay} from './DesktopHarness.mjs';
import {measureCompactToolbar} from './ToolbarMenuChecks.mjs';
import {observeLogDirectory} from './RecordingNoticeChecks.mjs';

const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const notice = '.recording-notice';
const failure = '[aria-label="日志操作失败通知"]';
const tabFeedback = '[aria-label="标签操作状态"]';
const savedFeedback = '[aria-label="日志保存反馈"]';
const ref = c => ({connection_id:c.connection_id,generation:c.generation});
const shell = (file,args) => execFileSync('pwsh',['-NoProfile','-STA','-File',file,...args],
  {encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const button = (card,label) => `[...${q(card)}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)})`;

export async function checkCornerNotices({ui,version,root,source,connect,activate,wait,fit,setTheme,webviewClick}) {
  const {enter} = desktopKeyboard(ui);
  const click = selector => webviewClick(ui,q(selector));
  const recording = c => `${q(`[role="tab"][data-connection-id="${c.connection_id}"]`)}.parentElement.querySelector('.tab-record-button')`;
  const closeTab = c => `[aria-label="关闭标签 ${c.connection_id}"]`;
  const list = c => ui.invoke('logging_request',{request:{op:'list',connection:ref(c)}});
  const nativeList = () => ui.invoke('service_list');
  const noticeName = () => ui.evaluate(`${q('.recording-notice-file')}?.textContent`);
  const savedPath = log => path.join(root,'logs',log.readable.filename);
  const position = card => ui.evaluate(`(()=>{
    const element=${q(card)},bounds=element.getBoundingClientRect(),close=element.querySelector('.corner-notice-close');
    const x=close.getBoundingClientRect();
    return {card:[bounds.width,bounds.height],close:[x.width,x.height],inset:[innerWidth-bounds.right,innerHeight-bounds.bottom],
      icon:close.querySelector('svg').getBoundingClientRect().width,accessible:close.getAttribute('aria-label')};
  })()`);

  async function begin(c,peer,marker) {
    const expression=recording(c);
    await ui.waitFor(`${expression}?.getAttribute('aria-disabled')==='false' && ${expression}.dataset.recording==='idle'`);
    await webviewClick(ui,expression);
    const log=await wait(async()=>(await list(c)).logs.find(entry=>entry.active&&entry.readable),'actual recording is active');
    await peer.control({op:'push',text:marker+'\r\n'});
    await wait(async()=>(await readFile(savedPath(log))).includes(marker),'owned log contains the fixture marker');
    return log;
  }
  async function stop(c,log) {
    const expression=recording(c);
    await ui.waitFor(`${expression}.dataset.recording==='recording' && ${expression}.getAttribute('aria-disabled')==='false'`);
    await webviewClick(ui,expression);
    await wait(async()=>(await list(c)).logs.some(entry=>entry.log_id===log.log_id&&entry.durable&&entry.worker_finished),'recording synced');
    await ui.waitFor(`${q('.recording-notice-file')}?.textContent===${JSON.stringify(log.readable.filename)}`);
  }
  async function heldDismiss(card,command,op,activateAction,onHeld) {
    const response = await ui.interceptIpc({command,op,mode:'hold'});
    try {
      const started=Date.now();
      await activateAction();
      await ui.waitFor(`!${q(card)}`);
      const elapsed=Date.now()-started;
      assert.ok(elapsed<1000,`notice dismissed while response was held after ${elapsed}ms`);
      await wait(async()=>await response.count()===1,'one real response held');
      await onHeld?.();
      assert.equal(await response.count(),1);
      return elapsed;
    } finally { await response.restore(); }
  }
  async function idleDismiss(card) {
    const started=await ui.evaluate('performance.now()');
    await ui.waitFor(`!${q(card)}`);
    const elapsed=Math.round((await ui.evaluate('performance.now()'))-started);
    assert.ok(elapsed>=4500&&elapsed<6500,`idle card dismissed in ${elapsed}ms`);
    return elapsed;
  }
  async function keyboardClose(card) {
    const close=q(card+' .corner-notice-close');
    await ui.evaluate(`${close}.focus()`);
    await ui.waitFor(`document.activeElement===${close}`);
    await enter();
    await ui.waitFor(`!${q(card)}`);
  }

  const first=await source('notice-first'),second=await source('notice-second');
  const a=await connect(first,false),b=await connect(second,false);
  await activate(b);
  fit(720,480);
  await ui.waitFor('innerWidth<=725');
  await setTheme('dark');
  const geometry={dark:await measureCompactToolbar(ui)};
  const bLog=await begin(b,second,'NOTICE_B_DISTINCT');
  const aLog=await begin(a,first,'NOTICE_A_ORIGINAL');
  await stop(a,aLog);
  const recordedGeometry=await position(notice);
  assert.deepEqual(recordedGeometry.close,[32,32]);
  assert.equal(recordedGeometry.icon,16);
  assert.equal(recordedGeometry.accessible,'关闭通知');
  await ui.screenshot(`desktop-${version}-recording-notice-dark-narrow.png`);
  const point=await ui.evaluate(`(()=>{const r=${q(notice)}.getBoundingClientRect();return {x:r.x+12,y:r.y+14};})()`);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await delay(5200);
  assert.equal(await noticeName(),aLog.readable.filename,'pointer paused the original notice');
  await ui.evaluate(`(${button(notice,'打开该日志')}).focus()`);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:90});
  await delay(5200);
  assert.equal(await noticeName(),aLog.readable.filename,'keyboard focus paused the original notice');
  const fileMs=await heldDismiss(notice,'terminal_log_request','open_file',()=>ui.evaluate(`(()=>{
    const file=(${button(notice,'打开该日志')}),directory=(${button(notice,'打开日志目录')});
    file.click();file.click();directory.click();
  })()`),async()=>{
    await stop(b,bLog);
    await ui.evaluate(`${q(notice+' .corner-notice-close')}.focus()`);
  });
  const opened=shell('scripts/lib/ObserveLogShell.ps1',['-Root',root,'-TargetPath',savedPath(aLog),'-Action','system-file','-LogId',aLog.log_id]);
  assert.match(opened,/PASS actual (?:system default program|readable log and exact header)/);
  await ui.command('Page.bringToFront');
  assert.equal(await noticeName(),bLog.readable.filename,'the late file reply did not clear the newer notice');
  let directoryMs;
  await observeLogDirectory(ui,root,async()=>{
    await ui.evaluate(`(${button(notice,'打开日志目录')}).focus()`);
    directoryMs=await heldDismiss(notice,'open_managed_log_directory',undefined,()=>enter());
  });

  const errorLog=await begin(b,second,'NOTICE_ERROR_MISSING_FILE');
  await stop(b,errorLog);
  const original=savedPath(errorLog),moved=original+'.held';
  await rename(original,moved);
  try {
    await webviewClick(ui,`(${button(notice,'打开该日志')})`);
    await ui.waitFor(`!${q(notice)}&&${q(failure+' [role="alert"]')}?.textContent.includes('本次文件已不存在')`);
    assert.deepEqual((await position(failure)).card,recordedGeometry.card);
    await ui.screenshot(`desktop-${version}-notice-failure-dark-narrow.png`);
    await keyboardClose(failure);
  } finally { await rename(moved,original); }

  const dismissedLog=await begin(b,second,'NOTICE_X_ONLY');
  await stop(b,dismissedLog);
  await ui.evaluate(`(()=>{
    const original=window.fetch;window.noticeActions={original,count:0};
    window.fetch=function(input,options){
      const route=new URL(String(input)).pathname;let op;
      try{op=JSON.parse(options?.body).request?.op;}catch{}
      if(route==='/open_managed_log_directory'||route==='/terminal_log_request'&&op==='open_file')window.noticeActions.count++;
      return original.call(this,input,options);
    };
  })()`);
  try {
    await keyboardClose(notice);
    assert.equal(await ui.evaluate('window.noticeActions.count'),0);
  } finally { await ui.evaluate('window.fetch=window.noticeActions.original;delete window.noticeActions'); }

  const saveRoot=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));
  let savedMs;
  try {
    await activate(b);
    await click('.toolbar-log');
    const saveItem=`[...document.querySelectorAll('.terminal-context-menu button')].find(b=>b.textContent==='保存终端缓冲内容…'&&!b.disabled)`;
    await ui.waitFor(`!!(${saveItem})`);
    await webviewClick(ui,`(${saveItem})`);
    const destination=path.join(saveRoot,'通知验证.log');
    assert.match(shell('scripts/lib/NativeImportDialog.ps1',['-Root',saveRoot,'-TargetProcessId',String(ui.app.pid),
      '-Purpose','TextLog','-Action','select','-TargetPath',destination]),/PASS native TextLog/);
    await ui.waitFor(`!!${q(savedFeedback)}`);
    assert.ok((await readFile(destination)).length>0);
    await ui.screenshot(`desktop-${version}-saved-notice-dark-narrow.png`);
    await observeLogDirectory(ui,saveRoot,async()=>{
      savedMs=await heldDismiss(savedFeedback,'export_save_request','open_directory',()=>webviewClick(ui,`(${button(savedFeedback,'打开所在目录')})`));
    },{saved:true});
  } finally {
    assert.equal(path.dirname(saveRoot),path.resolve(tmpdir()));
    assert.ok(path.basename(saveRoot).startsWith('shared-terminal-save-ui-中文-'));
    await rm(saveRoot,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  }

  fit(1100,760);
  await ui.waitFor('innerWidth>=1080');
  await setTheme('light');
  geometry.light=await measureCompactToolbar(ui);
  await click(closeTab(a));
  await ui.waitFor(`${q(tabFeedback)}?.textContent==='关闭请求已提交；只关闭原代次标签，实际连接状态以服务为准。'`);
  assert.equal(await ui.evaluate(`!!${q('dialog[aria-label="关闭标签确认"]')}`),false);
  const tabCard='.corner-notice:has(> .corner-notice-message [aria-label="标签操作状态"])';
  assert.deepEqual((await position(tabCard)).card,recordedGeometry.card);
  await ui.screenshot(`desktop-${version}-tab-closed-notice-light-wide.png`);
  assert.equal((await nativeList()).find(c=>c.connection_id===b.connection_id)?.state,'CONNECTED');
  const idleMs=await idleDismiss(tabCard);
  const closeHeld=await ui.interceptIpc({command:'ssh_request',op:'close',mode:'hold',connectionId:b.connection_id});
  try {
    await click(closeTab(b));
    await wait(async()=>await closeHeld.count()===1,'tab close response is held');
    await ui.waitFor(`${q(tabFeedback)}?.textContent==='正在关闭会话…'`);
    await keyboardClose(tabCard);
    assert.equal(await closeHeld.count(),1);
  } finally { await closeHeld.restore(); }
  await ui.waitFor(`!${q(closeTab(b))}`);
  assert.equal(await ui.evaluate(`!!${q(tabFeedback)}`),false,'late closed-tab reply did not restore the dismissed card');

  return {result:'PASS',geometry,recordedGeometry,fileMs,directoryMs,savedMs,idleMs,opened,hoverPaused:true,focusPaused:true,
    savedDirectoryExact:true,logDirectoryExact:true,oldReplyPreservedNewNotice:true,tabCloseNoConfirmation:true,closeButtonInvokedNoAction:true};
}
