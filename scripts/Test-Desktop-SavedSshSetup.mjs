import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSshFixtureScope,delay,desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';
import {desktopKeyboard} from './lib/DesktopKeyboard.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-saved-ssh-ui-'));
const result={...await desktopEvidence(executable),scope:'Windows WebView2 with owned SSH loopback and CDP keyboard',checks:[]};
const dialog='document.querySelector(\'dialog[open]:is(:modal,[aria-label="连接服务器"])\')';
const named=label=>'document.querySelector('+JSON.stringify('[aria-label="'+label+'"]')+')';
const leaf=id=>'document.querySelector('+JSON.stringify('[data-profile-id="'+id+'"]')+')';
let ui,originalScope,replacementScope;
const ssh=request=>ui.invoke('ssh_request',{request});
const cfg=request=>ui.invoke('config_request',{request});
const list=()=>ui.invoke('service_list');
const profiles=async()=>(await cfg({op:'page',revision:null,offset:0,folders:false})).profiles;
const pins=async()=>(await cfg({op:'host_keys_page',revision:null,offset:0})).keys;
const summarize=(name)=>result.checks.push(name);
const current=async()=>{
  const id=await ui.evaluate('document.querySelector(".pane-active [role=tab][aria-selected=true]")?.dataset.connectionId');
  return (await list()).find(item=>item.connection_id===id);
};
const reference=({connection_id,generation})=>({connection_id,generation});
const settle=async check=>{
  for(let attempt=0;attempt<160;attempt++){
    const value=await check();if(value)return value;await delay(45);
  }
  assert.fail('Owned SSH operation did not settle');
};
async function status(ref){
  return ssh({op:'status',connection:ref});
}
const enter=()=>desktopKeyboard(ui,[]).enter();
async function create(name,port){
  await ui.evaluate('document.querySelector(".tree-new-menu").open=true');
  await ui.click('新建 SSH 配置');
  await ui.waitFor(named('配置名称')+'&&!'+named('配置名称')+'.matches(":disabled")');
  await ui.fill('配置名称',name);
  await ui.fill('主机','127.0.0.1');
  await ui.fill('端口',port);
  await ui.fill('用户名','synthetic');
}
async function activate(profile){
  await ui.waitFor('!!'+leaf(profile.id));
  await ui.evaluate(leaf(profile.id)+'.focus();'+leaf(profile.id)+
    '.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
}
async function awaitTree(profile){
  await ui.waitFor('!'+dialog+'&&'+leaf(profile.id)+'?.ariaPressed==="true"&&document.activeElement==='+leaf(profile.id));
}
async function awaitHost(pin,changed=false){
  await ui.waitFor(named('当前服务器指纹')+'?.textContent==='+JSON.stringify(pin));
  await ui.waitFor('document.activeElement?.textContent==='+JSON.stringify(changed?'停止连接':'暂不连接'));
  assert.match(await ui.evaluate(dialog+'.innerText'),/配置已保存/);
  assert.equal(await ui.evaluate('!!'+named('快速连接核对指纹')),false);
  assert.equal(await ui.evaluate(dialog+'.scrollWidth<='+dialog+'.clientWidth'),true);
  return reference(await settle(current));
}
async function awaitPassword(port){
  await ui.waitFor(named('SSH密码目标')+'?.textContent==='+JSON.stringify('synthetic@127.0.0.1:'+port));
  await ui.waitFor('document.activeElement==='+named('SSH登录密码'));
  assert.equal(await ui.evaluate(named('记住SSH凭据')+'.checked'),false);
  assert.equal(await ui.evaluate('!!'+named('SSH服务器')),false);
}
async function connected(){
  await ui.waitFor('!'+dialog+'&&document.activeElement?.classList.contains("xterm-helper-textarea")');
  return settle(async()=>{
    const value=await current();return value?.state==='CONNECTED'?reference(value):undefined;
  });
}
async function disconnected(ref){
  await settle(async()=>['DISCONNECTED','FAILED'].includes((await status(ref)).connection.state));
}

try{
  originalScope=await createSshFixtureScope('saved-ssh-host-owner-');
  const original=await originalScope.start('initial');
  ui=await launchDesktop(root,{executable,windowsHide:false});
  if(await ui.evaluate('document.querySelector(".sidebar-toggle")?.ariaExpanded==="false"'))await ui.click('会话导航');
  const folder={id:randomUUID(),name:'SSH 夹具目录',parent_id:null};
  await cfg({op:'save_folder',folder});
  await ui.click('刷新会话树');
  const folderButton='document.querySelector('+JSON.stringify('[data-folder-id="'+folder.id+'"] button')+')';
  await ui.waitFor('!!'+folderButton);
  await ui.evaluate(folderButton+'.click()');
  await ui.fill('搜索会话配置','隐藏新行的筛选词');
  await create('仅保存夹具',original.port);
  await ui.click('仅保存');
  const only=await settle(async()=>(await profiles()).find(item=>item.name==='仅保存夹具'));
  assert.equal(only.folder_id,folder.id);
  await awaitTree(only);
  assert.deepEqual(await list(),[]);
  assert.equal((await original.control({op:'metrics'})).accepted_connections,0);
  summarize('Save only selected the new nested profile and accepted no SSH connection');

  await create('保存并连接夹具',original.port);
  await ui.click('保存并连接');
  const firstRef=await awaitHost(original.pin);
  const saved=await settle(async()=>(await profiles()).find(item=>item.name==='保存并连接夹具'));
  assert.equal((await status(firstRef)).profile_id,saved.id);
  assert.equal(await ui.evaluate(named('SSH核验目标')+'.textContent'),'127.0.0.1:'+original.port);
  assert.equal((await original.control({op:'metrics'})).attempts,0);
  await ui.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.copiedSshFingerprint=value;}}})');
  await ui.click('复制指纹');
  assert.equal(await ui.evaluate('window.copiedSshFingerprint'),original.pin);
  await ui.evaluate('Array.from(document.querySelectorAll("dialog:modal button")).find(b=>b.textContent==="暂不连接").focus()');
  await enter();
  await awaitTree(saved);
  await disconnected(firstRef);
  assert.deepEqual(await pins(),[]);
  assert.equal((await original.control({op:'metrics'})).attempts,0);
  summarize('First fingerprint and copied value matched the fixture; default Enter cancelled without authentication or trust');

  await activate(saved);const verified=await awaitHost(original.pin);
  await ui.click('指纹一致，信任并继续');
  await awaitPassword(original.port);
  const count=(await list()).length;
  await ui.fill('SSH登录密码',original.password);
  await ui.evaluate(named('记住SSH凭据')+'.click()');
  await enter();
  assert.deepEqual(await connected(),verified);
  assert.equal((await list()).length,count);
  assert.equal((await original.control({op:'metrics'})).attempts,1);
  assert.ok((await profiles()).find(item=>item.id===saved.id).credential_ref);
  assert.deepEqual((await pins()).map(key=>key.fingerprint),[original.pin]);
  summarize('Explicit first trust, remembered password and Enter answered the existing connection once');

  await activate(saved);
  const known=await connected();
  assert.notEqual(known.connection_id,verified.connection_id);
  assert.equal((await original.control({op:'metrics'})).attempts,2);
  assert.equal(await ui.evaluate('!!'+named('当前服务器指纹')),false);
  await ssh({op:'close',connection:known});await ssh({op:'close',connection:verified});
  await disconnected(known);await disconnected(verified);
  summarize('The known key skipped confirmation and the remembered credential was used once');

  await originalScope.close();originalScope=undefined;
  replacementScope=await createSshFixtureScope('saved-ssh-rotated-owner-');
  const next=await replacementScope.start('replacement',original.port);
  assert.equal(next.port,original.port);
  assert.notEqual(next.pin,original.pin);
  await activate(saved);const stopped=await awaitHost(next.pin,true);
  assert.equal(await ui.evaluate(named('原服务器指纹')+'.textContent'),original.pin);
  assert.equal((await next.control({op:'metrics'})).attempts,0);
  await enter();await disconnected(stopped);
  await ui.waitFor('!'+dialog);
  assert.deepEqual((await pins()).map(key=>key.fingerprint),[original.pin]);
  summarize('Rotated host displayed both real fingerprints and default Enter retained the prior trust record');

  await activate(saved);const changed=await awaitHost(next.pin,true);
  await ui.click('更新指纹并继续');
  await awaitPassword(next.port);
  assert.deepEqual((await pins()).map(key=>key.fingerprint),[next.pin]);
  assert.equal((await next.control({op:'metrics'})).attempts,1);
  await ui.click('取消');await disconnected(changed);
  await ui.waitFor('!'+dialog);
  assert.ok((await profiles()).some(item=>item.id===saved.id));
  summarize('Explicit update used the real new fingerprint; password cancellation closed only its original generation');

  await create('迟到启动回执夹具',next.port);
  const held=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'hold'});
  try{
    const before=new Set((await list()).map(item=>item.connection_id));
    await ui.click('保存并连接');
    await settle(async()=>await held.count()===1);
    const late=reference(await settle(async()=>(await list()).find(item=>!before.has(item.connection_id))));
    const profile=await settle(async()=>(await profiles()).find(item=>item.name==='迟到启动回执夹具'));
    await ui.click('收起连接窗口');
    await awaitTree(profile);
    await held.release();
    await disconnected(late);
    assert.equal((await next.control({op:'metrics'})).attempts,1);
  }finally{await held.restore();}
  summarize('A delayed Start receipt after the dialog closed cleaned up only the original owned connection');

  await ui.click('连接服务器');
  await ui.waitFor('!!'+named('SSH服务器'));
  await ui.click('收起连接窗口');
  summarize('The manual quick-connect form remains available');
  result.result='PASS';
}catch(error){
  result.result='FAIL';
  result.error=String(error.stack);
  result.focus=await ui?.evaluate('({modal:document.querySelector("dialog:modal")?.innerText,active:document.activeElement?.outerHTML.slice(0,250),selected:document.querySelector(".tree-scroll [aria-pressed=true]")?.textContent})').catch(()=>undefined);
  throw error;
}finally{
  await ui?.close();
  await originalScope?.close();
  await replacementScope?.close();
  await mkdir(path.dirname(report),{recursive:true});
  await writeFile(report,JSON.stringify(result,null,2)+'\n');
  assert.ok(path.basename(root).startsWith('shared-terminal-saved-ssh-ui-'));
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
