import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestId } from '../apps/desktop/src/request-id.ts';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
let directory,ui,fixture;
const baseline=process.argv.includes('--visual-baseline');
const visual=baseline||process.argv.includes('--visual-refresh');
const executable=baseline?path.resolve((JSON.parse(await readFile('artifacts/CR-022-preview.json','utf8'))).directory,'shared-terminal-desktop.exe'):undefined;
const wait=async(test,label)=>{for(let i=0;i<300;i++){if(await test())return;await delay(100);}throw new Error(`Timed out: ${label}`);};
try{
 directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-navigation-ui-中文-'));
 fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();
 const next=async()=>{let timer;try{return await Promise.race([lines.next().then(x=>JSON.parse(x.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(timer);}};const server=await next();const control=async r=>{fixture.stdin.write(JSON.stringify(r)+'\n');return next();};
 ui=await launchDesktop(directory,{fixture:true,executable});
 const config=request=>ui.invoke('config_request',{request}),ssh=request=>ui.invoke('ssh_request',{request}),list=()=>ui.invoke('service_list');
 const ref=c=>({connection_id:c.connection_id,generation:c.generation});
 const profile=(name,host='127.0.0.1',auth='password')=>({id:crypto.randomUUID(),folder_id:null,name,settings:{protocol:'ssh2',host,port:server.port,username:'synthetic',auth,encoding:'utf8'}});
 const a=profile('已保存 A'),b=profile('右键目标 B','localhost'),missing=profile('缺少凭据 C','localhost'),wrong=profile('错误凭据 D'),key=profile('加密密钥 E','127.0.0.1','public_key');
 for(const p of [a,b,missing,wrong])assert.equal((await config({op:'save_profile',profile:p,credential:p===missing?{action:'clear'}:{action:'replace',value:{password:p===wrong?'wrong-synthetic':server.password,private_key:null,passphrase:null}}})).result,'saved_profile');
 assert.equal((await config({op:'save_profile_key_file',profile:key,key_path:server.key_path,passphrase:server.password})).result,'saved_profile');
 const sidebar='document.querySelector(".sidebar-toggle")';
 assert.equal(await ui.evaluate(`${sidebar}.getAttribute('aria-expanded')`),'true');
 assert.equal(await ui.evaluate(`[...document.querySelectorAll('.empty-actions button')].map(b=>b.textContent).join('|')`),'新建 SSH|新建串口');
 assert.equal(await ui.evaluate(`[...document.querySelectorAll('.empty-actions button')].every(b=>{
   const r=b.getBoundingClientRect();return r.width>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b;
 })`),true,'both first-run creation controls are reachable');
 const grip=await ui.evaluate(`(()=>{const r=document.querySelector('.sidebar-divider').getBoundingClientRect();const x=r.x+r.width/2,y=r.y+60;if(!document.elementFromPoint(x,y)?.matches('.sidebar-divider'))throw Error('divider is covered');return{x,y};})()`);
 await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...grip});
 await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:grip.x+36,y:grip.y});
 await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:grip.x+36,y:grip.y});
 await ui.waitFor(`Number(document.querySelector('.sidebar-divider').getAttribute('aria-valuenow'))>280`);
 await ui.screenshot('CR-022-S1-library.png');
 await ui.click('会话导航');
 await ui.close();ui=await launchDesktop(directory,{fixture:true,executable});
 assert.equal(await ui.evaluate(`${sidebar}.getAttribute('aria-expanded')`),'false');
 await ui.command('Page.bringToFront');
 await ui.evaluate(`${sidebar}.focus()`);
 await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await ui.waitFor(`${sidebar}.getAttribute('aria-expanded')==='true'`);
 await ui.close();ui=await launchDesktop(directory,{fixture:true,executable});
 assert.equal(await ui.evaluate(`${sidebar}.getAttribute('aria-expanded')`),'true');
 await ui.click('刷新会话树');
 const tree=p=>`Array.from(document.querySelectorAll('.session-tree-list button')).find(b=>b.firstChild.textContent===${JSON.stringify(p.name)})`;
 const double=async(p,count=1)=>{await ui.waitFor(`!!(${tree(p)})`);await ui.evaluate(`(()=>{const b=${tree(p)};for(let i=0;i<${count};i++)b.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));})()`);};
 const context=async p=>{const point=await ui.evaluate(`(()=>{const b=${tree(p)};b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...point});await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...point});await ui.waitFor(`!!document.querySelector('[role="menu"][aria-label="会话配置菜单"]')`);};
 const chooseContext=()=>ui.evaluate(`document.querySelector('[role="menuitem"]').click()`);
 const current=async()=>{const id=await ui.evaluate(`document.querySelector('[data-active="true"] [role="tab"][aria-selected="true"]')?.dataset.connectionId`);return (await list()).find(c=>c.connection_id===id);};
 const connected=async()=>{await wait(async()=>{const c=await current();return c?.state==='CONNECTED'&&!(await ui.evaluate(`!!document.querySelector('dialog:modal')`));},'saved login reaches terminal');await ui.waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);return current();};
 const trust=async()=>{await ui.waitFor('document.activeElement?.textContent==="暂不连接"');await ui.click('指纹一致，信任并继续');};
 const closeButton=c=>`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===${JSON.stringify('关闭标签 '+c.connection_id)})`;
 const tab=c=>`document.querySelector('[role="tab"][data-connection-id="${c.connection_id}"]')`;
 await ui.waitFor(`!!(${tree(a)})`);await ui.evaluate(`(${tree(a)}).click()`);assert.equal((await list()).length,0,'single click only selects');
 const startHeld=await ui.interceptIpc({command:'ssh_request',op:'start',mode:'hold'});await double(a,3);await wait(async()=>await startHeld.count()===1,'single held Start');assert.equal((await list()).length,1);assert.equal((await control({op:'metrics'})).attempts,0);await startHeld.restore();await trust();const first=await connected();
 await double(a);const second=await connected();assert.notEqual(first.connection_id,second.connection_id);assert.equal((await list()).length,2,'a later deliberate activation creates an independent instance');
 if(visual){
   const metrics={};
   const target=ref(second);
   const raw=async()=>Buffer.from((await ui.invoke('service_read',{connection:target,cursor:1})).events.flatMap(event=>event.bytes));
   for(const theme of ['dark','light']){
     await ui.click('软件设置');await ui.fill('应用主题',theme);await ui.fill('终端配色','follow_theme');await ui.click('关闭软件设置');
     await ui.waitFor(`document.documentElement.dataset.theme==='${theme}'&&document.documentElement.dataset.terminalPalette==='follow_theme'`);
     await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
     await ui.waitFor(`document.activeElement.classList.contains('xterm-helper-textarea')`);
     await delay(300);
     const before=await raw();
     await ui.command('Input.imeSetComposition',{text:'zhong wen',selectionStart:9,selectionEnd:9});
     await ui.waitFor(`document.querySelector('.composition-view.active')?.textContent==='zhong wen'`);
     assert.deepEqual(await raw(),before,'uncommitted preedit never reaches the service');
     metrics[theme]=await ui.evaluate(`(()=>{
       const e=q=>document.querySelector(q),r=q=>e(q).getBoundingClientRect().toJSON();
       const c=q=>getComputedStyle(e(q));
       const p=r('.composition-view.active'),t=r('.terminal');
       return {window:[innerWidth,innerHeight,devicePixelRatio],terminal:t,tab:r('.tab-tools'),
         activeTab:r('.connection-tab:has([aria-selected="true"])'),nav:r('.app-bar'),
         sidebar:r('.session-sidebar'),treeHeader:e('.tree-scroll').getBoundingClientRect().top-e('.session-sidebar').getBoundingClientRect().top,
         treeRow:r('.session-tree-list [data-profile-id]').height,
         treePitch:e('.session-tree-list li:nth-child(2)').getBoundingClientRect().top-e('.session-tree-list li').getBoundingClientRect().top,
         bottom:innerHeight-t.bottom,footer:r('footer').height,dimensions:e('[aria-label="终端视口尺寸"]').textContent,
         preedit:{rect:p,color:c('.composition-view').color,background:c('.composition-view').backgroundColor,outline:c('.composition-view').outlineColor,outlineStyle:c('.composition-view').outlineStyle},
         terminalBackground:c('.terminal').backgroundColor,activeTabBackground:c('.connection-tab:has([aria-selected="true"])').backgroundColor};
     })()`);
     if(!baseline){
       const m=metrics[theme];
       assert.ok(m.activeTab.x>=m.terminal.x-1&&Math.abs(m.activeTab.bottom-m.terminal.top)<=3);
       assert.notEqual(m.activeTabBackground,m.terminalBackground);
       assert.ok(m.treePitch<=30&&m.treeHeader<95&&m.bottom<43);
       assert.notEqual(m.preedit.background,m.terminalBackground);
       assert.equal(m.preedit.outlineStyle,'solid');
       assert.ok(m.preedit.rect.x>=m.terminal.x&&m.preedit.rect.y>=m.terminal.y&&m.preedit.rect.bottom<=m.terminal.bottom);
     }
     await ui.screenshot(`CR-022-polish-${baseline?'before':'after'}-${theme}.png`);
     await ui.command('Input.insertText',{text:'中文'});
     await ui.waitFor(`!document.querySelector('.composition-view.active')`);
     await wait(async()=> (await raw()).length>=before.length+6,'committed composition received');
     assert.deepEqual(await raw(),Buffer.concat([before,Buffer.from('中文')]));
   }
   if(!baseline){
     const details=await ui.evaluate(`(()=>{
       const before=document.querySelector('.terminal').getBoundingClientRect().height;
       const button=document.querySelector('button.connection-details');
       button.focus();button.click();
       const pane=document.querySelector('dialog[aria-label="连接与服务详情"]');
       return {before,after:document.querySelector('.terminal').getBoundingClientRect().height,visible:pane.getBoundingClientRect().height>0,text:pane.innerText};
     })()`);
     assert.equal(details.before,details.after);
     assert.equal(details.visible,true);assert.match(details.text,/服务输出已同步/);
     await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
     await ui.waitFor(`!document.querySelector('dialog[aria-label="连接与服务详情"]').open`);
     await ui.click('软件设置');await ui.fill('应用主题','dark');await ui.click('关闭软件设置');
     await ui.waitFor(`document.documentElement.dataset.theme==='dark'`);
     await ui.screenshot('CR-022-polish-dark-desktop.png');
   }
   await writeFile(`artifacts/CR-022-polish-${baseline?'before':'after'}.json`,JSON.stringify(metrics,null,2));
   console.log('PASS normal dark/light WebView layout and preedit/commit exact bytes');
 }
 assert.equal(await ui.evaluate(`document.querySelector('[aria-label="标签操作状态"]')?.textContent.startsWith('正在连接 ')??false`),false,'successful or closed progress cannot stay on the terminal');
 const duplicatesById=`Object.fromEntries([...document.querySelectorAll('[role="tab"]')].filter(t=>t.querySelector('.tab-label')?.textContent==='127.0.0.1').map(t=>[t.dataset.connectionId,t.textContent]))`;
 await ui.waitFor(`Object.keys(${duplicatesById}).length===2`);
 const beforeMove=await ui.evaluate(duplicatesById);
 assert.deepEqual(Object.values(beforeMove),['127.0.0.1','127.0.0.1']);
 await ui.click('标签左移');assert.deepEqual(await ui.evaluate(duplicatesById),beforeMove);assert.equal(await ui.evaluate(`document.querySelector('[role="tab"]').dataset.connectionId`),second.connection_id);await ui.fill('搜索会话配置','不存在的名称');assert.equal(await ui.evaluate(`document.querySelectorAll('.session-tree-list button').length`),0);assert.equal((await list()).length,2);await ui.fill('搜索会话配置','');
 await ui.evaluate(`(${tree(a)}).click()`);const selectedBefore=await ui.evaluate(`document.querySelector('[data-active="true"] [role="tab"][aria-selected="true"]')?.dataset.connectionId`);await context(b);assert.equal(await ui.evaluate(`(${tree(b)}).getAttribute('aria-pressed')`),'true');assert.equal(await ui.evaluate(`document.querySelector('[data-active="true"] [role="tab"][aria-selected="true"]')?.dataset.connectionId`),selectedBefore);
 await ui.screenshot('P12.1-saved-session-context.png');await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.waitFor(`!document.querySelector('[role="menu"]')`);assert.ok(await ui.evaluate(`document.activeElement===${tree(b)}`));
 await context(b);await chooseContext();await trust();const right=await connected();assert.equal((await ssh({op:'status',connection:ref(right)})).profile_id,b.id,'right-click target must not use previous selection');
 await context(missing);await chooseContext();await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='提交本次登录信息')`);const missingAttempts=(await control({op:'metrics'})).attempts;await delay(300);assert.equal((await control({op:'metrics'})).attempts,missingAttempts,'no blank or guessed credential dispatch');await ui.fill('SSH登录密码',server.password);await ui.click('提交本次登录信息');await connected();
 const beforeWrong=(await control({op:'metrics'})).attempts;await double(wrong);await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('未被服务器接受')`);await delay(350);assert.equal((await control({op:'metrics'})).attempts,beforeWrong+1,'rejected stored credential is never looped');await ui.fill('SSH登录密码',server.password);await ui.click('提交本次登录信息');await connected();
 await double(key);const keyed=await connected();assert.equal((await ssh({op:'status',connection:ref(keyed)})).profile_id,key.id);
 await ui.waitFor(`Object.keys(${duplicatesById}).length>=3`);
 for(const label of Object.values(await ui.evaluate(duplicatesById)))assert.equal(label,'127.0.0.1');
 const selection=await ui.evaluate(`(()=>{
   const active=document.querySelector('.connection-tab:has([aria-selected="true"])');
   const inactive=document.querySelector('.connection-tab:has([aria-selected="false"])');
   return {active:getComputedStyle(active).backgroundColor,inactive:getComputedStyle(inactive).backgroundColor,
     emphasis:getComputedStyle(active).boxShadow,weight:getComputedStyle(active.querySelector('[role="tab"]')).fontWeight};
 })()`);
 assert.notEqual(selection.active,selection.inactive);
 assert.notEqual(selection.emphasis,'none');
 assert.equal(selection.weight,'400');
 if(process.argv.includes('--tabs-scrollbar')){
   await ui.click('软件设置');await ui.fill('应用主题','dark');await ui.click('关闭软件设置');
   await ui.waitFor(`document.documentElement.dataset.theme==='dark'`);
   await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
 }
 await ui.screenshot('terminal-distinct-tabs.png');
 const sixTabs=await ui.evaluate(`[...document.querySelectorAll('[role="tab"]')].map(tab=>tab.dataset.connectionId)`);
 assert.equal(sixTabs.length,6);
 const resize=(width,height)=>JSON.parse(execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),'-Width',String(width),'-Height',String(height),'-ExpectedExecutable',executable??path.resolve('target/debug/shared-terminal-desktop.exe'),'-PhysicalSize'],{encoding:'utf8',windowsHide:true}));
 const compact=resize(760,560);
 await ui.waitFor(`innerWidth < 780 && document.querySelector('[role="tablist"]').scrollWidth>document.querySelector('[role="tablist"]').clientWidth`);
 if(process.argv.includes('--visual-refresh')){
   const point=await ui.evaluate(`(()=>{const rail=document.querySelector('[role="tablist"]');rail.scrollLeft=0;const r=rail.getBoundingClientRect();return{x:r.x+20,y:r.y+15};})()`);
   await ui.command('Input.dispatchMouseEvent',{type:'mouseWheel',deltaX:0,deltaY:64,...point});
   await ui.waitFor(`document.querySelector('[role="tablist"]').scrollLeft>0`);
 }
 await ui.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').focus({preventScroll:true})`);
 const toolbar=await ui.evaluate(`[...document.querySelectorAll('.app-bar > *')].map(node=>{const r=node.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,width:innerWidth};})`);
 assert.ok(Math.max(...toolbar.map(r=>r.top))-Math.min(...toolbar.map(r=>r.top))<12,'toolbar remains on one row');
 assert.ok(toolbar.every(r=>r.left>=0&&r.right<=r.width),'toolbar controls remain within the actual client');
 console.log('CR-022 compact window',JSON.stringify(compact));
 const visited=new Set();
 for(let i=0;i<6;i++){
   visited.add(await ui.evaluate(`document.activeElement.dataset.connectionId`));
   await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
   await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 }
 assert.deepEqual([...visited].sort(),sixTabs.sort());
 await ui.waitFor(`!document.querySelector('.toolbar-log').disabled&&document.querySelector('[aria-label="权限状态"]').textContent.includes('桌面输入可用')`);
 await ui.evaluate(`document.querySelector('.new-menu > summary').focus()`);
 await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
 await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
 await ui.waitFor(`document.activeElement.matches('.new-menu button')&&document.activeElement.getClientRects().length>0`);
 await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await ui.waitFor(`!document.querySelector('.new-menu').open&&document.activeElement.matches('.new-menu > summary')`);
 const sidebarRegions=await ui.evaluate(`(()=>{
   const tree=document.querySelector('.tree-scroll'),details=document.querySelector('.profile-summary');
   const before=tree.scrollTop;
   details.scrollTop=details.scrollHeight;
   const action=details.querySelector('button').getBoundingClientRect();
   const frame=details.getBoundingClientRect();
   const independent=tree.scrollTop===before;
   const revealed=action.top>=frame.top&&action.bottom<=frame.bottom;
   details.scrollTop=0;
   tree.scrollTop=0;
   return {separate:tree.getBoundingClientRect().bottom<=frame.top,independent,revealed};
 })()`);
 assert.deepEqual(sidebarRegions,{separate:true,independent:true,revealed:true},'the tree and profile controls have independent scroll regions');
 await ui.screenshot('CR-022-S3-six-tabs-compact.png');
 resize(1100,760);
 await ui.waitFor(`innerWidth > 900`);
 // Exact ref close, same-turn dedup, then reconnect while its real response is held.
 const closeHeld=await ui.interceptIpc({command:'ssh_request',op:'close',mode:'hold'});await ui.evaluate(`(()=>{const b=${closeButton(first)};b.click();b.click();})()`);await wait(async()=>await closeHeld.count()===1,'one close dispatch');assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="关闭标签确认"]')`),false);await wait(async()=>['DISCONNECTED','FAILED'].includes((await list()).find(c=>c.connection_id===first.connection_id).state),'old transport ended');
 const restarted=await ssh({op:'reconnect',connection:ref(first),request_id:requestId(),cols:80,rows:24});assert.equal(restarted.result,'started');const newer=restarted.connection;await ui.waitFor(`(${tab(first)})?.title.includes(${JSON.stringify('/ '+newer.generation)})`);await closeHeld.restore();await delay(200);assert.ok(await ui.evaluate(`!!(${tab(newer)})`),'late old close cannot hide new generation');assert.ok(!['FAILED','DISCONNECTED'].includes((await list()).find(c=>c.connection_id===newer.connection_id).state));
 await ui.evaluate(`(${closeButton(newer)}).click()`);await ui.waitFor(`!(${tab(newer)})`);
 const closeLost=await ui.interceptIpc({command:'ssh_request',op:'close',mode:'error'});await ui.evaluate(`(${closeButton(right)}).click()`);await ui.waitFor(`document.querySelector('[aria-label="标签操作状态"]')?.textContent.includes('结果可能未知')`);assert.equal(await closeLost.count(),1);await wait(async()=>['DISCONNECTED','FAILED'].includes((await list()).find(c=>c.connection_id===right.connection_id).state),'lost close is actually ended');await ui.waitFor(`(${tab(right)})?.title.includes('DISCONNECTED')||(${tab(right)})?.title.includes('FAILED')`);await ui.evaluate(`(${closeButton(right)}).click()`);await ui.waitFor(`!(${tab(right)})`);assert.equal(await closeLost.count(),1,'hiding an ended target must not resend unknown close');await closeLost.restore();
 const beforeUnknown=(await list()).length,authBefore=(await control({op:'metrics'})).attempts;const startLost=await ui.interceptIpc({command:'ssh_request',op:'start',mode:'error'});await double(a,2);await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('连接结果不明')`);await double(a,2);assert.equal(await startLost.count(),1);assert.equal((await list()).length,beforeUnknown+1);assert.equal((await control({op:'metrics'})).attempts,authBefore);await startLost.restore();await ui.click('查询本次连接');await ui.waitFor(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='使用已记住的凭据')`);assert.equal((await control({op:'metrics'})).attempts,authBefore,'query cannot automatically authenticate');await ui.click('使用已记住的凭据');await connected();
 const beforeRead=(await list()).length;const readFault=await ui.interceptIpc({command:'config_request',op:'page',mode:'error'});await double(a);await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('读取连接配置失败')`);assert.equal(await readFault.count(),1);await readFault.restore();await ui.click('重新读取配置');await ui.waitFor(`document.querySelector('[aria-label="快速连接已保存"]')?.value===${JSON.stringify(a.id)}&&!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='连接').disabled`);assert.equal((await list()).length,beforeRead,'recovering a failed read cannot silently resume direct Start');await ui.click('连接');await connected();
 // Cancelling before Start reply must close only the later returned new ref.
 await ui.evaluate(`(${tab(keyed)}).click()`);const beforeCancelIds=(await list()).map(c=>c.connection_id),beforeCancel=beforeCancelIds.length,cancelAuth=(await control({op:'metrics'})).attempts;const late=await ui.interceptIpc({command:'ssh_request',op:'start',mode:'hold'});await double(a);await wait(async()=>await late.count()===1,'late Start held');await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.waitFor(`!document.querySelector('dialog:modal')`);await late.restore();await wait(async()=>{const all=await list();const added=all.find(c=>!beforeCancelIds.includes(c.connection_id)&&all.length===beforeCancel+1);return added&&['DISCONNECTED','FAILED'].includes(added.state);},'late cancelled Start closes');assert.equal((await list()).find(c=>c.connection_id===keyed.connection_id).state,'CONNECTED');assert.equal((await control({op:'metrics'})).attempts,cancelAuth);
 await ui.invoke('plugin:window|close',{label:'main'});await ui.waitFor(`!!document.querySelector('[aria-label="退出桌面确认"]')`);await ui.click('取消退出');assert.equal(ui.app.exitCode,null,'session close policy must not remove application exit confirmation');
 await ui.screenshot('P12.1-saved-session-final.png');
 const exitOwner=await ui.invoke('service_status');
 await ui.invoke('plugin:window|close',{label:'main'});await ui.waitFor(`!!document.querySelector('[aria-label="退出桌面确认"]')`);
 await ui.evaluate(`setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认退出并停止服务').click(),50);true`);
 await wait(()=>ui.app.exitCode!==null,'confirmed active-session native exit');assert.equal(ui.app.exitCode,0);
 const exitReceipt=JSON.parse(await readFile(path.join(directory,'desktop-close-receipts-v1',`${exitOwner.service_id}.json`),'utf8'));
 assert.equal(exitReceipt.shutdown_ack,'ACKNOWLEDGED');assert.equal(exitReceipt.exited,true);assert.equal(exitReceipt.exit_code,0);assert.equal(exitReceipt.kill_requested,false);
 await writeFile('artifacts/P12.1-saved-session-result.json',JSON.stringify({result:'PASS',singleClickSelects:true,rapidStartOnce:true,doubleClickSavedPassword:true,rightClickActualTarget:true,knownHostNoExtraClick:true,missingCredentialPrompt:true,rejectedStoredCredentialOnce:true,savedEncryptedKey:true,noCloseConfirmation:true,closeDispatchOnce:true,lateClosePreservesNewGeneration:true,unknownCloseNotReplayed:true,unknownStartOriginalQuery:true,lateCancelledStartPreservesOldSession:true,applicationExitConfirmationRetained:true,scope:'owned synthetic SSH; no user connections'},null,2)+'\n');console.log('PASS saved sessions/navigation: double/right-click stored password/key, correct context target, missing/rejected auth fallback, no-confirm exact-ref close/dedup/late-generation/unknown, cancelled late Start, application exit confirmation retained; synthetic only');
}catch(error){console.error('navigation failure:',error.message);if(ui){await ui.screenshot('P12.1-saved-session-failure.png').catch(()=>{});await writeFile('artifacts/P12.1-saved-session-failure.txt',await ui.evaluate(`document.body.innerText`).catch(String));}throw error;}
finally{await ui?.close();fixture?.kill();if(fixture&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(resolve=>fixture.once('exit',resolve));if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-navigation-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
