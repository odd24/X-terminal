import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {connectDesktopPage,dragNativeWindow,launchDesktop,delay} from './lib/DesktopHarness.mjs';
const build=fixture=>{const r=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'fixture and ordinary restoration must actually succeed');};
const wait=async(check,label)=>{for(let i=0;i<300;i++){if(await check())return;await delay(50);}throw new Error(`Timeout: ${label}`);};
const ref=c=>({connection_id:c.connection_id,generation:c.generation});
let directory,ui,detached;const fixtures=[];
try{
 build(true);directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-split-ui-中文-'));
 async function server(name){const d=path.join(directory,name);await mkdir(d);const child=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[d],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixtures.push(child);const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();const next=async()=>{let t;try{return await Promise.race([lines.next().then(v=>JSON.parse(v.value)),new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(t);}};const data=await next();return {...data,control:async value=>{child.stdin.write(JSON.stringify(value)+'\n');return next();}};}
 const one=await server('one'),two=await server('two');ui=await launchDesktop(directory,{fixture:true});
 const ssh=request=>ui.invoke('ssh_request',{request}),raw=async c=>Buffer.from((await ui.invoke('service_read',{connection:ref(c),cursor:1})).events.flatMap(e=>e.bytes));
 async function connect(server,profileId){const profile={id:profileId??crypto.randomUUID(),folder_id:null,name:'split server',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
  if(!profileId)await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
  const r=await ssh({op:'start',profile_id:profile.id,request_id:requestId(),cols:80,rows:24});const target=ref(r.connection),answered=new Set();
  await wait(async()=>{const s=await ssh({op:'status',connection:target});if(s.connection.state==='FAILED')throw new Error('synthetic SSH failed');if(s.challenge&&!answered.has(s.challenge.id)){answered.add(s.challenge.id);if(s.challenge.kind==='host_key'){assert.equal(s.challenge.review.candidate.fingerprint,server.pin);await ssh({op:'answer_host',connection:target,challenge_id:s.challenge.id,approve:true});}else if(s.challenge.kind==='credentials')await ssh({op:'authenticate',connection:target,challenge_id:s.challenge.id,use_saved:true,password:null});}return s.connection.state==='CONNECTED';},'SSH login');return {...target,protocol:'SSH2',state:'CONNECTED',profileId:profile.id};}
 const a=await connect(one),b=await connect(two);const initialA=await raw(a),initialB=await raw(b);
 const menu=async label=>{await ui.evaluate(`document.querySelector('.tools-menu').open=true`);await ui.click(label);};
 const focus=async key=>{await ui.evaluate(`document.querySelector('[data-pane="${key}"] .xterm-helper-textarea').focus()`);await ui.waitFor(`document.querySelector('[data-pane="${key}"]').dataset.active==='true'&&document.activeElement?.closest('[data-pane]')?.dataset.pane==='${key}'`);};
 const ready=async(key,c)=>{await ui.waitFor(`document.querySelector('[data-pane="${key}"]')?.dataset.renderedId===${JSON.stringify(c.connection_id)}&&document.querySelector('[data-pane="${key}"]').dataset.renderedGeneration==='${c.generation}'`);};
 const exact=async(c,bytes)=>wait(async()=>{const actual=await raw(c);return actual.equals(bytes);},'exact connection bytes');
 async function split(first,second,direction){await ui.selectTab(first.connection_id);await wait(async()=>await ui.evaluate(`document.querySelector('dialog[aria-label="连接与服务详情"] [aria-label="权限状态"]').textContent.includes('桌面输入可用')`),'first input readiness');await ui.splitTab(second.connection_id,direction);await ui.waitFor(`document.querySelector('.terminal-grid.${direction}')&&document.querySelectorAll('[data-pane]').length===2`);}
 await split(a,b,'horizontal');await ready('first',a);await ready('second',b);assert.equal(await ui.evaluate(`document.querySelector('[data-pane="first"]').dataset.active`),'true');
 await one.control({op:'push',text:'ONLY_A_OUTPUT'});await two.control({op:'push',text:'ONLY_B_OUTPUT'});await delay(250);
 await focus('first');await ui.command('Input.insertText',{text:'A键盘'});await exact(a,Buffer.concat([initialA,Buffer.from('ONLY_A_OUTPUTA键盘')]));assert.deepEqual(await raw(b),Buffer.concat([initialB,Buffer.from('ONLY_B_OUTPUT')]));
 await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'F6',code:'F6',windowsVirtualKeyCode:117});await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'F6',code:'F6',windowsVirtualKeyCode:117});await ui.waitFor(`document.querySelector('[data-pane="second"]').dataset.active==='true'`);await ui.command('Input.insertText',{text:'B键盘'});await exact(b,Buffer.concat([initialB,Buffer.from('ONLY_B_OUTPUTB键盘')]));
 const snapshot=async key=>{await focus(key);await menu('屏幕快照');return ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]').textContent`);};
 assert.ok((await snapshot('first')).includes('ONLY_A_OUTPUT'));assert.equal((await snapshot('first')).includes('ONLY_B_OUTPUT'),false);assert.ok((await snapshot('second')).includes('ONLY_B_OUTPUT'));
 // Each actual server observes its own pane's fitted PTY size, not the active pane's size.
 const sizes=async(key,server)=>{
   await focus(key);
   let expected,actual;
   await wait(async()=>{
     const text=await ui.evaluate(`document.querySelector('[aria-label="终端视口尺寸"]').textContent`);
     const [cols,rows]=text.match(/(\d+)×(\d+)/).slice(1).map(Number);
     expected=[Math.max(2,Math.min(500,cols)),Math.max(1,Math.min(200,rows))];
     actual=(await server.control({op:'metrics'})).sizes.at(-1);
     return JSON.stringify(actual)===JSON.stringify(expected);
   },`remote pane PTY dimensions for ${key}`).catch(error=>{throw new Error(`${error.message}: local ${expected}, remote ${actual}`);});
   return expected;
 };
 await sizes('first',one);await sizes('second',two);await ui.screenshot('P17-split-horizontal.png');
 const beforeA=await raw(a),beforeB=await raw(b);
 // Queue a second key behind an actually dispatched, held reply; a focus round trip must drop it.
 await focus('first');const held=await ui.interceptIpc({command:'ssh_request',op:'write_text',connectionId:a.connection_id,mode:'hold'});await ui.command('Input.insertText',{text:'FIRST_DISPATCHED'});try{await wait(async()=>await held.count()===1,'held write response hit');}catch(e){await writeFile('artifacts/P17-split-input-debug.json',JSON.stringify({hook:await held.count(),dom:await ui.evaluate(`({active:document.activeElement?.outerHTML,panes:Array.from(document.querySelectorAll('[data-pane]')).map(p=>({key:p.dataset.pane,active:p.dataset.active,id:p.dataset.renderedId,generation:p.dataset.renderedGeneration})),input:document.querySelector('.input-status')?.textContent})`),rawA:(await raw(a)).toString(),rawB:(await raw(b)).toString()},null,2));throw e;}await ui.command('Input.insertText',{text:'DROP_OLD_QUEUE'});await focus('second');await focus('first');await held.restore();await delay(350);await exact(a,Buffer.concat([beforeA,Buffer.from('FIRST_DISPATCHED')]));assert.deepEqual(await raw(b),beforeB);
 // Paste preview belongs to focus and cannot survive switching away/back.
 await ui.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify('NEVER_PASTE\n')});document.querySelector('[data-pane="first"] .xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);await ui.waitFor(`!!document.querySelector('[aria-label="粘贴确认"]')`);await focus('second');await focus('first');assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="粘贴确认"]')`),false);
 await menu('基础撰写');await ui.fill('撰写正文','NEVER_COMPOSE');await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='预览撰写发送'&&!b.disabled)`);await ui.click('预览撰写发送');await ui.waitFor(`!!document.querySelector('[aria-label="撰写发送预览"]')`);await focus('second');await ui.waitFor(`document.querySelector('[aria-label="撰写目标"]').textContent.includes(${JSON.stringify(b.connection_id)})`);assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="撰写发送预览"]')`),false);await ui.click('关闭撰写');
 // Closing just a pane keeps both actual connections alive, then explicit vertical layout.
 await ui.evaluate(`document.querySelector('[aria-label="收起窗格 2"]').click()`);await ui.waitFor(`document.querySelectorAll('[data-pane]').length===1`);assert.equal((await ui.invoke('service_list')).filter(c=>c.state==='CONNECTED').length,2);await split(a,b,'vertical');await ready('first',a);await ready('second',b);await sizes('first',one);await sizes('second',two);await ui.screenshot('P17-split-vertical.png');
 const resized=JSON.parse(execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),'-Width','1250','-Height','880'],{encoding:'utf8',windowsHide:true}));assert.deepEqual(resized,{width:1250,height:880});await delay(300);await sizes('first',one);await sizes('second',two);assert.deepEqual(await raw(a),Buffer.concat([beforeA,Buffer.from('FIRST_DISPATCHED')]));assert.deepEqual(await raw(b),beforeB);
 // Lost response stops only that controller, never retries and never redirects into the other pane.
 await focus('second');const lost=await ui.interceptIpc({command:'ssh_request',op:'write_text',connectionId:b.connection_id,mode:'error'});await ui.command('Input.insertText',{text:'B_UNKNOWN'});await ui.waitFor(`document.querySelector('[data-pane="second"] .pane-status')?.textContent.includes('未重试')`);assert.equal(await ui.evaluate(`document.querySelector('.footer-attention')?.textContent.includes('未重试')`),true);assert.equal(await lost.count(),1);await lost.restore();await ui.command('Input.insertText',{text:'NEVER_AFTER_UNKNOWN'});await focus('first');await ui.command('Input.insertText',{text:'A_STILL_OK'});await exact(a,Buffer.concat([beforeA,Buffer.from('FIRST_DISPATCHEDA_STILL_OK')]));await exact(b,Buffer.concat([beforeB,Buffer.from('B_UNKNOWN')]));
 // A delayed old read cannot adopt the new generation or render it into the frozen pane.
 const oldRead=await ui.interceptIpc({command:'service_read',connectionId:a.connection_id,mode:'hold'});await wait(async()=>await oldRead.count()>0,'held output response');await ssh({op:'close',connection:ref(a)});await wait(async()=>['DISCONNECTED','FAILED'].includes((await ssh({op:'status',connection:ref(a)})).connection.state),'old transport ended before reconnect');const renewed=(await ssh({op:'reconnect',connection:ref(a),request_id:requestId(),cols:80,rows:24})).connection;assert.ok(renewed.generation>a.generation);await delay(250);await oldRead.restore();await ui.waitFor(`document.querySelector('[data-pane="first"] .pane-status')?.textContent.includes('会话已变化')`);assert.equal(await ui.evaluate(`document.querySelector('[data-pane="first"]').dataset.renderedGeneration??''`),'');
 // Only explicit selection and normal current-generation authentication can bind the new actor.
 const handled=new Set();await wait(async()=>{const s=await ssh({op:'status',connection:ref(renewed)});if(s.challenge&&!handled.has(s.challenge.id)){handled.add(s.challenge.id);if(s.challenge.kind==='host_key')await ssh({op:'answer_host',connection:ref(renewed),challenge_id:s.challenge.id,approve:true});else if(s.challenge.kind==='credentials')await ssh({op:'authenticate',connection:ref(renewed),challenge_id:s.challenge.id,use_saved:true,password:null});}return s.connection.state==='CONNECTED';},'new generation authentication');await ui.selectTab(renewed.connection_id);await ready('first',renewed);
 // Mixed UART uses the same focused input path, no probes; source choice remains explicit.
 await ui.click('收起分屏，保留连接');await ui.click('串口连接');await ui.waitFor(`document.querySelector('[aria-label="UART端口"]')?.options.length===2`);await ui.fill('UART端口',await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').options[1].value`));await ui.click('连接串口');await ui.waitFor(`!document.querySelector('dialog:modal')`);const uart=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL');assert.ok(uart);assert.equal((await raw(uart)).length,0);
 const currentA={...renewed,protocol:'SSH2',state:'CONNECTED'};await split(currentA,uart,'horizontal');await ready('first',currentA);await ready('second',uart);await focus('second');await ui.command('Input.insertText',{text:'UART_ONLY'});await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await exact(uart,Buffer.from('UART_ONLY\r'));await ui.waitFor(`document.querySelector('[aria-label="UART连接状态"]')?.textContent.includes('接收 10 字节')`);
 await ui.click('终端日志');await ui.waitFor(`document.querySelector('[aria-label="日志目标"]')?.textContent.includes(${JSON.stringify(uart.connection_id)})`);await focus('first');await ui.waitFor(`document.querySelector('[aria-label="日志目标"]').textContent.includes(${JSON.stringify(currentA.connection_id)})`);await ui.click('关闭日志面板');await ui.screenshot('P17-split-mixed.png');
 const paletteX=process.argv.includes('--palette-x');
 const config=request=>ui.invoke('config_request',{request});
 async function savePalette(value){
   await menu('软件设置');
   await ui.click('重新读取偏好');
   await ui.waitFor(`document.querySelector('[aria-label="桌面偏好状态"]')?.textContent.startsWith('已读取')`);
   await ui.fill('终端配色',value);await ui.click('保存桌面偏好');
   await ui.waitFor(`document.querySelector('[aria-label="桌面偏好状态"]')?.textContent.startsWith('已保存')`);
   await ui.click('关闭软件设置');
 }
 let originalPreferences;
 if(paletteX){
   originalPreferences=(await config({op:'preferences'})).preferences;
   await savePalette('x');
   assert.equal((await config({op:'preferences'})).preferences.terminal_palette,'x');

   const normal=['000000','d50000','008000','999606','0080ff','800080','0080c0','cfd8d3'];
   const bright=['535755','e30000','00ff40','ffff00','0080ff','ff00ff','00ffff','ffffff'];
   const colors=[
     ['normal-text','0','00e600'],['bold-text','1','ffffff'],['rgb-text','1;38;2;18;52;86','123456'],['extended-text','38;5;196','ff0000'],['painted-bg','31;44','d50000'],
     ...normal.map((color,i)=>['basic-'+i,String(30+i),color]),
     ...bright.map((color,i)=>['bright-'+i,String(90+i),color]),
     ...bright.map((color,i)=>['bold-'+i,'1;'+(30+i),color]),
   ];
   const sample='\x1b[2J\x1b[H'+colors.map(([name,sgr])=>'\x1b['+sgr+'m'+name+'\x1b[0m').join('\r\n');
   const beforeUart=await raw(uart);
   await one.control({op:'push',text:sample});
   await focus('second');
   await ui.invoke('serial_request',{request:{op:'send',connection:ref(uart),request_id:requestId(),content:Buffer.from(sample).toString('hex').match(/../g).join(' '),format:'hex',ending:'none',pace:{chunk_bytes:1024,interval_ms:0}}});
   await exact(uart,Buffer.concat([beforeUart,Buffer.from(sample)]));
   const wanted=Object.fromEntries(colors.map(([name,,hex])=>[name,'rgb('+hex.match(/../g).map(byte=>parseInt(byte,16)).join(', ')+')']));
   for(const key of ['first','second']){
     const pane='[data-pane="'+key+'"]';
     await ui.waitFor('document.querySelector('+JSON.stringify(pane+' .xterm-rows')+').textContent.includes("bold-7")');
     const computed=await ui.evaluate('(()=>{const pane=document.querySelector('+JSON.stringify(pane)+');return {background:getComputedStyle(pane.querySelector(".terminal")).backgroundColor, colors:Object.fromEntries([...pane.querySelectorAll(".xterm-rows > div > span")].filter(span=>'+JSON.stringify(Object.keys(wanted))+'.includes(span.textContent)).map(span=>[span.textContent,getComputedStyle(span).color]))};})()');
     assert.deepEqual(computed,{background:'rgb(0, 0, 0)',colors:wanted});
   }
   assert.notEqual(await ui.evaluate('getComputedStyle(document.querySelector(".window-chrome")).backgroundColor'),'rgb(0, 0, 0)');
   await menu('软件设置');
   await ui.fill('终端文字亮度',70);
   await ui.waitFor(`document.querySelector('.desktop-shell').dataset.terminalDim==='true'`);
   await ui.click('关闭软件设置');
   for(const key of ['first','second']){
     const ink=await ui.evaluate(`(()=>{
       const pane=document.querySelector('[data-pane="${key}"]');
       const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
       const ctx=canvas.getContext('2d');
       const pixels=span=>{
         ctx.clearRect(0,0,1,1);
         ctx.fillStyle=getComputedStyle(span).webkitTextFillColor;ctx.fillRect(0,0,1,1);
         return [...ctx.getImageData(0,0,1,1).data];
       };
       const tokens=${JSON.stringify(colors.map(([name])=>name))};
       const spans=[...pane.querySelectorAll('.xterm-rows span')].filter(span=>tokens.includes(span.textContent));
       const cursor=pane.querySelector('.xterm-cursor-block');
       return {
         background:getComputedStyle(pane.querySelector('.terminal')).backgroundColor,
         paintedBackground:getComputedStyle(spans.find(span=>span.textContent==='painted-bg')).backgroundColor,
         cursorPreserved:!cursor||getComputedStyle(cursor).webkitTextFillColor===getComputedStyle(cursor).color,
         ink:Object.fromEntries(spans.map(span=>[span.textContent,pixels(span)]))
       };
     })()`);
     assert.equal(ink.background,'rgb(0, 0, 0)');
     assert.equal(ink.paintedBackground,'rgb(0, 128, 255)');
     assert.equal(ink.cursorPreserved,true);
     assert.deepEqual(Object.keys(ink.ink),colors.map(([name])=>name));
     for(const [name,,hex] of colors){
       const rgb=hex.match(/../g).map(byte=>parseInt(byte,16));
       const [r,g,b,a]=ink.ink[name];
       assert.ok(Math.abs(a-179)<=1,`${key} ${name} fill alpha`);
       assert.ok([r,g,b].every((value,index)=>Math.abs(value-rgb[index])<=2),`${key} ${name}: ${[r,g,b]} ≈ ${rgb}`);
     }
   }
   await ui.screenshot('terminal-brightness-70.png');
   await focus('second');
   const selectionPoint=await ui.evaluate(`(()=>{
     const span=[...document.querySelectorAll('[data-pane="second"] .xterm-rows span')].find(el=>el.textContent==='normal-text');
     const rect=span.getBoundingClientRect();
     return {x:rect.left+2,right:rect.right-2,y:rect.top+rect.height/2};
   })()`);
   const {x,right,y}=selectionPoint;
   await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x,y});
   await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:right,y});
   await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:right,y});
   await ui.waitFor(`document.querySelector('[data-pane="second"] .xterm-selection > div')&&getComputedStyle(document.querySelector('[data-pane="second"] .xterm-selection > div')).backgroundColor==='rgb(53, 75, 97)'`);
   await menu('软件设置');
   await ui.screenshot('terminal-brightness-slider.png');
   await ui.fill('终端文字亮度',100);
   await ui.waitFor(`!document.querySelector('.desktop-shell').hasAttribute('data-terminal-dim')`);
   await ui.click('关闭软件设置');
   await ui.waitFor(`[...document.querySelectorAll('.xterm-rows .xterm-bold')].filter(el=>el.textContent==='bold-text'&&getComputedStyle(el).color==='rgb(255, 255, 255)').length===2`);
   await ui.screenshot('palette-x-ssh-uart.png');
   console.log('PASS X actual SSH and UART xterm cells: default, bold, truecolor, 16 ANSI slots and eight SGR bold colors; UI untouched');
 }
 const exactUART=await raw(uart);await ui.evaluate(`document.querySelector('[aria-label="关闭标签 ${uart.connection_id}"]').click()`);await ui.waitFor(`document.querySelectorAll('[data-pane]').length===1`);assert.equal((await ui.invoke('service_list')).find(c=>c.connection_id===currentA.connection_id).state,'CONNECTED');assert.deepEqual(await raw(uart),exactUART);
 // Same saved Profile remains two actual independent connections in two panes.
 const twin=await connect(one,a.profileId);await split(currentA,twin,'horizontal');const firstKey=await ui.evaluate(`document.querySelector('[data-active="true"][data-pane]').dataset.pane`);const secondKey=firstKey==='first'?'second':'first';await ready(firstKey,currentA);await ready(secondKey,twin);const oldTwin=await raw(twin);await focus(secondKey);await ui.command('Input.insertText',{text:'TWIN_ONLY'});await exact(twin,Buffer.concat([oldTwin,Buffer.from('TWIN_ONLY')]));assert.equal((await raw(currentA)).includes(Buffer.from('TWIN_ONLY')),false);
 await one.control({op:'end'});await wait(async()=>(await ssh({op:'status',connection:ref(twin)})).connection.state==='DISCONNECTED','remote end exact twin');await ui.waitFor(`document.querySelector('[data-pane="${secondKey}"] .pane-status')?.textContent.includes('会话已断开')`);const finalTwin=await raw(twin);await ui.command('Input.insertText',{text:'NEVER_AFTER_REMOTE_END'});await delay(150);assert.deepEqual(await raw(twin),finalTwin);assert.equal((await ui.invoke('service_list')).find(c=>c.connection_id===currentA.connection_id).state,'CONNECTED');
 await ui.command('Page.reload');await ui.waitFor(`document.querySelectorAll('[data-pane]').length===1`);assert.equal((await ui.invoke('service_list')).filter(c=>c.state==='CONNECTED').length,2);assert.deepEqual(await raw(twin),Buffer.concat([oldTwin,Buffer.from('TWIN_ONLY')]));
 if(paletteX){
   await ui.waitFor("document.documentElement.dataset.terminalPalette==='x'");
   assert.deepEqual((await config({op:'preferences'})).preferences,{...originalPreferences,terminal_palette:'x'});
   await savePalette(originalPreferences.terminal_palette);
   assert.deepEqual((await config({op:'preferences'})).preferences,originalPreferences);
 }
 if(process.argv.includes('--font-size')){
   const saved=()=>config({op:'preferences'}).then(reply=>reply.preferences);
   const readSize=(page,c,size)=>page.waitFor(`(()=>{
     const pane=document.querySelector('[data-rendered-id="${c.connection_id}"]');
     const text=pane?.querySelector('.xterm-rows span');
     return !!text&&getComputedStyle(text).fontSize==='${size}px';
   })()`);
   const both=(c,d,size)=>Promise.all([readSize(ui,c,size),readSize(ui,d,size)]);
   async function newUart(marker){
     await ui.click('串口连接');
     await ui.waitFor(`document.querySelector('[aria-label="UART端口"]')?.options.length===2`);
     await ui.fill('UART端口',await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').options[1].value`));
     await ui.click('连接串口');
     await ui.waitFor(`!document.querySelector('dialog:modal')`);
     const found=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL'&&c.state==='CONNECTED');
     assert.ok(found);
     const before=await raw(found);
     await ui.invoke('serial_request',{request:{op:'send',connection:ref(found),request_id:requestId(),content:marker,format:'text',ending:'none',pace:{chunk_bytes:1024,interval_ms:0}}});
     await exact(found,Buffer.concat([before,Buffer.from(marker)]));
     return found;
   }
   const before=await saved();
   assert.equal(before.font_size,15);
   const existingUart=await newUart('FONT-EXISTING-UART');
   await split(currentA,existingUart,'horizontal');
   await both(currentA,existingUart,15);
   await menu('软件设置');
   await ui.fill('应用主题',before.theme==='dark'?'light':'dark');
   await ui.fill('终端文字亮度',65);
   const held=await ui.interceptIpc({command:'save_terminal_font_size',op:undefined,mode:'hold'});
   try{
     await ui.fill('终端字号',17);
     await wait(async()=>await held.count()===1,'first size response held');
     assert.equal((await saved()).font_size,17);
     await ui.click('关闭软件设置');
     await ui.evaluate(`document.querySelector('.tools-menu').open=true`);
     await ui.fill('终端字号',22);
     await ui.fill('终端字号',24);
     await both(currentA,existingUart,24);
     assert.equal((await saved()).font_size,17);
     await held.release();
     await wait(async()=>await held.count()===2,'only the latest queued size is written');
     await held.release();
     await ui.waitFor(`document.querySelector('[aria-label="终端字号保存状态"]').textContent==='字号已自动保存'`);
     assert.deepEqual(await saved(),{...before,font_size:24});
     assert.equal(await held.count(),2);
   }finally{await held.restore();}
   await ui.evaluate(`document.querySelector('.tools-menu').open=false`);
   await ui.screenshot('terminal-font-size-mixed-24.png');

   const start=await ui.evaluate(`(()=>{
     const r=document.querySelector('[data-rendered-id="${currentA.connection_id}"] .pane-focus').getBoundingClientRect();
     return {x:r.x+r.width/2,y:r.y+r.height/2};
   })()`);
   await ui.command('Page.bringToFront');
   dragNativeWindow(ui.app,[start,{x:start.x-25,y:start.y+44},{x:58,y:140},{x:-40,y:180,outside:true}]);
   let target;await wait(async()=>{[target]=await ui.otherPages();return !!target;},'new native SSH window');
   detached=await connectDesktopPage(target);
   const previousOwner=await ui.invoke('service_status');
   assert.equal((await detached.invoke('service_status')).service_id,previousOwner.service_id);
   await readSize(detached,currentA,24);
   await menu('软件设置');
   await ui.fill('终端字号',20);
   await ui.waitFor(`document.querySelector('[aria-label="终端字号保存状态"]').textContent==='字号已自动保存'`);
   await ui.click('关闭软件设置');
   await Promise.all([readSize(ui,existingUart,20),readSize(detached,currentA,20)]);
   await detached.screenshot('terminal-font-size-detached-20.png');

   const exitSave=await ui.interceptIpc({command:'save_terminal_font_size',op:undefined,mode:'hold'});
   await ui.evaluate(`document.querySelector('.tools-menu').open=true`);
   await ui.fill('终端字号',23);
   await wait(async()=>await exitSave.count()===1,'final size response held');
   await ui.invoke('plugin:window|close',{label:'main'});
   await ui.waitFor(`!!document.querySelector('dialog:modal[aria-label="退出桌面确认"]')`);
   await ui.click('确认退出并停止服务');
   await delay(240);
   assert.equal(ui.app.exitCode,null,'managed exit waits while the confirmed size is being saved');
   await exitSave.release();
   await wait(()=>ui.app.exitCode!==null,'normal application exit');
   assert.equal(ui.app.exitCode,0);
   detached.close();detached=undefined;
   await ui.close();ui=await launchDesktop(directory,{fixture:true});
   assert.notEqual((await ui.invoke('service_status')).service_id,previousOwner.service_id);
   assert.deepEqual(await saved(),{...before,font_size:23},'closed dialog and restart preserve only the committed size');
   const afterSsh=await connect(one,a.profileId);
   const afterUart=await newUart('FONT-RESTART-UART');
   await split(afterSsh,afterUart,'horizontal');
   await both(afterSsh,afterUart,23);
   await ui.screenshot('terminal-font-size-restart-23.png');
   await writeFile('artifacts/terminal-font-size-result.json',JSON.stringify({
     result:'PASS',existing:{before:15,after:24},detached:{initial:24,after:20},normalRestart:{ssh:23,uart:23},otherPreferences:'unchanged',heldClose:'waited for original response',
   },null,2));
   console.log('PASS terminal font size 15→24 mixed, 24→20 in detached, 23px new SSH/UART after normal restart, isolated writes and held close');
 }
 await writeFile('artifacts/P17-split-result.json',JSON.stringify({result:'PASS',identities:{a,b,renewed,uart,twin},realWindow:resized,hardware:'memory serial; no COM'},null,2));
 console.log('PASS native two-pane terminals: horizontal/vertical, actual independent SSH sizes/window resize, focused keyboard/F6, held queue roundtrip drop, paste/compose invalidation, lost write no replay, exact generation freeze/new explicit bind, mixed UART/log target, pane collapse keeps sessions, exact tab close, same-Profile instances, reload single without replay');
}catch(error){if(ui){await ui.screenshot('P17-split-failure.png').catch(()=>{});await writeFile('artifacts/P17-split-failure.txt',await ui.evaluate('document.body.innerText').catch(String));}throw error;
}finally{try{detached?.close();await ui?.close();for(const c of fixtures){c.kill();if(c.exitCode===null&&c.signalCode===null)await new Promise(resolve=>c.once('exit',resolve));}if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-split-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}finally{build(false);}}
