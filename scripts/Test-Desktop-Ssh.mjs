import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-ssh-ui-'));
const fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], {windowsHide:true, stdio:['pipe','pipe','pipe']});
const lines = createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
const next = async () => {
  let timeout;
  try { const result = await Promise.race([lines.next(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]); assert.equal(result.done,false); return JSON.parse(result.value); }
  finally { clearTimeout(timeout); }
};
const control = async request => { fixture.stdin.write(JSON.stringify(request)+'\n'); return next(); };
let ui;
try {
  const server = await next();
  ui = await launchDesktop(directory);
  const save = async (name,auth,credential={action:'keep'}) => {
    const profile = {id:crypto.randomUUID(), folder_id:null, name, settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth,encoding:'utf8'}};
    const reply = await ui.invoke('config_request',{request:{op:'save_profile',profile,credential}});
    assert.equal(reply.result,'saved_profile');return profile;
  };
  const password = await save('loopback password','password');
  const keyboard = await save('loopback challenge','keyboard_interactive');
  const keyProfile = {id:crypto.randomUUID(), folder_id:null, name:'loopback key', settings:{...password.settings,auth:'public_key'}};
  assert.equal((await ui.invoke('config_request',{request:{op:'save_profile_key_file',profile:keyProfile,key_path:server.key_path,passphrase:server.password}})).result,'saved_profile');
  await ui.click('SSH2 连接');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length === 4`);
  const choose = async profile => { await ui.fill('SSH2 配置',profile.id); await ui.click('建立 SSH2 连接'); };
  const state = value => ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith(${JSON.stringify(value)})`);
  const waitButton = label => ui.waitFor(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent===${JSON.stringify(label)} && !button.disabled)`);
  await choose(password); await waitButton('拒绝 SSH2 主机');
  assert.equal((await control({op:'metrics'})).attempts,0,'no authentication before trust');
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='信任本次 SSH2 主机').disabled`),true);
  assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent===${JSON.stringify(server.pin)}`),true);
  await ui.click('拒绝 SSH2 主机'); await state('FAILED');
  await ui.click('显式重连 SSH2'); await waitButton('拒绝 SSH2 主机');
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
  await ui.click('信任本次 SSH2 主机'); await waitButton('提交本次 SSH2 密码');
  await ui.fill('SSH2 临时密码','wrong synthetic password'); await ui.click('提交本次 SSH2 密码');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 临时密码"]')?.value === ''`);
  for(let attempt=0;attempt<100 && (await control({op:'metrics'})).attempts<1;attempt++) await delay(50);
  await delay(300); await waitButton('提交本次 SSH2 密码');
  await ui.fill('SSH2 临时密码',server.password); await ui.click('提交本次 SSH2 密码'); await state('CONNECTED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH2 临时密码"]') === null`),true);
  let connection = (await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
  assert.equal(connection.generation,2);
  await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await ui.command('Input.insertText',{text:'first'});
  await ui.command('Input.insertText',{text:'second'});
  await ui.waitFor(`document.querySelector('.input-status output').textContent.includes('发送管线')`);
  for(let attempt=0;attempt<100;attempt++){ const metrics=await control({op:'metrics'});if(Buffer.from(metrics.received.flat()).toString()==='firstsecond')break;await delay(50); }
  assert.equal(Buffer.from((await control({op:'metrics'})).received.flat()).toString(),'firstsecond');
  assert.equal(await ui.evaluate(`document.querySelector('.input-status').textContent.includes('first')`),false,'typed bytes excluded from diagnostics');
  const beforeResize=(await control({op:'metrics'})).sizes.length;
  await ui.fill('字号','20');
  for(let attempt=0;attempt<100 && (await control({op:'metrics'})).sizes.length<=beforeResize;attempt++) await delay(50);
  const sizes=(await control({op:'metrics'})).sizes; assert.ok(sizes.length>=2);assert.notDeepEqual(sizes[0],sizes.at(-1));
  await ui.click('屏幕快照'); await ui.waitFor(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('firstsecond')`);
  await ui.screenshot('desktop-ssh2-connected.png');
  await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await ui.command('Input.insertText',{text:'x'.repeat(65537)});
  await ui.waitFor(`document.querySelector('.status').textContent.includes('超过 64 KiB')`);
  await delay(400);
  assert.equal(await ui.evaluate(`document.querySelector('.status').textContent.includes('超过 64 KiB')`),true,'read polling must not overwrite rejected-input feedback');
  assert.equal(Buffer.from((await control({op:'metrics'})).received.flat()).toString(),'firstsecond','oversized paste is not sent');

  await control({op:'end'}); await state('DISCONNECTED');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]').textContent.includes('shell 退出码 7')`);
  // Corrupt the remembered public pin to exercise an actual changed-key GUI decision.
  const database=new DatabaseSync(path.join(directory,'config.sqlite'));
  database.prepare('UPDATE host_keys SET key=?').run(Buffer.from('synthetic changed remembered key')); database.close();
  await ui.click('显式重连 SSH2'); await waitButton('拒绝 SSH2 主机');
  await ui.waitFor(`document.querySelector('.ssh-panel').textContent.includes('主机密钥已变化')`);
  await ui.screenshot('desktop-ssh2-changed-key.png');
  const before=(await control({op:'metrics'})).attempts;
  await ui.click('拒绝 SSH2 主机'); await state('FAILED'); assert.equal((await control({op:'metrics'})).attempts,before);
  await ui.click('显式重连 SSH2');await waitButton('拒绝 SSH2 主机');
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);await ui.click('信任本次 SSH2 主机');
  await waitButton('提交本次 SSH2 密码');await ui.fill('SSH2 临时密码',server.password);await ui.click('提交本次 SSH2 密码');await state('CONNECTED');
  await ui.click('关闭 SSH2 连接');await state('DISCONNECTED');
  await choose(keyProfile); await waitButton('使用保存的 SSH2 凭据');await ui.click('使用保存的 SSH2 凭据');await state('CONNECTED');
  await control({op:'disconnect'});await state('FAILED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH2 状态"]').textContent.includes('shell 退出码')`),false,'disconnect cannot invent status');
  await choose(keyboard);await ui.waitFor(`document.querySelector('[aria-label="SSH2 认证回答 1"]')?.type === 'password'`);
  await ui.fill('SSH2 认证回答 1',server.password);await ui.click('提交 SSH2 认证回答');await state('CONNECTED');
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="SSH2 认证回答 1"]') === null`),true);
  connection=(await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
  const pid=(await ui.invoke('service_status')).pid;
  const beforeReload=(await control({op:'metrics'})).sizes.at(-1);
  await ui.evaluate(`window.__sshReloadProbe = true`);
  await ui.command('Page.reload'); await ui.waitFor(`window.__sshReloadProbe === undefined && document.querySelector('footer')?.textContent.includes('服务 ')`);
  assert.equal((await ui.invoke('service_status')).pid,pid);
  await ui.fill('会话',connection.connection_id);
  for(let attempt=0;attempt<100;attempt++){const size=(await control({op:'metrics'})).sizes.at(-1);if(JSON.stringify(size)!==JSON.stringify(beforeReload))break;await delay(50);}
  assert.notDeepEqual((await control({op:'metrics'})).sizes.at(-1),beforeReload,'reload/new selection must synchronize the fresh terminal dimensions');
  assert.ok((await ui.invoke('service_list')).some(item=>item.connection_id===connection.connection_id && item.generation===connection.generation && item.state==='CONNECTED'));
  await ui.close();ui=null;
  console.log('PASS SSH2 native WebView: trust/reject/changed key, wrong/temporary password, DPAPI key, keyboard challenge, FIFO input/resize, exit/disconnect, reload without reconnect');
} finally {
  await ui?.close(); fixture.stdin.end();if(fixture.exitCode===null)fixture.kill();
  for(let attempt=0;attempt<100 && fixture.exitCode===null && fixture.signalCode===null;attempt++)await delay(50);
  assert.ok(fixture.exitCode!==null || fixture.signalCode!==null);
  const target=path.resolve(directory); assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-ssh-ui-'));
  await rm(target,{recursive:true,force:true});
}
