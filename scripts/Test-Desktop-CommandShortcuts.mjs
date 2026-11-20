import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { active, desktopKeyboard, terminalInput } from './lib/DesktopKeyboard.mjs';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { closeSoakDesktop } from './lib/LoadSoak.mjs';

const artifact = 'P19-command-shortcuts';
const preview = JSON.parse(await readFile(`artifacts/${artifact}-preview.json`, 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file=>file.name).sort(),
  ['session-service.exe','shared-terminal-desktop.exe','terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory,file.name));
  assert.equal(bytes.length,file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
}
const packaged = JSON.parse(await readFile(path.join(preview.directory,'manifest.json'),'utf8'));
assert.deepEqual(packaged.files,preview.files);

const prefix='shared-terminal-command-shortcuts-中文-';
const root=await mkdtemp(path.join(tmpdir(),prefix));
const peer=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[root],
  { windowsHide:true,stdio:['pipe','pipe','ignore'] });
const ended=new Promise(resolve=>peer.once('close',resolve));
let launchError;
peer.on('error',error=>{launchError=error;});
const lines=createInterface({input:peer.stdout})[Symbol.asyncIterator]();
async function peerReply() {
  let timer;
  try {
    const reply=await Promise.race([lines.next(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('SSH fixture response timed out')),10000);
    })]);
    if(launchError)throw launchError;
    assert.equal(reply.done,false);
    return JSON.parse(reply.value);
  } finally {clearTimeout(timer);}
}
async function peerBytes() {
  peer.stdin.write('{"op":"metrics"}\n');
  return Buffer.from((await peerReply()).received.flat());
}
const query=selector=>`document.querySelector(${JSON.stringify(selector)})`;
const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
const shortcutGroup='[aria-label="命令快捷键"]';
const slot=key=>`${shortcutGroup} button[aria-keyshortcuts="${key}"]`;
const selection='[aria-label="常用命令列表"]';
const variable='[aria-label="命令变量 word"]';
const replace='[aria-label="替换当前撰写草稿"]';
let ui,result;

