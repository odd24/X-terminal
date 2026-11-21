import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';
import {closeSoakDesktop} from './lib/LoadSoak.mjs';
import {observeLogDirectory,waitForStopNotice} from './lib/RecordingNoticeChecks.mjs';
import {requestId} from '../apps/desktop/src/request-id.ts';

const desktop=path.resolve(process.argv[2]);
const probe=path.resolve(process.argv[3]);
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-log-viewer-ui-中文-含 空格-'));
const saveRoot=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));
const trace=path.join(root,'program-trace.tsv');
let ui,fixture,report;
const wait=async(check,label)=>{
  for(let i=0;i<150;i++){const v=await check();if(v)return v;await delay(50);}
  throw Error('Timeout: '+label);
};
const traces=()=>readFile(trace,'utf8').then(s=>s.trim().split(/\r?\n/).filter(Boolean)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
const pick=(purpose,action,filename)=>execFileSync('pwsh',['-NoProfile','-STA','-File','scripts/lib/NativeImportDialog.ps1',
  '-TargetProcessId',String(ui.app.pid),'-Purpose',purpose,'-Root',purpose==='LogViewer'?root:saveRoot,
  '-Action',action,...(filename?['-TargetPath',filename]:[])],
  {windowsHide:true,encoding:'utf8',timeout:18000});
const settings=()=>ui.invoke('log_viewer_settings');
const selected='document.querySelector(\'[aria-label="当前日志打开方式"]\')';
const button=(scope,text)=>`[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
const operation='[aria-label="终端右键日志操作"]';
const completed='.recording-notice';
const measurements={};
async function fit(width) {
  const args=['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),
    '-ExpectedExecutable',desktop,'-Width',String(width),'-Height',width===720?'480':'760'];
  const result=JSON.parse(execFileSync('pwsh',args,{windowsHide:true,encoding:'utf8',timeout:10000}));
  await ui.waitFor(`Math.abs(innerWidth-${result.clientWidth*96/result.dpi})<=1`);
}
async function measure(kind,selector,width) {
  await fit(width);
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  const value=await ui.evaluate(`(()=>{
    const card=document.querySelector(${JSON.stringify(selector)}),r=card.getBoundingClientRect(),style=getComputedStyle(card);
    const actions=card.querySelector('.corner-notice-actions').getBoundingClientRect();
    return {width:r.width,height:r.height,padding:style.padding,actionsBottom:r.bottom-actions.bottom,
      actionsLeft:actions.left-r.left,viewport:[innerWidth,innerHeight],right:innerWidth-r.right,bottom:innerHeight-r.bottom};
  })()`);
  assert.ok(value.right>=8&&value.bottom>=8);
  measurements[kind+width]=value;
  return value;
}
async function appearance() {
  await ui.evaluate(`document.querySelector('.tools-menu').open=true`);
  await ui.click('外观');
  await ui.waitFor(`!!${selected}`);
}
async function chooseProgram(filename) {
  await ui.evaluate(`document.querySelector('[aria-label="选择日志打开程序"]').click()`);
  assert.match(pick('LogViewer',filename?'select':'cancel',filename),/PASS native/);
  await ui.waitFor(`!document.querySelector('[aria-label="选择日志打开程序"]').disabled`);
}
async function idleClose(service) {
  await ui.evaluate(`setTimeout(()=>void window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),50);true`);
  await wait(()=>ui.app.exitCode===0,'desktop exit');
  const receipt=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',service.service_id+'.json'),'utf8'));
  assert.equal(receipt.shutdown_ack,'ACKNOWLEDGED');
  await ui.close();ui=undefined;
}
async function connect() {
  const work=path.join(root,'synthetic-server');
  await mkdir(work);
  fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[work],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
  const next=async()=>{
    let timer;
    try {
      const value=await Promise.race([lines.next(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('SSH fixture timed out')),10000))]);
      return JSON.parse(value.value);
    } finally{clearTimeout(timer);}
  };
  const peer=await next(),ssh=request=>ui.invoke('ssh_request',{request});
  const {connection}=await ssh({op:'quick_start',settings:{protocol:'ssh2',host:'localhost',port:peer.port,username:'synthetic',auth:'password',encoding:'utf8'},request_id:requestId(),cols:80,rows:24});
  const ref={connection_id:connection.connection_id,generation:connection.generation};
  const answered=new Set();
  await wait(async()=>{
    const {challenge,connection}=await ssh({op:'status',connection:ref});
    assert.notEqual(connection.state,'FAILED');
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,peer.pin);
        await ssh({op:'answer_host',connection:ref,challenge_id:challenge.id,approve:true});
      }else await ssh({op:'authenticate',connection:ref,challenge_id:challenge.id,use_saved:false,password:peer.password});
    }
    return connection.state==='CONNECTED';
  },'synthetic connection');
  await ui.selectTab(connection.connection_id);
  await ui.waitFor(`document.querySelector('[data-pane]')?.dataset.renderedId===${JSON.stringify(ref.connection_id)}`);
  return {ref,push:async text=>{fixture.stdin.write(JSON.stringify({op:'push',text})+'\n');await next();}};
}
async function menu(text) {
  await ui.waitFor(`!document.querySelector('.toolbar-log').disabled`);
  await ui.evaluate(`document.querySelector('.toolbar-log').click()`);
  const item=button('.terminal-context-menu',text);
  await ui.waitFor(`!!(${item})&&! (${item}).disabled`);
  await ui.evaluate(`(${item}).click()`);
}
const checkTrace=async(program,file,index)=>{
  const rows=await wait(async()=>{const values=await traces();return values.length>index&&values;},'explicit viewer was launched');
  const [arity,image,argument,...extra]=rows[index].split('\t');
  assert.deepEqual([arity,image,extra],['1',path.basename(program),[]]);
  assert.equal(await realpath(argument),await realpath(file));
  assert.equal(rows.length,index+1);
};
try{
  const programs=path.join(root,'选择 程序');
  await mkdir(programs);
  const first=path.join(programs,'日志 查看器 A.exe');
  const second=path.join(programs,'日志 查看器 B.exe');
  await copyFile(probe,first);await copyFile(probe,second);
  const firstPath=await realpath(first),secondPath=await realpath(second);
  ui=await launchDesktop(root,{executable:desktop});
  const original=await ui.invoke('service_status');
  await appearance();
  assert.deepEqual(await settings(),{executable:null,available:true});
  await chooseProgram();
  assert.deepEqual(await settings(),{executable:null,available:true});
  await chooseProgram(first);
  await ui.waitFor(`${selected}.textContent===${JSON.stringify(firstPath)}`);
  await chooseProgram();
  assert.deepEqual(await settings(),{executable:firstPath,available:true});
  await ui.evaluate(`document.querySelector('.log-viewer-settings').scrollIntoView({block:'nearest'})`);
  await ui.screenshot('desktop-0.1.6-log-viewer-settings.png');
  await ui.click('关闭外观');
  await idleClose(original);

  ui=await launchDesktop(root,{executable:desktop,webviewDirectory:path.join(root,'webview-second')});
  const service=await ui.invoke('service_status');
  assert.notEqual(service.service_id,original.service_id);
  assert.deepEqual(await settings(),{executable:firstPath,available:true});
  const {ref,push}=await connect();
  const logs=()=>ui.invoke('logging_request',{request:{op:'list',connection:ref}}).then(value=>value.logs);
  const file=log=>path.join(root,'logs',log.readable.filename);
  await menu('开始记录');
  await ui.waitFor(`document.querySelector(${JSON.stringify(operation)})?.textContent.includes('正在记录')`);
  await measure('start',operation,1100);
  await measure('start',operation,720);
  await ui.screenshot('desktop-0.1.6-start-notice-narrow.png');
  await ui.click('收起日志操作');
  await push('\r\nVIEWER_ORIGINAL_FILE\r\n');
  await ui.waitFor(`document.querySelector('.xterm-rows').textContent.includes('VIEWER_ORIGINAL_FILE')`);
  await menu('停止记录');
  const stopped=await wait(async()=>{const [log]=await logs();return log?.durable&&log.worker_finished&&log;},'first durable stop');
  await waitForStopNotice(ui,'localhost',stopped);
  await measure('stop',completed,720);
  await ui.screenshot('desktop-0.1.6-stop-notice-narrow.png');
  await measure('stop',completed,1100);
  await ui.screenshot('desktop-0.1.6-stop-notice-wide.png');
  await ui.evaluate(`(${button(completed,'打开该日志')}).click()`);
  await checkTrace(first,file(stopped),0);

  await menu('开始记录');
  const live=await wait(async()=>(await logs()).find(l=>l.active&&l.readable),'another recording');
  assert.notEqual(file(live),file(stopped));
  await menu('打开当前日志文件');
  await checkTrace(first,file(live),1);
  await ui.click('收起日志操作');
  await rename(first,first+'.removed');
  await menu('打开当前日志文件');
  await ui.waitFor(`document.querySelector(${JSON.stringify(operation+'[data-tone="error"]')})?.textContent.includes('所选日志打开程序不存在')`);
  await measure('error',operation,1100);
  await measure('error',operation,720);
  await ui.screenshot('desktop-0.1.6-error-notice-narrow.png');
  assert.deepEqual(await settings(),{executable:firstPath,available:false});
  assert.equal((await traces()).length,2);
  await ui.click('收起日志操作');
  await appearance();
  await chooseProgram(second);
  assert.deepEqual(await settings(),{executable:secondPath,available:true});
  await ui.click('关闭外观');
  await menu('打开当前日志文件');
  await checkTrace(second,file(live),2);
  await ui.click('收起日志操作');
  await appearance();
  await ui.evaluate(`(${button('.log-viewer-settings','恢复 Windows 系统默认')}).click()`);
  await ui.waitFor(`${selected}.textContent==='Windows 系统默认'`);
  await ui.click('关闭外观');
  await menu('打开当前日志文件');
  assert.match(execFileSync('pwsh',['-NoProfile','-STA','-File','scripts/lib/ObserveLogShell.ps1',
    '-Root',root,'-TargetPath',file(live),'-Action','file','-LogId',live.log_id],
    {windowsHide:true,encoding:'utf8',timeout:30000}),/PASS actual readable log and exact header/);
  assert.equal((await traces()).length,3);
  await ui.click('收起日志操作');
  await observeLogDirectory(ui,root,()=>ui.evaluate(`document.querySelector('.toolbar-log-directory').click()`));

  // The normal save workflow remains interactive and then emits the same card.
  const saved=path.join(saveRoot,'长文件名用于完整路径提示和宽度验证'.repeat(4)+'.log');
  await menu('保存终端缓冲内容…');
  assert.match(pick('TextLog','select',saved),/PASS native/);
  const feedback='[aria-label="日志保存反馈"]';
  await ui.waitFor(`document.querySelector(${JSON.stringify(feedback)})?.textContent.includes('日志已保存')`);
  await measure('save',feedback,720);
  await ui.screenshot('desktop-0.1.6-save-notice-narrow.png');
  await measure('save',feedback,1100);
  assert.ok((await readFile(saved)).length>0);
  assert.equal(await realpath(await ui.evaluate(`document.querySelector(${JSON.stringify(feedback+' .notice-ellipsis')}).title`)),await realpath(saved));
  for(const width of [720,1100]){
    const comparable=({width,height,padding,actionsBottom,actionsLeft})=>({width,height,padding,actionsBottom,actionsLeft});
    for(const kind of ['stop','error','save'])assert.deepEqual(comparable(measurements[kind+width]),comparable(measurements['start'+width]),kind+' '+width);
  }
  const close=await closeSoakDesktop(ui,root,service,{});
  await ui.close();ui=undefined;
  ui=await launchDesktop(root,{executable:desktop,webviewDirectory:path.join(root,'webview-third')});
  const restored=await ui.invoke('service_status');
  assert.deepEqual(await settings(),{executable:null,available:true});
  await idleClose(restored);
  report={result:'PASS',pickerCancelled:true,retainedAcrossRestart:true,customLaunches:3,singleArgument:true,missingShown:true,
    windowsDefaultObserved:true,resetPersisted:true,directoryExplorer:true,measurements,close};
}catch(error){
  if(ui)await ui.screenshot('desktop-0.1.6-log-viewer-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(fixture&&fixture.exitCode===null&&fixture.signalCode===null){
    const closed=new Promise(resolve=>fixture.once('exit',resolve));
    fixture.stdin.end();
    await closed;
  }
  for(const [directory,prefix] of [[root,'shared-terminal-log-viewer-ui-中文-'],[saveRoot,'shared-terminal-save-ui-中文-']]){
    assert.equal(path.dirname(directory),path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith(prefix));
    await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
}
await writeFile('artifacts/windows-0.1.6-log-viewer.json',JSON.stringify(report,null,2)+'\n');
console.log('PASS native viewer selection, exact one-argument launch, restart, missing/default and common notice geometry');
