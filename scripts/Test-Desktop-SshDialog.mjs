import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
let directory, fixture, ui, stall;const sockets=new Set();
const wait=async(test,label,attempts=300)=>{for(let n=0;n<attempts;n++){if(await test())return;await delay(100);}throw new Error(`Timed out: ${label}`);};
try {
 directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-ssh-dialog-ui-中文-'));
 fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
 const next=async()=>{let timer;try{return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};
 const server=await next();const control=async r=>{fixture.stdin.write(JSON.stringify(r)+'\n');return next();};
 ui=await launchDesktop(directory,{fixture:true});
 await ui.evaluate(`window.__dialogFocusTrace=[];document.addEventListener('focusin',e=>{window.__dialogFocusTrace.push({tag:e.target.tagName,label:e.target.getAttribute('aria-label'),class:e.target.className});if(window.__dialogFocusTrace.length>30)window.__dialogFocusTrace.shift();});`);
 const modal=()=>ui.evaluate(`!!document.querySelector('dialog:modal')`);
 const selected=()=>ui.evaluate(`document.querySelector('[aria-label="会话"]').value`);
 const current=async()=>{const id=await selected();return (await ui.invoke('service_list')).find(c=>c.connection_id===id);};
 const show=async()=>{await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='连接服务器')?.focus()`);await ui.click('连接服务器');await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="SSH服务器"]')`);};
 const fill=async(port=server.port,auth='password')=>{await ui.waitFor(`!!document.querySelector('[aria-label="SSH服务器"]')&&!document.querySelector('[aria-label="SSH服务器"]').disabled`);await ui.fill('SSH服务器','127.0.0.1');await ui.fill('SSH用户名','synthetic');await ui.fill('SSH登录方式',auth);await ui.evaluate(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='高级连接设置').parentElement.open=true`);await ui.fill('SSH端口',port);};
 const start=async()=>{await ui.waitFor(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='连接').disabled`);await ui.click('连接');};
 const alert=async(text)=>{await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes(${JSON.stringify(text)})`);assert.ok(await ui.evaluate(`(()=>{const e=document.querySelector('dialog:modal [role="alert"]'),r=e.getBoundingClientRect(),d=e.closest('dialog').getBoundingClientRect();return r.width>0&&r.top>=d.top&&r.bottom<=d.bottom&&getComputedStyle(e).borderLeftWidth!=='0px';})()`),'failure is visibly inside modal');};
 const connected=async()=>{await wait(async()=>{const c=await current();return c?.state==='CONNECTED'&&!(await modal());},'connected and modal automatically closed');await ui.waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);return current();};
 const before=await ui.evaluate(`document.querySelector('.terminal-workspace').getBoundingClientRect().width`);
 await show();
 await ui.command('Page.bringToFront');
 const geometry=await ui.evaluate(`(()=>{const r=document.querySelector('dialog:modal').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,terminal:document.querySelector('.terminal-workspace').getBoundingClientRect().width};})()`);
 assert.ok(Math.abs(geometry.x+geometry.w/2-geometry.vw/2)<2);assert.ok(Math.abs(geometry.y+geometry.h/2-geometry.vh/2)<2);assert.equal(geometry.terminal,before,'modal does not consume terminal columns');
 for(let n=0;n<12;n++){await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});assert.ok(await ui.evaluate(`document.querySelector('dialog:modal').contains(document.activeElement)`),'native dialog traps Tab focus');}
 await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.waitFor(`!document.querySelector('dialog:modal')`);assert.equal(await ui.evaluate(`document.activeElement.textContent`),'新建 SSH');
 for(const [button,label] of [['连接配置','连接配置'],['外观','外观设置']]){await ui.evaluate(`document.querySelector('.tools-menu').open=true`);await ui.click(button);await ui.waitFor(`document.querySelector('dialog:modal')?.getAttribute('aria-label')===${JSON.stringify(label)}`);assert.equal(await ui.evaluate(`document.querySelector('.terminal-workspace').getBoundingClientRect().width`),before);await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.waitFor(`!document.querySelector('dialog:modal')`);}
 await show();
 await ui.waitFor(`document.activeElement.getAttribute('aria-label')==='SSH服务器'`);
 await ui.screenshot('CR-022-S2-ssh-form.png');
 const compositionBlocked=await ui.evaluate(`(()=>{
   const field=document.querySelector('[aria-label="SSH服务器"]');
   return !field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
 })()`);
 assert.equal(compositionBlocked,true);
 await start();
 await ui.waitFor(`document.querySelector('#ssh-host-error')?.textContent.includes('主机名')`);
 await ui.fill('SSH服务器','127.0.0.1');await ui.fill('SSH用户名','synthetic');await ui.fill('SSH端口','0');
 await start();await ui.waitFor(`document.querySelector('#ssh-port-error')&&document.activeElement.getAttribute('aria-label')==='SSH端口'`);
 assert.equal((await ui.invoke('service_list')).length,0);
 await fill();await ui.fill('SSH登录密码','wrong-synthetic');await start();await ui.waitFor(`!!document.querySelector('[aria-label="快速连接核对指纹"]')`);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').checked`),false);await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').click()`);await ui.click('信任并继续登录');await alert('未被服务器接受');await ui.screenshot('P12.1-dialog-auth-failure.png');
 await ui.fill('SSH登录密码',server.password);await ui.click('提交本次登录信息');const first=await connected();
 await ui.waitFor(`Array.from(document.querySelectorAll('[role="tab"]')).find(t=>t.dataset.connectionId===${JSON.stringify(first.connection_id)})?.textContent==='127.0.0.1'`);
 await ui.command('Input.insertText',{text:'弹窗后中文'});await wait(async()=>Buffer.from((await control({op:'metrics'})).received.flat()).toString().includes('弹窗后中文'),'terminal input after dialog closes');
 await show();await fill();await ui.fill('SSH登录密码',server.password);await start();const second=await connected();assert.notEqual(first.connection_id,second.connection_id);
 const same=await ui.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).filter(t=>t.textContent==='127.0.0.1').map(t=>({id:t.dataset.connectionId,title:t.title}))`);assert.equal(same.length,2);assert.ok(same.every(t=>t.title.includes(t.id)&&t.title.includes('CONNECTED')));
 for(const c of [first,second]){await ui.evaluate(`document.querySelector('[role="tab"][data-connection-id="${c.connection_id}"]').click()`);assert.equal(await selected(),c.connection_id);}
 await ui.screenshot('P12.1-dialog-address-tabs.png');
 // Actual refusal, without guessing a more precise cause than the service reports.
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const refusedPort=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 await show();await fill(refusedPort);await start();await alert('检查网络和SSH服务');assert.equal((await current()).state,'FAILED');await ui.screenshot('P12.1-dialog-network-failure.png');
 await fill(server.port,'public_key');await ui.fill('SSH密钥文件',path.join(directory,'missing-private-key'));await start();await alert('无法读取密钥或凭据');
 await ui.click('取消连接');await wait(async()=>['FAILED','DISCONNECTED'].includes((await current())?.state),'key failure cancelled');
 // Real response loss: preserve request ID, keep the dialog and query only.
 await fill();await ui.fill('SSH登录密码',server.password);const count=(await ui.invoke('service_list')).length;
 const lost=await ui.interceptIpc({command:'ssh_request',op:'quick_start',mode:'error'});await start();await alert('连接结果不明');assert.equal(await lost.count(),1);await lost.restore();await ui.click('查询本次连接');await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='提交本次登录信息')`);await ui.fill('SSH登录密码',server.password);await ui.click('提交本次登录信息');await connected();assert.equal((await ui.invoke('service_list')).length,count+1);
 // Saved target host is frozen in the actual connection, independent of later edits.
 const profile={id:crypto.randomUUID(),folder_id:null,name:'配置名称不是标签',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
 await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
 await show();await ui.waitFor(`document.querySelector('[aria-label="快速连接已保存"]')?.options.length===2`);await ui.fill('快速连接已保存',profile.id);await start();const saved=await connected();
 await ui.invoke('config_request',{request:{op:'save_profile',profile:{...profile,settings:{...profile.settings,host:'localhost'}},credential:{action:'keep'}}});
 const status=await ui.invoke('ssh_request',{request:{op:'status',connection:{connection_id:saved.connection_id,generation:saved.generation}}});assert.equal(status.server_host,'127.0.0.1');
 await ui.command('Page.reload');await ui.waitFor(`document.querySelector('[role="tab"][data-connection-id="${saved.connection_id}"]')?.textContent==='127.0.0.1'`);
 if(await ui.evaluate(`document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')==='false'`))await ui.click('会话导航');await ui.waitFor(`!!document.querySelector('[aria-label="会话导航"] [data-profile-id="${profile.id}"]')`);await ui.evaluate(`document.querySelector('[aria-label="会话导航"] [data-profile-id="${profile.id}"]').click()`);await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='连接选中配置')`);await ui.click('连接选中配置');await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="快速连接核对指纹"]')`);await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').click()`);await ui.click('信任并继续登录');const navigated=await connected();await ui.waitFor(`document.querySelector('[role="tab"][data-connection-id="${navigated.connection_id}"]')?.textContent==='localhost'`);
 stall=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>stall.listen(0,'127.0.0.1',resolve));
 await show();await fill(stall.address().port);await start();await wait(()=>sockets.size>0,'owned stall socket');await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.waitFor(`!document.querySelector('dialog:modal')`);await wait(async()=>['FAILED','DISCONNECTED'].includes((await current())?.state),'Escape cancels only pending attempt');
 if(!process.argv.includes('--fast')){await show();await fill(stall.address().port);await start();await alertTimeout();await ui.screenshot('P12.1-dialog-timeout.png');}else await show();
 async function alertTimeout(){await wait(async()=>await ui.evaluate(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('连接超时')`),'production handshake timeout alert',1550);await alert('连接超时');}
 fixture.kill();await new Promise(resolve=>fixture.once('exit',resolve));const changedDirectory=path.join(directory,'changed-host');await mkdir(changedDirectory);fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[changedDirectory,String(server.port)],{windowsHide:true,stdio:['pipe','pipe','pipe']});const changedLines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();const changed=JSON.parse((await changedLines.next()).value);assert.notEqual(changed.pin,server.pin);
 await fill(server.port);await start();await alert('服务器指纹已变化');assert.equal(await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').checked`),false);await ui.screenshot('P12.1-dialog-changed-host.png');await ui.click('拒绝连接');await alert('未信任此服务器');
 await writeFile('artifacts/P12.1-dialog-result.json',JSON.stringify({result:'PASS',modalCentered:true,terminalWidthUnchanged:true,nativeFocusTrap:true,escapeRestoresFocus:true,configurationAndAppearanceModal:true,successClosesAndFocusesTerminal:true,addressOnlyTabs:true,sameHostDistinctSessions:true,savedHostFrozenAfterEditAndReload:true,savedNavigationAuthCloses:true,wrongPasswordAlert:true,networkFailureAlert:true,keyReadFailureAlert:true,unknownOriginalQuery:true,pendingEscapeCancels:true,productionTimeoutAlert:!process.argv.includes('--fast'),changedHostDefaultBlocked:true,hostRejectAlert:true,terminalChineseAfterClose:true,scope:'synthetic owned loopback; no user data'},null,2)+'\n');
 console.log(`PASS SSH dialogs: centered modal/focus/Escape, configuration and appearance, address-only distinct tabs/frozen host, saved navigation login, visible password/network/key/unknown/host-key failures; production timeout ${process.argv.includes('--fast')?'not run':'PASS'}; synthetic only`);
}catch(error){console.error('SSH dialog failure:',error.message);if(ui){console.error('focus trace:',await ui.evaluate(`JSON.stringify({active:{tag:document.activeElement?.tagName,class:document.activeElement?.className,label:document.activeElement?.getAttribute('aria-label')},events:window.__dialogFocusTrace})`).catch(String));await ui.screenshot('P12.1-dialog-failure.png').catch(()=>{});await writeFile('artifacts/P12.1-dialog-failure.txt',await ui.evaluate(`document.body.innerText`).catch(String));}throw error;}
finally{await ui?.close();fixture?.kill();if(fixture&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(resolve=>fixture.once('exit',resolve));for(const socket of sockets)socket.destroy();if(stall)await new Promise(resolve=>stall.close(resolve));if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-ssh-dialog-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
