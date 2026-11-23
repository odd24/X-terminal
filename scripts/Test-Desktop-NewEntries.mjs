import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const testService=path.join(path.dirname(executable),'session-service.exe');
const fixtureService=path.resolve('target/x86_64-pc-windows-msvc/debug/session-service.exe');
const fixtureHash=await hash(testService);
assert.equal(fixtureHash,await hash(fixtureService),'use the separately built memory UART test service');
const temp=path.resolve(tmpdir());
const root=await mkdtemp(path.join(temp,'shared-terminal-local-directory-中文-new-entries-'));
const evidence={result:'IN_PROGRESS',executable,desktopSha256:await hash(executable),fixtureSha256:fixtureHash,checks:[]};
let ui,peer,lines;
const q=JSON.stringify;
const rootMenu='.pane-active .new-menu';
const query=css=>`document.querySelector(${q(css)})`;
const control=label=>query(`[aria-label="${label}"]`);
const menu=query(rootMenu);
const opened=`${menu}?.open&&!!${query(rootMenu+' [data-positioned]')}`;
const localCount=()=>ui.evaluate('document.querySelectorAll(".local-terminal").length');
const points=async(element,fraction=.5)=>ui.evaluate(`(()=>{const r=(${element}).getBoundingClientRect();return {x:r.x+r.width*${fraction},y:r.y+r.height/2}})()`);
const move=point=>ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
async function click(point,count=1){
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:count,...point});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:count,...point});
}
async function key(key,code,windowsVirtualKeyCode){
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode});
}
async function tool(name){
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click(name);
}
const config=request=>ui.invoke('config_request',{request});
const profiles=async()=>(await config({op:'page',revision:null,offset:0,folders:false})).profiles;
const sessions=()=>ui.invoke('service_list');
const form=query('form[aria-label="配置编辑"]');
const ready=()=>ui.waitFor(`${form}?.querySelector('fieldset')?.disabled===false`);
async function openForm(label){
  await ui.evaluate(`${control('新建会话配置')}.click()`);
  await ui.click(label);
  await ready();
}
async function sshFields(name,port){
  await ui.fill('配置名称',name);await ui.fill('主机','127.0.0.1');await ui.fill('用户名','synthetic');await ui.fill('端口',String(port));
}
async function serialFields(name){await ui.fill('配置名称',name);await ui.fill('串口标识','COM7');}
async function localReady(count,pane){
  await ui.waitFor(`document.querySelectorAll('.local-terminal').length===${count}&&document.activeElement?.matches('.pane-active .local-terminal:not([hidden]) .xterm-helper-textarea')`);
  if(pane)assert.equal(await ui.evaluate("document.querySelector('.pane-active').dataset.pane"),pane);
}
async function checkDirectory(expected,tag){
  const output=query('.pane-active .local-terminal:not([hidden]) .local-terminal-output');
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${output}?.innerText??'')`);
  const file=path.join(root,tag+'.txt');
  await ui.command('Input.insertText',{text:`Set-Content -LiteralPath '${file.replaceAll("'","''")}' -Value (Get-Location).Path -Encoding UTF8`});
  await key('Enter','Enter',13);
  for(let n=0;n<120;n++){
    const actual=(await readFile(file,'utf8').catch(()=>'' )).replace(/^\uFEFF/,'').trim();
    if(actual){assert.equal(await realpath(actual),expected);return;}
    await delay(50);
  }
  assert.fail('PowerShell did not report its working directory');
}
async function nextPeer(){
  let timer;
  try{return await Promise.race([lines.next().then(line=>JSON.parse(line.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSH fixture timeout')),7000);})]);}
  finally{clearTimeout(timer);}
}
const metric=async()=>{peer.stdin.write('{"op":"metrics"}\n');return nextPeer();};
try{
  await mkdir(path.join(root,'默认目录'));
  const directory=await realpath(path.join(root,'默认目录'));
  peer=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[root],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  lines=createInterface({input:peer.stdout})[Symbol.asyncIterator]();
  const server=await nextPeer();
  ui=await launchDesktop(root,{executable,fixture:true});
  assert.equal((await ui.invoke('service_status')).fixture,true);
  const inventory=await ui.invoke('serial_request',{request:{op:'inventory'}});
  assert.equal(inventory.result,'inventory');
  assert.deepEqual(inventory.devices.map(device=>[device.port,device.instance_id]),[['COM7','SYNTHETIC-TEST-INSTANCE']]);
  assert.deepEqual(inventory.unidentified_ports,['COM99']);
  await tool('软件设置');await ui.waitFor("!!document.querySelector('dialog:modal[aria-label=软件设置]')");
  await ui.evaluate("[...document.querySelectorAll('dialog:modal[aria-label=软件设置] button')].find(button=>button.textContent==='本地终端').click()");
  await ui.waitFor(`!!${control('默认目录')}&&${control('默认目录')}.textContent!=='正在读取…'`);
  await ui.click('选择文件夹');
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/NativeImportDialog.ps1','-TargetProcessId',String(ui.app.pid),
    '-Root',root,'-Purpose','LocalDirectory','-Action','select','-TargetPath',path.join(root,'默认目录')],{windowsHide:true,timeout:18000});
  await ui.waitFor(`${control('默认目录')}?.textContent===${q(directory)}`);
  await ui.click('关闭软件设置');
  await tool('轻量命令行');
  await localReady(1);
  await ui.command('Page.bringToFront');
  await ui.evaluate(`window.plusPointerEvents=[]; for(const type of ['pointerover','pointerout'])document.addEventListener(type,event=>{
    if(event.target.closest('.new-menu')&&window.plusPointerEvents.length<20)
      window.plusPointerEvents.push([type,event.pointerType,event.clientX,event.clientY]);
  },true)`);

  const plus=await points(query(rootMenu+' > summary'));
  const leave=async()=>{
    await move({x:20,y:260});
    await ui.waitFor(`!${menu}.matches(':hover')`);
  };
  async function hover(){
    for(let n=0;n<4;n++){
      await leave();await move(plus);
      await delay(430);
      if(await ui.evaluate(opened))return;
      assert.equal(await ui.evaluate(`${menu}.matches(':hover')`),false,'a continuous hover must open the menu');
    }
    assert.fail('Another pointer moved the cursor during each hover attempt');
  }
  await leave();
  await move(plus);await delay(160);assert.equal(await ui.evaluate(`${menu}.open`),false);
  await leave();await delay(390);assert.equal(await ui.evaluate(`${menu}.open`),false);
  await hover();
  assert.deepEqual(await ui.evaluate(`[...${menu}.querySelectorAll('button')].map(b=>b.textContent)`),['本地终端','SSH 连接','串口连接']);
  await ui.screenshot('windows-0.1.23-tab-plus-menu.png');
  await move(await points(query(rootMenu+' .tools-menu-content > button')));
  await delay(200);assert.equal(await ui.evaluate(`${menu}.open`),true);
  await leave();await ui.waitFor(`!${menu}.open`);
  await hover();await key('Escape','Escape',27);
  await ui.waitFor(`!${menu}.open`);await delay(400);assert.equal(await ui.evaluate(`${menu}.open`),false);
  await hover();
  await click(plus);await click(plus,2);await localReady(2);
  assert.equal(await localCount(),2);
  assert.equal(await ui.evaluate("document.querySelector('.pane-active .local-terminal:not([hidden])').dataset.mode"),'powershell');
  await checkDirectory(directory,'clicked');
  await ui.evaluate(`${query(rootMenu+' > summary')}.focus()`);
  await key('ArrowDown','ArrowDown',40);
  await ui.waitFor("document.activeElement?.textContent==='本地终端'");
  await key('Escape','Escape',27);
  await ui.waitFor(`document.activeElement===${query(rootMenu+' > summary')}&&!${menu}.open`);
  await key('Enter','Enter',13);await localReady(3);
  const start=await points(query('[role=tab]'));
  const edge=await points(query('.pane-active .local-pane-body'),.88);
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...start});
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...edge});
  await ui.waitFor("!!document.querySelector('.tab-split-preview[data-edge=right]')");
  await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...edge});
  await ui.waitFor("document.querySelectorAll('[data-pane]').length===2");
  const inactive=await ui.evaluate("document.querySelector('[data-pane]:not(.pane-active)').dataset.pane");
  await click(await points(query(`[data-pane="${inactive}"] .new-menu > summary`)));
  await localReady(4,inactive);
  await checkDirectory(directory,'split');
  evidence.checks.push('hover delay, gap and leave, Escape, ArrowDown, default Enter, one-click PowerShell, configured directory, split destination and input focus');

  const folder={id:crypto.randomUUID(),parent_id:null,name:'测试目录'};
  await config({op:'save_folder',folder});await ui.click('刷新会话树');
  await ui.waitFor(`!!${query('[data-folder-id="'+folder.id+'"] button')}`);
  await ui.evaluate(`${query('[data-folder-id="'+folder.id+'"] button')}.click()`);
  await openForm('新建 SSH 配置');
  assert.equal(await ui.evaluate(`${control('所属目录')}.value`),folder.id);
  await sshFields('只保存 SSH',server.port);await ui.click('保存');
  await ui.waitFor(`!${form}`);
  assert.equal((await profiles()).find(p=>p.name==='只保存 SSH').folder_id,folder.id);
  assert.equal((await metric()).accepted_connections,0);
  await openForm('新建 SSH 配置');await sshFields('取消 SSH',server.port);await key('Escape','Escape',27);
  await ui.waitFor(`!${form}`);
  assert.ok(!(await profiles()).some(p=>p.name==='取消 SSH'));
  await openForm('新建 SSH 配置');await sshFields('   ',server.port);await ui.click('保存并连接');
  await ui.waitFor(`${control('配置状态')}?.textContent.includes('没有发起连接')`);
  assert.equal((await metric()).accepted_connections,0);
  await ui.click('关闭配置');
  await openForm('新建 SSH 配置');await sshFields('SSH 丢失回执',server.port);
  const lost=await ui.interceptIpc({command:'config_request',op:'save_profile',mode:'hold_error'});
  try{
    await ui.evaluate(`(()=>{const b=[...${form}.querySelectorAll('button')].find(b=>b.value==='connect');b.click();b.click();})()`);
    for(let n=0;n<120&&!(await lost.count());n++)await delay(50);
    assert.equal(await lost.count(),1);
    await lost.release();
    await ui.waitFor(`${control('配置状态')}?.textContent.includes('保存结果不明')`);
    assert.equal(await lost.count(),1);
  }finally{await lost.restore();}
  await ui.click('关闭配置');
  assert.ok((await profiles()).some(p=>p.name==='SSH 丢失回执'));
  assert.equal((await metric()).accepted_connections,0);

  await openForm('新建 SSH 配置');await sshFields('保存途中关闭',server.port);
  const held=await ui.interceptIpc({command:'config_request',op:'save_profile',mode:'hold'});
  try{
    await ui.click('保存并连接');
    for(let n=0;n<120&&!(await held.count());n++)await delay(50);
    assert.equal(await held.count(),1);
    await ui.click('关闭配置');
    await ui.waitFor(`!${form}`);
    await held.release();
    await ui.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await ui.evaluate("!!document.querySelector('dialog:modal')"),false);
  }finally{await held.restore();}
  assert.ok((await profiles()).some(p=>p.name==='保存途中关闭'));
  assert.equal((await metric()).accepted_connections,0);

  await openForm('新建 SSH 配置');await sshFields('拒绝主机仍保留',server.port);await ui.click('保存并连接');
  await ui.waitFor(`!!${control('快速连接核对指纹')}`);
  await ui.click('拒绝连接');
  await ui.waitFor("document.body.innerText.includes('未信任此服务器')");
  assert.ok((await profiles()).some(p=>p.name==='拒绝主机仍保留'));
  await ui.click('收起连接窗口');
  await ui.waitFor("!document.querySelector('dialog:modal')");
  await openForm('新建 SSH 配置');await sshFields('成功 SSH',server.port);await ui.click('保存并连接');
  await ui.waitFor(`!!${control('快速连接核对指纹')}`);
  assert.equal(await ui.evaluate("document.querySelector('dialog .fingerprint').textContent"),server.pin);
  await ui.evaluate(`${control('快速连接核对指纹')}.click()`);
  await ui.click('信任并继续登录');
  await ui.waitFor("document.querySelector('dialog .primary-action')?.textContent==='提交本次登录信息'");
  await ui.fill('SSH登录密码',server.password);await ui.click('提交本次登录信息');
  for(let n=0;n<140&&!(await sessions()).some(s=>s.protocol==='SSH2'&&s.state==='CONNECTED');n++)await delay(60);
  assert.ok((await sessions()).some(s=>s.protocol==='SSH2'&&s.state==='CONNECTED'));
  await ui.waitFor("!document.querySelector('dialog:modal')");
  evidence.checks.push('SSH save only, cancel before and during save, validation rejection, lost reply, duplicate click, host rejection retention and trusted authentication');

  await ui.click('根目录');
  await openForm('新建串口配置');assert.equal(await ui.evaluate(`${control('所属目录')}.value`),'');
  await serialFields('只保存串口');await ui.screenshot('windows-0.1.23-tree-serial-form.png');await ui.click('保存');await ui.waitFor(`!${form}`);
  assert.equal((await profiles()).find(p=>p.name==='只保存串口').folder_id,null);
  assert.ok(!(await sessions()).some(s=>s.protocol==='SERIAL'));
  await openForm('新建串口配置');await serialFields('取消串口连接仍保留');await ui.click('保存并连接');
  await ui.waitFor(`${control('UART端口')}?.options.length===2&&!${control('UART端口')}.disabled`);
  await ui.evaluate("document.querySelector('dialog .primary-action').click()");
  assert.ok(!(await sessions()).some(s=>s.protocol==='SERIAL'));
  await ui.click('取消连接窗口');
  await ui.waitFor("!document.querySelector('dialog:modal')");
  assert.ok((await profiles()).some(p=>p.name==='取消串口连接仍保留'));
  await openForm('新建串口配置');await serialFields('连接内存串口');await ui.click('保存并连接');
  await ui.waitFor(`${control('UART端口')}?.options.length===2&&!${control('UART端口')}.disabled`);
  const saved=(await profiles()).find(p=>p.name==='连接内存串口');
  assert.equal(await ui.evaluate(`${control('串口已保存连接')}.value`),saved.id);
  assert.ok(!(await sessions()).some(s=>s.protocol==='SERIAL'));
  await ui.fill('UART端口',await ui.evaluate(`${control('UART端口')}.options[1].value`));
  await ui.click('连接串口');
  for(let n=0;n<140&&!(await sessions()).some(s=>s.protocol==='SERIAL'&&s.state==='CONNECTED');n++)await delay(60);
  const connected=(await sessions()).find(s=>s.protocol==='SERIAL'&&s.state==='CONNECTED');
  assert.ok(connected);
  assert.equal((await ui.invoke('serial_request',{request:{op:'status',connection:{connection_id:connected.connection_id,generation:connected.generation}}})).profile_id,saved.id);
  await ui.waitFor("!document.querySelector('dialog:modal')");
  await openForm('新建串口配置');await serialFields('串口占用仍保留');await ui.click('保存并连接');
  await ui.waitFor(`${control('UART端口')}?.options.length===2&&!${control('UART端口')}.disabled`);
  await ui.fill('UART端口',await ui.evaluate(`${control('UART端口')}.options[1].value`));
  await ui.click('连接串口');
  await ui.waitFor("!!document.querySelector('dialog:modal [role=alert]')");
  assert.equal((await sessions()).filter(s=>s.protocol==='SERIAL'&&s.state==='CONNECTED').length,1);
  assert.ok((await profiles()).some(p=>p.name==='串口占用仍保留'));
  await ui.click('取消连接窗口');
  evidence.checks.push('serial save only, exact saved profile, explicit inventory, memory UART connection and busy-port rejection with preserved profile');
  await tool('退出桌面');
  await ui.waitFor(`!!${query('dialog:modal[aria-label="退出桌面确认"]')}`);
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  evidence.result='PASS';
  console.log('PASS Windows tab and configuration plus entry points');
}catch(error){
  evidence.result='FAIL';evidence.error=String(error.stack);
  if(ui)evidence.pointerEvents=await ui.evaluate('window.plusPointerEvents').catch(()=>undefined);
  await ui?.screenshot('windows-0.1.23-new-entries-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  if(peer&&peer.exitCode===null){const ended=new Promise(resolve=>peer.once('exit',resolve));peer.stdin.end();await ended;}
  await writeFile('artifacts/windows-0.1.23-new-entries-result.json',JSON.stringify(evidence,null,2)+'\n');
  assert.equal(path.dirname(root),temp);
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
