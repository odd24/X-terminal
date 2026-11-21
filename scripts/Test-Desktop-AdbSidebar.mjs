import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {delay, launchDesktop} from './lib/DesktopHarness.mjs';

const root = await mkdtemp(path.join(await realpath(tmpdir()), 'shared-terminal-adb-sidebar-中文-'));
const executable = path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const previous = path.resolve('artifacts/SharedTerminal-0.1.13-windows-x64/shared-terminal-desktop.exe');
const fixtures = [];
const result = {result:'IN_PROGRESS', executable, measurements:{}};
const long = 'adb shell echo "'+'固定路径含有空格 '.repeat(15)+'结束"';
let ui;
const resize = async (width,height) => {
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),
    '-ExpectedExecutable',executable,'-Width',String(width),'-Height',String(height)],{windowsHide:true});
  await ui.waitFor(`Math.abs(innerWidth-${width})<=24`);
};
const bounds = () => ui.evaluate(`(()=>{
  const pane=document.querySelector('.pane-active'), body=pane.querySelector('.local-pane-body');
  const rect=node=>node?.getBoundingClientRect().toJSON()??null;
  const panel=body.querySelector('.adb-shortcut-panel:not([hidden])');
  return {body:rect(body), terminal:rect(body.querySelector('.local-terminal:not([hidden]) .local-terminal-output')),
    panel:rect(panel), position:panel&&getComputedStyle(panel).position,
    toggle:rect(pane.querySelector('.adb-panel-toggle')), rail:rect(pane.querySelector('.pane-tab-bar')),
    top:rect(document.querySelector('.window-chrome')), bar:rect(document.querySelector('.app-bar')),
    other:rect(document.querySelector('.terminal-pane:not(.pane-active)'))};
})()`);
const nonOverlapping = (a,b) => a.right<=b.left+.5||a.left>=b.right-.5||a.bottom<=b.top+.5||a.top>=b.bottom-.5;

async function exit(expectConfirm) {
  await ui.evaluate("document.querySelector('details.tools-menu summary').click()");
  await ui.click('退出桌面');
  if(expectConfirm) {
    await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
    await ui.click('确认退出并停止服务');
  }
  for(let n=0;n<160&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
}
async function launchSsh(name) {
  const fixtureRoot=path.join(root,name);
  await mkdir(fixtureRoot);
  const child=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[fixtureRoot],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],
  });
  fixtures.push(child);
  const lines=createInterface({input:child.stdout});
  const [line]=await once(lines,'line',{signal:AbortSignal.timeout(8000)});
  const server=JSON.parse(line);
  const profile={id:crypto.randomUUID(),folder_id:null,name,settings:{
    protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8',
  }};
  await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',
    value:{password:server.password,private_key:null,passphrase:null}}}});
  const ssh=request=>ui.invoke('ssh_request',{request});
  const started=await ssh({op:'start',profile_id:profile.id,request_id:crypto.randomUUID(),cols:80,rows:24});
  const connection={connection_id:started.connection.connection_id,generation:started.connection.generation};
  const answered=new Set();
  for(let n=0;n<150;n++){
    const status=await ssh({op:'status',connection});
    if(status.connection.state==='CONNECTED')return connection.connection_id;
    assert.notEqual(status.connection.state,'FAILED');
    const challenge=status.challenge;
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,server.pin);
        await ssh({op:'answer_host',connection,challenge_id:challenge.id,approve:true});
      }else if(challenge.kind==='credentials'){
        await ssh({op:'authenticate',connection,challenge_id:challenge.id,use_saved:true,password:null});
      }
    }
    await delay(40);
  }
  throw new Error('loopback SSH fixture login timed out');
}