try {
  const server=await peerReply();
  ui=await launchDesktop(root,{executable:path.join(preview.directory,'shared-terminal-desktop.exe')});
  const owner=await ui.invoke('service_status');
  assert.equal(owner.fixture,false);
  const config=request=>ui.invoke('config_request',{request});
  const { key,type,enter,tabTo }=desktopKeyboard(ui,[]);
  const digit=keyValue=>key(keyValue,`Digit${keyValue}`,Number(keyValue)+48,{text:keyValue});
  const menu=async label=>{await ui.evaluate("document.querySelector('.tools-menu').open=true");await ui.click(label);};
  const first={id:'00000000-0000-4000-8000-000000000001',group:'甲组',name:'同名命令',template:'first {{word}}',ending:'none'};
  const second={id:'00000000-0000-4000-8000-000000000002',group:'乙组',name:'同名命令',template:'second {{word}}',ending:'lf'};
  for(const command of [first,second]){
    const library=await config({op:'quick_commands'});
    assert.equal((await config({op:'save_quick_command',command,revision:library.revision})).result,'quick_commands');
  }
  const library=await config({op:'quick_commands'});
  assert.deepEqual(library.commands,[first,second]);
  const openCommands=async ()=>{
    await key('K','KeyK',75,{modifiers:10});
    await ui.waitFor(`!!${query(slot(1))} && !${query(slot(1))}.disabled`);
    await tabTo(active(slot(1)),'first command shortcut');
  };
  const selected=()=>ui.evaluate(`${query(selection)}.value`);

  await ui.click('连接服务器');
  await ui.waitFor(`!!${query('[aria-label="SSH服务器"]:not([disabled])')}`);
  await ui.fill('SSH服务器','127.0.0.1');
  await ui.fill('SSH用户名','synthetic');
  await ui.evaluate(`[...document.querySelectorAll('summary')].find(node=>node.textContent==='高级连接设置').parentElement.open=true`);
  await ui.fill('SSH端口',String(server.port));
  await ui.click('连接');
  const fingerprint='[aria-label="快速连接核对指纹"]';
  await ui.waitFor(`!!${query(fingerprint)}`);
  assert.equal(await ui.evaluate(`document.querySelector('dialog:modal .fingerprint').textContent`),server.pin);
  await ui.evaluate(`${query(fingerprint)}.click()`);
  await ui.click('信任并继续登录');
  const password='[aria-label="SSH登录密码"]';
  await ui.waitFor(active(password));
  await digit('2');
  assert.equal(await ui.evaluate(`${query(password)}.value.length`),1);
  assert.equal(await ui.evaluate(`!!${query(shortcutGroup)}`),false);
  await ui.fill('SSH登录密码',server.password);
  await enter();
  await ui.waitFor(`!document.querySelector('dialog:modal')&&${active(terminalInput)}`);
  const [connection,...others]=await ui.invoke('service_list');
  assert.deepEqual(others,[]);
  assert.equal(connection.protocol,'SSH2');
  assert.equal(connection.state,'CONNECTED');

  await digit('3');
  for(let attempt=0;attempt<100 && !(await peerBytes()).length;attempt++)await delay(20);
  assert.deepEqual(await peerBytes(),Buffer.from('3'));
  await menu('基础撰写');
  await ui.fill('撰写正文','keep existing draft');
  await ui.click('关闭撰写');
  await openCommands();
  await digit('1');
  assert.equal(await selected(),first.id);
  await ui.fill('命令变量 word','old');
  await ui.evaluate(`${query(variable)}.focus()`);
  await digit('2');
  assert.equal(await ui.evaluate(`${query(variable)}.value`),'old2');
  assert.equal(await selected(),first.id);
  await ui.evaluate(`${query(replace)}.click()`);
  await ui.evaluate(`${query(slot(1))}.focus()`);
  for(const guard of ['repeat','isComposing','ctrlKey']){
    await ui.evaluate(`${query(slot(1))}.dispatchEvent(new KeyboardEvent('keydown',
      {key:'2',bubbles:true,${guard}:true}))`);
    assert.equal(await selected(),first.id);
  }
  await digit('2');
  assert.equal(await selected(),second.id);
  assert.equal(await ui.evaluate(active(slot(2))),true);
  assert.equal(await ui.evaluate(`${query(variable)}.value`),'');
  assert.equal(await ui.evaluate(`${query(replace)}.checked`),false);
  assert.equal(await ui.evaluate(`${button('准备到撰写')}.disabled`),true);
  await ui.fill('常用命令分组','乙组');
  assert.equal(await selected(),'');
  await tabTo(active(slot(1)),'filtered command shortcut');
  await digit('2');
  assert.equal(await selected(),'');
  await digit('1');
  assert.equal(await selected(),second.id);
  assert.deepEqual(await peerBytes(),Buffer.from('3'));
  await ui.screenshot(`${artifact}-selection.png`);
  await ui.fill('命令变量 word','literal {{word}}');
  await ui.click('准备到多目标');
  await ui.waitFor(`${query('[aria-label="多目标正文"]')}?.value==='second literal {{word}}'`);
  assert.equal(await ui.evaluate(`document.querySelectorAll('[aria-label^="多目标选择 "]:checked').length`),0);
  assert.equal(await ui.evaluate(`!!${query('[aria-label="多目标发送预览"]')}`),false);
  await ui.click('关闭多目标发送');
  await openCommands();
  assert.equal(await selected(),'');
  await digit('2');
  assert.equal(await selected(),second.id);
  assert.equal(await ui.evaluate(`${query(variable)}.value`),'');
  await ui.fill('命令变量 word','fresh');
  await ui.evaluate(`${query(replace)}.click()`);
  await ui.click('准备到撰写');
  await ui.waitFor(`${query('[aria-label="撰写正文"]')}?.value==='second fresh'`);
  assert.equal(await ui.evaluate(`!!${button('确认发送撰写')}`),false);
  assert.deepEqual(await peerBytes(),Buffer.from('3'));
  await ui.click('预览撰写发送');
  await ui.waitFor(`!!${button('确认发送撰写')}`);
  assert.deepEqual(await peerBytes(),Buffer.from('3'));
  await ui.click('确认发送撰写');
  const expected=Buffer.from('3second fresh\n');
  for(let attempt=0;attempt<100 && (await peerBytes()).length<expected.length;attempt++)await delay(20);
  assert.deepEqual(await peerBytes(),expected);
  assert.deepEqual((await config({op:'quick_commands'})).commands,library.commands);
  await ui.click('关闭撰写');
  const close=await closeSoakDesktop(ui,root,owner,{});
  await ui.close();ui=undefined;
  peer.stdin.end();
  assert.equal(await ended,0);
  result={result:'PASS',build:packaged.packagedFromHead,preview:preview.directory,fixture:false,
    selectedByExactId:true,filteredGroup:true,draftConsentReset:true,noPreparationSend:true,
    emptyBatchTargets:true,terminalAndAuthDigitsUnchanged:true,peerBytes:expected.length,
    commandLibraryUnchanged:true,close};
} catch(error){
  console.error('P19 owned failed root retained:',root);
  if(ui)await ui.screenshot(`${artifact}-failure.png`).catch(()=>{});
  throw error;
} finally {
  try{await ui?.close();}
  finally{
    if(peer.exitCode===null&&peer.signalCode===null&&!launchError)peer.kill();
    await ended;
  }
}
const owned=await realpath(root);
assert.equal(path.dirname(owned),await realpath(tmpdir()));
assert.ok(path.basename(owned).startsWith(prefix));
await rm(owned,{recursive:true,force:true,maxRetries:10,retryDelay:100});
await writeFile(`artifacts/${artifact}.json`,JSON.stringify(result,null,2)+'\n');
console.log('PASS ordinary panel shortcut selection, scoped keyboard input, and explicit single-target confirmation');