try {
  const adb=path.join(root,'adb.exe');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true});
  ui=await launchDesktop(root,{executable:previous,webviewDirectory:path.join(root,'webview-previous')});
  const oldSettings=await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts:[
    {id:crypto.randomUUID(),name:'设备列表',command:'adb devices -l'},
    {id:crypto.randomUUID(),name:'导出调试文件',command:'adb pull "/sdcard/Download/report.txt" "./调试 文件.txt"'},
    {id:crypto.randomUUID(),name:'完整命令换行预览',command:long},
  ]}});
  await exit(false);
  ui=await launchDesktop(root,{executable});
  await resize(1100,760);
  await ui.click('本地命令行');
  await ui.waitFor('document.activeElement?.matches("[aria-label=\'本地命令输入\']")');
  assert.deepEqual(await ui.invoke('local_adb_settings',{settings:null}),oldSettings);
  const closed=await bounds();
  assert.ok(closed.body.width>760);
  assert.equal(closed.panel,null);
  assert.ok(Math.abs(closed.terminal.width-closed.body.width)<1);
  assert.ok(Math.abs(closed.toggle.right-closed.rail.right)<14);
  assert.ok(closed.toggle.top>=closed.rail.top-.5&&closed.toggle.bottom<=closed.rail.bottom+.5);
  await ui.click('快捷指令');
  await ui.waitFor('!!document.querySelector(".adb-shortcut-run")');
  const wide=await bounds();
  assert.equal(wide.position,'static');
  assert.ok(Math.abs(wide.panel.width-300)<1);
  assert.ok(Math.abs(wide.terminal.width+300-closed.terminal.width)<1);
  assert.deepEqual(wide.top,closed.top);
  assert.deepEqual(wide.bar,closed.bar);
  assert.ok(await ui.evaluate(`(()=>{const code=document.querySelector('.adb-shortcut-run[aria-label="完整命令换行预览"] code');
    return code.scrollWidth>code.clientWidth&&getComputedStyle(code).textOverflow==='ellipsis';})()`));
  assert.equal(await ui.evaluate('!!document.querySelector(".local-adb-actions, dialog[aria-label=\'ADB 快捷操作设置\']")'),false);
  result.measurements.wide=wide;
  await ui.screenshot('windows-0.1.14-adb-sidebar-wide.png');
  await ui.click('完整命令换行预览 的管理操作');
  await ui.waitFor('!!document.querySelector(".adb-row-menu[data-positioned]")');
  const menuHit=await ui.evaluate(`(()=>{
    const item=document.querySelector('.adb-row-menu button'),box=item.getBoundingClientRect();
    return document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===item;
  })()`);
  assert.equal(menuHit,true);
  await ui.evaluate("document.querySelector('.adb-row-menu button').click()");
  const editor=await ui.evaluate(`(()=>{
    const field=document.querySelector('[aria-label="完整 ADB 命令"]'),style=getComputedStyle(field);
    return {text:field.value, wrap:field.wrap, font:style.fontFamily, width:field.clientWidth, scrollWidth:field.scrollWidth,
      panelWidth:field.closest('.adb-shortcut-panel').clientWidth, dialog:!!field.closest('dialog')};
  })()`);
  assert.equal(editor.text,long);
  assert.equal(editor.wrap,'soft');
  assert.equal(editor.dialog,false);
  assert.ok(/mono|Consolas/i.test(editor.font));
  assert.ok(editor.width>editor.panelWidth-36&&editor.scrollWidth<=editor.width+1);
  await ui.screenshot('windows-0.1.14-adb-sidebar-editor.png');
  await ui.click('取消编辑');

  await resize(720,540);
  const narrow=await bounds();
  assert.equal(narrow.position,'absolute');
  assert.ok(Math.abs(narrow.terminal.width-narrow.body.width)<1);
  assert.ok(Math.abs(narrow.panel.right-narrow.body.right)<1&&narrow.panel.left>=narrow.body.left-.5);
  result.measurements.narrow=narrow;
  await ui.screenshot('windows-0.1.14-adb-sidebar-narrow.png');
  await ui.click('收起快捷指令');
  assert.equal((await bounds()).panel,null);
  await resize(1100,760);
  assert.ok(Math.abs((await bounds()).terminal.width-closed.terminal.width)<1);

  const first=await launchSsh('first-ssh');
  const second=await launchSsh('second-ssh');
  await ui.selectTab(first);
  await ui.waitFor(`document.querySelector('.pane-active')?.dataset.renderedId===${JSON.stringify(first)}`);
  await ui.splitTab(second,'horizontal');
  await ui.waitFor('document.querySelectorAll(".terminal-pane").length===2');
  await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");
  await ui.click('本地命令行');
  await ui.waitFor('document.activeElement?.matches("[aria-label=\'本地命令输入\']")');
  await ui.evaluate("if(document.querySelector('.pane-active .adb-panel-toggle').getAttribute('aria-expanded')==='false')document.querySelector('.pane-active .adb-panel-toggle').click()");
  const split=await bounds();
  assert.equal(split.position,'absolute');
  assert.ok(Math.abs(split.terminal.width-split.body.width)<1);
  assert.ok(nonOverlapping(split.panel,split.other));
  result.measurements.split=split;
  await ui.screenshot('windows-0.1.14-adb-sidebar-split.png');
  await ui.evaluate("document.querySelector('.pane-active .adb-panel-toggle').click()");
  assert.equal((await bounds()).panel,null);
  await exit(true);
  ui=await launchDesktop(root,{executable});
  await ui.click('本地命令行');
  await ui.waitFor('!!document.querySelector(".adb-panel-toggle")');
  assert.equal(await ui.evaluate('document.querySelector(".adb-panel-toggle").getAttribute("aria-expanded")'),'false');
  assert.deepEqual(await ui.invoke('local_adb_settings',{settings:null}),oldSettings);
  await exit(true);
  result.result='PASS';
  result.verified=['0.1.13 settings read unchanged','wide 300px dock and reclaimed space','narrow and split overlay bounded to pane',
    'tab-row toggle and global toolbar geometry','ellipsis and soft-wrap inline editor','positioned management menu','collapsed state survives restart'];
} catch(error) {
  result.result='FAIL';
  result.error=String(error.stack);
  if(ui)await ui.screenshot('windows-0.1.14-adb-sidebar-failure.png').catch(()=>{});
  throw error;
} finally {
  await writeFile('artifacts/windows-0.1.14-adb-sidebar-layout.json',JSON.stringify(result,null,2));
  await ui?.close();
  for(const child of fixtures)if(child.exitCode===null){child.stdin.end();await once(child,'exit');}
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
