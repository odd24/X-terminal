import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
const build=fixture=>{const r=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'fixture and ordinary restoration must actually succeed');};
const wait=async(check,label)=>{for(let i=0;i<300;i++){if(await check())return;await delay(20);}throw new Error(`Timeout: ${label}`);};
const ref=c=>({connection_id:c.connection_id,generation:c.generation});
let directory,output,ui,editorObservationError;const fixtures=[];
try{
 build(true);directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-log-menu-ui-中文-'));output=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));
 async function server(name){const d=path.join(directory,name);await mkdir(d);const child=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[d],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixtures.push(child);const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();const next=async()=>{let t;try{return await Promise.race([lines.next().then(v=>JSON.parse(v.value)),new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(t);}};const data=await next();return {...data,control:async value=>{child.stdin.write(JSON.stringify(value)+'\n');return next();}};}
 const one=await server('one'),two=await server('two');ui=await launchDesktop(directory,{fixture:true});
 const ssh=request=>ui.invoke('ssh_request',{request}),raw=async c=>Buffer.from((await ui.invoke('service_read',{connection:ref(c),cursor:1})).events.flatMap(e=>e.bytes));
 async function connect(server,profileId){const profile={id:profileId??crypto.randomUUID(),folder_id:null,name:'split server',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
  if(!profileId)await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
  const r=await ssh({op:'start',profile_id:profile.id,request_id:requestId(),cols:80,rows:24});const target=ref(r.connection),answered=new Set();
  await wait(async()=>{const s=await ssh({op:'status',connection:target});if(s.connection.state==='FAILED')throw new Error('synthetic SSH failed');if(s.challenge&&!answered.has(s.challenge.id)){answered.add(s.challenge.id);if(s.challenge.kind==='host_key'){assert.equal(s.challenge.review.candidate.fingerprint,server.pin);await ssh({op:'answer_host',connection:target,challenge_id:s.challenge.id,approve:true});}else if(s.challenge.kind==='credentials')await ssh({op:'authenticate',connection:target,challenge_id:s.challenge.id,use_saved:true,password:null});}return s.connection.state==='CONNECTED';},'SSH login');return {...target,protocol:'SSH2',state:'CONNECTED',profileId:profile.id};}

 const a=await connect(one),b=await connect(two);
 const logging=request=>ui.invoke('logging_request',{request}),native=request=>ui.invoke('terminal_log_request',{request}),save=request=>ui.invoke('export_save_request',{request});
 const owner=(await ui.invoke('service_status')).service_id,target=c=>({service_id:owner,protocol:c.protocol,connection:ref(c)});
 const list=c=>logging({op:'list',connection:ref(c)}),active=async c=>(await list(c)).logs.find(l=>l.active),file=l=>path.join(directory,'logs',l.readable.filename);
 const tools=async label=>{await ui.evaluate(`document.querySelector('.tools-menu').open=true`);await ui.click(label);};
 const focus=async key=>{await ui.command('Page.bringToFront');await ui.evaluate(`document.querySelector('[data-pane="${key}"] .xterm-helper-textarea').focus()`);await ui.waitFor(`document.querySelector('[data-pane="${key}"]').dataset.active==='true'`);};
 const ready=async(key,c)=>ui.waitFor(`document.querySelector('[data-pane="${key}"]')?.dataset.renderedId===${JSON.stringify(c.connection_id)}&&document.querySelector('[data-pane="${key}"]').dataset.renderedGeneration==='${c.generation}'`);
 async function split(first,second){await ui.fill('会话',first.connection_id);await tools('分屏');await ui.waitFor(`!!document.querySelector('[aria-label="分屏第二个会话"]')`);await ui.fill('分屏第二个会话',`${second.connection_id}/${second.generation}`);await ui.fill('分屏排列方向','horizontal');await ui.click('创建分屏');await ready('first',first);await ready('second',second);}
 const topMenu=async()=>{
   await ui.waitFor(`!document.querySelector('.toolbar-log').disabled`);
   const p=await ui.evaluate(`(()=>{const b=document.querySelector('.toolbar-log');const r=b.getBoundingClientRect();const x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;if(document.elementFromPoint(x,y)!==b)throw Error('log control is occluded');return {x,y};})()`);
   await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...p});
   await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...p});
   await ui.waitFor(`!!document.querySelector('[aria-label="终端日志菜单"]')`);
 };
 const badge=connection=>`document.querySelector('[data-connection-id="${connection.connection_id}"] .tab-log-badge')`;
 const slot=()=>ui.evaluate(`JSON.parse(sessionStorage.getItem('terminal-context-log-task-v1'))`);
 async function right(key){await ui.command('Page.bringToFront');const p=await ui.evaluate(`(()=>{const r=document.querySelector('[data-pane="${key}"] .terminal').getBoundingClientRect();return{x:r.x+24,y:r.y+24};})()`);await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...p});await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...p});await ui.waitFor(`!!document.querySelector('[aria-label="终端日志菜单"]')`);assert.equal(await ui.evaluate(`document.querySelector('[data-pane="${key}"]').dataset.active`),'true');}
 async function choose(key,label){await right(key);await ui.waitFor(`Array.from(document.querySelectorAll('[aria-label="终端日志菜单"] button')).some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`);await ui.click(label);return slot();}
 async function done(){await ui.waitFor(`!document.querySelector('[aria-label="终端日志菜单"]')`);await delay(200);}
 async function start(key,c){await choose(key,'开始记录');await wait(async()=>!!(await active(c))?.readable,'UI start readable');await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('正在记录')`);return active(c);}
 async function stop(key,c){const l=await active(c);await choose(key,'停止记录');await wait(async()=>(await logging({op:'status',connection:ref(c),log_id:l.log_id})).durable,'UI durable stop');await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('停止并同步')`);}
 async function ps(script,args){await new Promise((resolve,reject)=>{const c=spawn('pwsh',['-NoProfile','-STA','-File',script,...args],{windowsHide:true});let result='';c.stdout.on('data',d=>result+=d);c.stderr.on('data',d=>result+=d);c.on('exit',code=>code===0?(console.log(result.trim()),resolve()):reject(Error(result)));c.on('error',reject);});await ui.command('Page.bringToFront');}
 const picker=(destination,action='select')=>ps('scripts/lib/NativeSaveDialog.ps1',['-TargetProcessId',String(ui.app.pid),'-Action',action,...(destination?['-TargetPath',destination]:[])]);
 async function prepared(t){let info;await wait(async()=>{try{info=await native({op:'status',target:t.target,request_id:t.request_id});}catch{return false;}if(info.phase==='FAILED')throw Error('Native prepare failed: '+info.failure);return info.phase==='COMPLETED';},'menu prepared');return {info,bytes:await readFile(path.join(directory,'terminal-menu/terminal-log-exports',t.request_id,'export.jsonl'))};}
 async function saveTask(t){let result;await wait(async()=>{result=await ui.evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify('terminal-menu-log-save-'+t.request_id)}))`);return !!result;},'original native save ID');return result;}
 async function finishSave(t,bytes,destination){const fingerprint=createHash('sha256').update(bytes).digest('hex');assert.equal((await native({op:'status',target:t.target,request_id:t.request_id})).sha256,fingerprint);const s=await saveTask(t);assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('[aria-label="终端右键日志操作"] button')).some(b=>b.textContent==='保存日志')`),false);await picker(destination);let info;await wait(async()=>{info=await save({op:'status',scope:s.scope,save_id:s.save_id});return info.phase==='COMPLETED';},'native save completed');assert.deepEqual(await readFile(destination),bytes);await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')&&document.querySelector('[aria-label="日志保存反馈"]')?.textContent.includes('日志已保存')`);await ui.waitFor(`document.activeElement===document.querySelector('[data-pane][data-active="true"][data-rendered-id="${t.target.connection.connection_id}"] .xterm-helper-textarea')`);await wait(async()=>(await native({op:'status',target:t.target,request_id:t.request_id})).phase==='REMOVED','only own completed snapshot cleaned');return info;}
 async function exportMenu(key,label,name){const t=await choose(key,label),p=await prepared(t);await finishSave(t,p.bytes,path.join(output,name));return {...p,t};}
 // Legacy automatic right-paste must never run while opening this menu.
 const prefs=await ui.invoke('config_request',{request:{op:'preferences'}});await ui.invoke('config_request',{request:{op:'save_preferences',revision:prefs.revision,preferences:{...prefs.preferences,right_click_paste:true}}});await ui.command('Page.reload');
 await split(a,b);await focus('first');
 await ui.screenshot('CR-022-S3-split.png');
 // Create a real selection in the right terminal. Changing active pane must
 // leave the selection available to the right-click handler on that pane.
 await two.control({op:'push',text:'\r\nRIGHTCOPYTOKEN\r\n'});
 const point=await (async()=>{
   const selector='[data-pane="second"] .xterm-rows > div';
   await ui.waitFor(`[...document.querySelectorAll('${selector}')].some(row=>row.textContent.startsWith('RIGHTCOPYTOKEN'))`);
   return ui.evaluate(`(()=>{const r=[...document.querySelectorAll('${selector}')].find(row=>row.textContent.startsWith('RIGHTCOPYTOKEN')).getBoundingClientRect();return{x:r.left+16,y:r.top+r.height/2};})()`);
 })();
 await focus('second');
 await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:2,...point});
 await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:2,...point});
 await ui.waitFor(`!!document.querySelector('[data-pane="second"] .xterm-selection > div')`);
 await focus('first');
 const beforeCopyA=await raw(a),beforeCopyB=await raw(b);
 await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...point});
 await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...point});
 await ui.waitFor(`document.querySelector('[aria-label="剪贴板状态"]')?.textContent==='终端选区已复制'`);
 assert.equal(await ui.invoke('terminal_clipboard_read'),'RIGHTCOPYTOKEN');
 assert.equal(await ui.evaluate(`!!document.querySelector('.terminal-context-menu')`),false);
 assert.deepEqual(await raw(a),beforeCopyA);assert.deepEqual(await raw(b),beforeCopyB);
 await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
 await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
 await focus('first');
 const clip=await ui.interceptIpc({command:'terminal_clipboard_read',mode:'error'});await right('second');await ui.screenshot('P11.4-log-menu-native.png');assert.equal(await clip.count(),0);await clip.restore();
 const notice='document.querySelector(".terminal-log-operation")';
 async function clickMenuAt(label, twice=false){
   return ui.evaluate(`(()=>{
     const time=performance.now();
     const button=[...document.querySelectorAll('.terminal-context-menu button')].find(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled);
     if(!button?.getClientRects().length)throw Error('notice menu action must be visible');
     button.click();if(${twice})button.click();return time;
   })()`);
 }
 async function dismissalTime(opened){
   await ui.waitFor(`!${notice}`);
   const elapsed=await ui.evaluate(`performance.now()-${opened}`);
   assert.ok(elapsed>=4800&&elapsed<5900,`recording notice dismissed in ${elapsed} ms`);
   return Math.round(elapsed);
 }
 const heldNotice=await ui.interceptIpc({op:'start',connectionId:b.connection_id,mode:'hold'});
 await ui.waitFor(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(b=>b.textContent==='开始记录'&&!b.disabled)`);
 const opened=await clickMenuAt('开始记录',true);
 await wait(async()=>await heldNotice.count()===1,'one recording start with held status');
 await ui.waitFor(`!!${notice}`);
 await delay(2400);
 await heldNotice.restore();
 await wait(async()=>!!(await active(b))?.readable,'right B starts B only');
 await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('正在记录')`);
 const lbInitial=await active(b);let lb=lbInitial;
 assert.equal((await list(b)).logs.length,1);assert.equal((await list(a)).logs.length,0);assert.equal((await slot()).target.connection.connection_id,b.connection_id);
 const original=await slot();
 await ui.screenshot('log-status-timeout-open.png');
 const firstDismissal=await dismissalTime(opened);
 await ui.waitFor(`(${badge(b)})?.title==='● 记录中'&&document.querySelector('.toolbar-log').textContent.trim()==='● 记录中'`);
 await right('second');
 const reopened=await clickMenuAt('查看上次日志操作');
 await ui.waitFor(`!!${notice}`);
 const secondDismissal=await dismissalTime(reopened);
 await right('second');
 await clickMenuAt('查看上次日志操作');
 await ui.waitFor(`!!${notice}`);
 await ui.click('收起日志操作');
 await ui.waitFor(`!${notice}`);
 assert.equal((await slot()).request_id,original.request_id);
 assert.equal((await active(b)).log_id,lbInitial.log_id);
 assert.equal((await list(b)).logs.length,1);
 await ui.screenshot('log-status-timeout-dismissed.png');
 await two.control({op:'push',text:'B-FIRST-ROUND\r\n'});
 await wait(async()=>(await readFile(file(lb),'utf8')).includes('B-FIRST-ROUND'),'B file grows after the notice closes');
 console.log(`PASS recording status auto-dismissed in ${firstDismissal} ms, reopened for ${secondDismissal} ms, manual dismissal preserves original recording`);
 // A buffer is explicitly exportable before recording; all-recorded is not fabricated.
 await focus('first');
 await ui.waitFor(`(${badge(b)})?.title==='● 记录中'&&! (${badge(a)})`);
 const unrecordedLines=Array.from({length:80},(_,i)=>`UNRECORDED-${String(i).padStart(2,'0')}`);
 await one.control({op:'push',text:'\r\n'+unrecordedLines.join('\r\n')+'\r\n'});
 await ui.waitFor(`document.querySelector('[data-pane="first"] .xterm-rows').textContent.includes('UNRECORDED-79')`);
 const singleSave=await ui.interceptIpc({command:'export_save_request',op:'start',mode:'delay',delayMs:0});
 await topMenu();
 assert.equal(await ui.evaluate(`document.querySelector('.log-menu-target').textContent.endsWith('左窗格')`),true);
 assert.equal(await ui.evaluate(`document.querySelector('.terminal-context-menu [role="menuitem"]').textContent`),'保存终端缓冲内容…');
 await ui.screenshot('CR-022-S4-log-menu.png');assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='另存全部已记录日志…').disabled`),true);await ui.click('保存终端缓冲内容…');const bufferTask=await slot(),buffer=await prepared(bufferTask);const bufferSaved=await finishSave(bufferTask,buffer.bytes,path.join(output,'保留缓冲.log'));assert.equal((await list(a)).logs.length,0);assert.ok(buffer.bytes.includes(Buffer.from('UNRECORDED-00'))&&buffer.bytes.includes(Buffer.from('UNRECORDED-79')));assert.equal(await singleSave.count(),1,'one export intent starts one native picker/save');await singleSave.restore();await right('first');assert.ok((await ui.evaluate(`document.querySelector('[aria-label="最近日志保存路径"]').textContent`)).includes(bufferSaved.path));await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 const unrecordedScreenTask=await choose('first','只保存当前可见屏幕…');
 const unrecordedScreen=await prepared(unrecordedScreenTask);
 assert.ok(unrecordedScreen.bytes.includes(Buffer.from('UNRECORDED-79')));
 assert.equal(unrecordedScreen.bytes.includes(Buffer.from('UNRECORDED-00')),false);
 const cancelledScreen=await saveTask(unrecordedScreenTask);await picker(undefined,'cancel');
 await wait(async()=>(await save({op:'status',scope:cancelledScreen.scope,save_id:cancelledScreen.save_id})).phase==='CANCELLED','unrecorded screen system cancel');
 await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);
 // A late start response stays on A, while the selected pane remains B.
 const late=await ui.interceptIpc({op:'start',connectionId:a.connection_id,mode:'hold'});await choose('first','开始记录');await wait(async()=>await late.count()===1,'held A start');await focus('second');await late.restore();await wait(async()=>!!(await active(a))?.readable,'A starts once');await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('正在记录')`);const la=await active(a);assert.equal(await ui.evaluate(`document.querySelector('[data-pane="second"]').dataset.active`),'true');assert.equal((await list(a)).logs.length,1);
 await focus('first');await ui.click('收起分屏，保留连接');await ui.click('串口连接');await ui.waitFor(`document.querySelector('[aria-label="UART端口"]')?.options.length===2`);await ui.fill('UART端口',await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').options[1].value`));await ui.fill('UART波特率',57600);await ui.click('连接串口');await ui.waitFor(`!document.querySelector('dialog:modal')`);const uart=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL');await ready('first',uart);const lu=await start('first',uart);await wait(async()=>(await readFile(file(lu),'utf8')).includes('Android启动 log'),'passive UART live file');assert.equal((await readdir(path.join(directory,'logs'),{withFileTypes:true})).every(e=>e.isFile()),true);assert.equal((await active(a)).log_id,la.log_id);assert.equal((await active(b)).log_id,lb.log_id);
 await exportMenu('first','另存全部已记录日志…','UART全部.log');
 await split(a,b);
 console.log('Real system folder');
 // Real system folder and actual active file, not a generated snapshot.
 await choose('second','打开日志目录');await ps('scripts/lib/ObserveLogShell.ps1',['-Root',directory,'-TargetPath',path.join(directory,'logs'),'-Action','directory']);await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('已请求打开')`);
 await choose('second','打开当前日志文件');try{
   await ps('scripts/lib/ObserveLogShell.ps1',['-Root',directory,'-TargetPath',file(lb),'-Action','file','-LogId',lb.log_id]);
 }catch(error){
   if(!error.message.includes('Exact editor header image verification failed'))throw error;
   editorObservationError=error;
   const image=await readFile(path.join(directory,'log-shell-header.png'));
   await writeFile('artifacts/CR-022-editor-OCR-failure.png',image);
   console.error('Editor title observed; exact in-editor content and safe own-tab cleanup could not be confirmed.');
 }
 await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('编辑器未必自动刷新')`);
 assert.ok((await readFile(file(lb),'utf8')).includes(lb.log_id));
 await two.control({op:'push',text:'B-AFTER-OPEN\r\n'});await wait(async()=>(await readFile(file(lb),'utf8')).includes('B-AFTER-OPEN'),'actual opened file continues');
 const lostStop=await ui.interceptIpc({op:'stop',connectionId:b.connection_id,mode:'error'});await choose('second','停止记录');await ui.waitFor(`document.querySelector('[aria-label="终端右键日志操作"]').textContent.includes('查询结果')`);assert.equal(await lostStop.count(),1);await lostStop.restore();await ui.command('Page.reload');assert.equal((await slot()).target.connection.connection_id,b.connection_id);await ui.click('查询本次日志操作');await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('停止并同步')`);assert.equal((await list(b)).logs.length,1);assert.equal((await active(a)).log_id,la.log_id);await split(a,b);const lostStart=await ui.interceptIpc({op:'start',connectionId:b.connection_id,mode:'error'});await choose('second','开始记录');await ui.waitFor(`document.querySelector('[aria-label="终端右键日志操作"]').textContent.includes('查询结果')`);assert.equal(await lostStart.count(),1);await lostStart.restore();await ui.click('查询本次日志操作');await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('正在记录')`);lb=await active(b);assert.equal((await list(b)).logs.length,2);await two.control({op:'push',text:'B-SECOND-ROUND\r\n'});await wait(async()=>(await readFile(file(lb),'utf8')).includes('B-SECOND-ROUND'),'B second round');const rounds=await exportMenu('second','另存全部已记录日志…','B两轮.log');assert.equal(rounds.info.ranges.length,2);assert.ok(rounds.bytes.includes(Buffer.from('B-FIRST-ROUND')));assert.ok(rounds.bytes.includes(Buffer.from('B-SECOND-ROUND')));
 for(let i=1;i<=140;i++){const before=(await logging({op:'status',connection:ref(a),log_id:la.log_id})).written_records;await one.control({op:'push',text:`A-FULL-${String(i).padStart(3,'0')}-${'x'.repeat(800)}\r\n`});await wait(async()=>(await logging({op:'status',connection:ref(a),log_id:la.log_id})).written_records>before,'A full record');}
 const full=await exportMenu('first','另存全部已记录日志…','A全部.log');assert.ok(full.bytes.length>65536);assert.ok(full.bytes.includes(Buffer.from('A-FULL-001-')));assert.ok(full.bytes.includes(Buffer.from('A-FULL-140-')));assert.ok(full.info.retained_records>128);assert.equal((await active(a)).log_id,la.log_id);
 console.log('Freeze actual scrolled');
 // Freeze actual scrolled viewport before later output changes it.
 await one.control({op:'push',text:'\x1b[3J\x1b[2J\x1b[H'+Array.from({length:85},(_,i)=>i===2?'':`VISIBLE-${String(i).padStart(2,'0')}-\x1b[31m中文\x1b[0m`).join('\r\n')+'\r\n'});await focus('first');await ui.waitFor(`document.querySelector('[data-pane="first"] .xterm-rows').textContent.includes('VISIBLE-84')`);const scrollbar=await ui.evaluate(`(()=>{const p=document.querySelector('[data-pane="first"]'),s=p.querySelector('.xterm-scrollable-element .scrollbar.vertical .slider').getBoundingClientRect(),r=p.querySelector('.xterm-scrollable-element .scrollbar.vertical').getBoundingClientRect();return{x:s.x+s.width/2,from:s.y+s.height/2,to:r.y+1};})()`);await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:scrollbar.x,y:scrollbar.from});await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:scrollbar.x,y:scrollbar.to});await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:scrollbar.x,y:scrollbar.to});await ui.waitFor(`document.querySelector('[data-pane="first"] .xterm-rows').textContent.includes('VISIBLE-00')`);
 const dimensions=await ui.evaluate(`document.querySelector('[aria-label="终端视口尺寸"]').textContent.match(/(\\d+)×(\\d+)/).slice(1).map(Number)`);const [cols,rows]=dimensions;const expected=Buffer.from(Array.from({length:rows},(_,i)=>{const s=i===2?'':`VISIBLE-${String(i).padStart(2,'0')}-中文`;return s+' '.repeat(cols-(i===2?0:s.length+2));}).join('\r\n')+'\r\n');
 await right('first');await one.control({op:'push',text:'LATER-NOT-IN-FROZEN-VIEW\r\n'});await ui.click('只保存当前可见屏幕…');const screenTask=await slot(),screen=await prepared(screenTask);assert.deepEqual(screen.bytes,expected);await finishSave(screenTask,screen.bytes,path.join(output,'实际上滚屏幕.log'));assert.equal(screen.bytes.includes(Buffer.from('LATER-NOT')),false);
 // A stale menu callback cannot operate on another pane.
 await right('first');await ui.evaluate(`void(window.__staleLogButton=Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='只保存当前可见屏幕…'))`);const oldId=(await slot())?.request_id??null;await focus('second');await ui.waitFor(`!document.querySelector('[aria-label="终端日志菜单"]')`);await ui.evaluate(`window.__staleLogButton.click();delete window.__staleLogButton`);assert.equal((await slot())?.request_id??null,oldId);
 console.log('A lost prepare');
 // A newly opened menu cannot reuse the previous target's ready state.
 const menuLoad=await ui.interceptIpc({op:'list',connectionId:b.connection_id,mode:'hold'});await right('second');await wait(async()=>await menuLoad.count()>=1,'new menu list response held');assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='打开当前日志文件').disabled`),true);await menuLoad.restore();await ui.waitFor(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(b=>b.textContent==='打开当前日志文件'&&!b.disabled)`);await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.waitFor(`!document.querySelector('[aria-label="终端日志菜单"]')&&document.activeElement===document.querySelector('[data-pane="second"] .xterm-helper-textarea')`);
 // A lost prepare response only permits querying the original ID; no automatic picker.
 const lostPrepare=await ui.interceptIpc({command:'terminal_log_request',op:'prepare',mode:'error'});const recover=await choose('first','只保存当前可见屏幕…');await ui.waitFor(`document.querySelector('[aria-label="终端右键日志操作"]').textContent.includes('查询结果')`);assert.equal(await lostPrepare.count(),1);await lostPrepare.restore();const recovered=await prepared(recover);assert.equal(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify('terminal-menu-log-save-'+recover.request_id)})`),null);await ui.command('Page.reload');await ui.fill('会话',a.connection_id);await ready('first',a);await focus('first');await ui.click('查询本次日志操作');await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='保存已准备的日志'&&!b.disabled)`);assert.equal(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify('terminal-menu-log-save-'+recover.request_id)})`),null);await ui.click('保存已准备的日志');await finishSave(recover,recovered.bytes,path.join(output,'原编号恢复.log'));
 console.log('Native save response');
 // Native save response loss does not select a second destination or replay start.
 const lostSave=await ui.interceptIpc({command:'export_save_request',op:'start',mode:'error'});const saveLostTask=await choose('first','只保存当前可见屏幕…'),saveLost=await prepared(saveLostTask);await saveTask(saveLostTask);await ui.waitFor(`document.querySelector('[aria-label="右键日志导出另存状态"]')?.textContent.includes('保留原任务编号')`);await picker(path.join(output,'保存应答丢失.log'));assert.equal(await lostSave.count(),1);await lostSave.restore();await ui.click('查询保存结果');await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')&&document.querySelector('[aria-label="日志保存反馈"]')?.textContent.includes('日志已保存')`);assert.deepEqual(await readFile(path.join(output,'保存应答丢失.log')),saveLost.bytes);
 console.log('Existing destination');
 // Existing destination remains untouched until explicit native replacement consent.
 const old=Buffer.from('SYNTHETIC-ORIGINAL-DO-NOT-LOSE'),destination=path.join(output,'明确覆盖.log');await writeFile(destination,old);const replaceTask=await choose('first','只保存当前可见屏幕…'),replace=await prepared(replaceTask);await saveTask(replaceTask);await picker(destination);await ui.waitFor(`!!document.querySelector('[aria-label="右键日志确认替换保存文件"]')`);assert.deepEqual(await readFile(destination),old);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="右键日志确认替换保存文件"]').checked`),false);await ui.evaluate(`document.querySelector('[aria-label="右键日志确认替换保存文件"]').click()`);await ui.click('确认替换并保存');const replaceScope=await saveTask(replaceTask);let replaced;await wait(async()=>{replaced=await save({op:'status',scope:replaceScope.scope,save_id:replaceScope.save_id});return replaced.phase==='COMPLETED';},'explicit overwrite');assert.deepEqual(await readFile(destination),replace.bytes);assert.deepEqual(await readFile(replaced.backup),old);await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')&&document.querySelector('[aria-label="日志保存反馈"]')?.textContent.includes('日志已保存')`);
 const cancelTask=await choose('first','只保存当前可见屏幕…');await prepared(cancelTask);const cancelled=await saveTask(cancelTask);await picker(undefined,'cancel');await wait(async()=>(await save({op:'status',scope:cancelled.scope,save_id:cancelled.save_id})).phase==='CANCELLED','picker cancelled');await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')&&document.querySelector('[aria-label="日志保存反馈"]')?.textContent.includes('保存已取消')`);assert.deepEqual(await readFile(destination),replace.bytes);
 // Cancellation while awaiting replacement keeps the destination and ends only this UI.
 const kept=await readFile(destination),cancelReplaceTask=await choose('first','只保存当前可见屏幕…');await prepared(cancelReplaceTask);const cancelReplaceScope=await saveTask(cancelReplaceTask);await picker(destination);await ui.waitFor(`!!document.querySelector('[aria-label="右键日志确认替换保存文件"]')`);await delay(5200);assert.ok(await ui.evaluate(`!!document.querySelector('[aria-label="右键日志确认替换保存文件"]')`),'overwrite confirmation stays open beyond the recording notice timeout');await ui.click('取消保存');await wait(async()=>(await save({op:'status',scope:cancelReplaceScope.scope,save_id:cancelReplaceScope.save_id})).phase==='CANCELLED','replacement cancellation');await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);assert.deepEqual(await readFile(destination),kept);
 // A real failed fingerprint check stays visible; it cannot masquerade as completion.
 const failedTask=await choose('first','只保存当前可见屏幕…');await prepared(failedTask);const failedScope=await saveTask(failedTask);await picker(destination);await ui.waitFor(`!!document.querySelector('[aria-label="右键日志确认替换保存文件"]')`);const badSource=path.join(directory,'terminal-menu/terminal-log-exports',failedTask.request_id,'export.jsonl'),badBytes=await readFile(badSource);badBytes[0]=badBytes[0]===88?89:88;await writeFile(badSource,badBytes);await ui.evaluate(`document.querySelector('[aria-label="右键日志确认替换保存文件"]').click()`);await ui.click('确认替换并保存');await wait(async()=>(await save({op:'status',scope:failedScope.scope,save_id:failedScope.save_id})).phase==='FAILED','source integrity rejection');await ui.waitFor(`document.querySelector('[aria-label="右键日志导出另存状态"][role="alert"]')?.textContent.includes('另存失败')`);assert.ok(await ui.evaluate(`!!document.querySelector('[aria-label="终端右键日志操作"]')`));assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="日志保存反馈"]')`),false);assert.deepEqual(await readFile(destination),kept);await ui.click('收起日志操作');
 // Status loss keeps the original task visible until the user queries it once.
 const statusTask=await choose('first','只保存当前可见屏幕…'),statusSource=await prepared(statusTask),statusScope=await saveTask(statusTask),statusFile=path.join(output,'状态应答丢失.log');const lostStatus=await ui.interceptIpc({command:'export_save_request',op:'status',mode:'error'});await picker(statusFile);await ui.waitFor(`document.querySelector('[aria-label="右键日志导出另存状态"]')?.textContent.includes('保留原任务编号')`);assert.equal(await lostStatus.count(),1);await lostStatus.restore();await wait(async()=>{try{return (await readFile(statusFile)).equals(statusSource.bytes);}catch{return false;}},'publication independent from lost status');assert.ok(await ui.evaluate(`!!document.querySelector('[aria-label="终端右键日志操作"]')`));await ui.click('查询保存结果');await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);assert.equal((await saveTask(statusTask)).save_id,statusScope.save_id);
 // A late status after publication never reopens old UI or steals the other pane's focus.
 await split(a,b);const lateTask=await choose('first','只保存当前可见屏幕…'),lateSource=await prepared(lateTask),lateScope=await saveTask(lateTask),lateFile=path.join(output,'切换后原目标保存.log');const lateStatus=await ui.interceptIpc({command:'export_save_request',op:'status',mode:'hold'});await picker(lateFile);await wait(async()=>await lateStatus.count()===1,'held real save status');await wait(async()=>{try{return (await readFile(lateFile)).equals(lateSource.bytes);}catch{return false;}},'old source published');await focus('second');await lateStatus.restore();await delay(200);assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="终端右键日志操作"]')`),false);assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="日志保存反馈"]')`),false);assert.equal(await ui.evaluate(`document.activeElement===document.querySelector('[data-pane="second"] .xterm-helper-textarea')`),true);await right('second');await ui.click('查询上次日志操作结果');await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='查询保存结果')`);await ui.click('查询保存结果');await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);assert.equal((await save({op:'status',scope:lateScope.scope,save_id:lateScope.save_id})).phase,'COMPLETED');assert.deepEqual(await readFile(lateFile),lateSource.bytes);
 console.log('A real admitted');
 // A real admitted prepare with held reply cannot auto-save after focus changes.
 const held=await ui.interceptIpc({command:'terminal_log_request',op:'prepare',mode:'hold'});const stale=await choose('first','只保存当前可见屏幕…');await wait(async()=>await held.count()===1,'held prepare');await focus('second');await held.restore();await delay(350);assert.equal(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify('terminal-menu-log-save-'+stale.request_id)})`),null);assert.equal((await active(b)).log_id,lb.log_id);assert.equal((await active(uart)).log_id,lu.log_id);assert.equal((await active(a)).log_id,la.log_id);await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);
 await stop('second',b);await focus('first');await stop('first',a);
 await ui.waitFor(`(${badge(uart)})?.title==='● 记录中'&&! (${badge(a)})&&! (${badge(b)})`);
 console.log('New generation and exact target closure');
 const generationReply=await ui.interceptIpc({command:'terminal_log_request',op:'prepare',mode:'hold'});const oldGenerationTask=await choose('first','只保存当前可见屏幕…');await wait(async()=>await generationReply.count()===1,'held old generation prepare');await ssh({op:'close',connection:ref(a)});await wait(async()=>['DISCONNECTED','FAILED'].includes((await ssh({op:'status',connection:ref(a)})).connection.state),'old A ended');const renewed=(await ssh({op:'reconnect',connection:ref(a),request_id:requestId(),cols:80,rows:24})).connection;assert.ok(renewed.generation>a.generation);await generationReply.restore();await delay(250);assert.equal(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify('terminal-menu-log-save-'+oldGenerationTask.request_id)})`),null);
 const answered=new Set();await wait(async()=>{const s=await ssh({op:'status',connection:ref(renewed)});if(s.challenge&&!answered.has(s.challenge.id)){answered.add(s.challenge.id);if(s.challenge.kind==='host_key'){assert.equal(s.challenge.review.candidate.fingerprint,one.pin);await ssh({op:'answer_host',connection:ref(renewed),challenge_id:s.challenge.id,approve:true});}else if(s.challenge.kind==='credentials')await ssh({op:'authenticate',connection:ref(renewed),challenge_id:s.challenge.id,use_saved:true,password:null});}return s.connection.state==='CONNECTED';},'normal new generation authentication');await ui.fill('会话',renewed.connection_id);await ready('first',renewed);assert.equal((await list(renewed)).logs.length,0);await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);
 const closeReply=await ui.interceptIpc({command:'terminal_log_request',op:'prepare',mode:'hold'});const closedTask=await choose('first','保存终端缓冲内容…');await wait(async()=>await closeReply.count()===1,'held preparation before exact tab close');await ui.evaluate(`document.querySelector('[aria-label="关闭标签 ${renewed.connection_id}"]').click()`);await closeReply.restore();await delay(250);assert.equal(await ui.evaluate(`sessionStorage.getItem(${JSON.stringify('terminal-menu-log-save-'+closedTask.request_id)})`),null);assert.equal((await ui.invoke('service_list')).find(c=>c.connection_id===b.connection_id).state,'CONNECTED');assert.equal((await active(uart)).log_id,lu.log_id);await ui.waitFor(`!document.querySelector('[aria-label="终端右键日志操作"]')`);
 await ui.fill('会话',uart.connection_id);
 const lastPane=await ui.evaluate(`document.querySelector('[data-pane][data-active="true"]').dataset.pane`);
 await ready(lastPane,uart);
 await right(lastPane);
 await ui.waitFor(`[...document.querySelectorAll('.terminal-context-menu button')].some(b=>b.textContent==='停止记录'&&!b.disabled)`);
 const stopOpened=await clickMenuAt('停止记录');
 await wait(async()=>(await logging({op:'status',connection:ref(uart),log_id:lu.log_id})).durable,'UART stop has synced');
 await ui.waitFor(`document.querySelector('[aria-label="右键日志操作状态"]')?.textContent.includes('停止并同步')`);
 const stopDismissal=await dismissalTime(stopOpened);
 await ui.waitFor(`!(${badge(uart)})`);
 console.log(`PASS recording stop notice auto-dismissed in ${stopDismissal} ms after durable stop`);
 await writeFile('artifacts/CR-022-log-menu-result.json',JSON.stringify({result:editorObservationError?'PARTIAL':'PASS',recordingNoticeMs:{firstDismissal,secondDismissal,stopDismissal},editor:editorObservationError?'title observed; in-editor header OCR and own-tab close unverified':'exact header observed; own tab closed',owner,identities:{a,b,uart},files:await readdir(path.join(directory,'logs')),fullBytes:full.bytes.length,fullRecords:full.info.retained_records,viewport:{cols,rows,bytes:screen.bytes.length,sha256:screen.info.sha256},hardware:'synthetic SSH, passive memory UART only; no COM'},null,2));
 if(editorObservationError)throw new Error('Native editor header observation failed. Remaining log-menu checks passed; see CR-022-log-menu-result.json.');
 console.log('PASS actual right-click six log actions: exact inactive pane, no legacy automatic paste, live common files, native Explorer/Notepad, complete all-round exports beyond preview, scrolled viewport exact bytes, original-ID recovery/no replay, native picker/cancel/overwrite/backup/SHA, late focus isolation; no COM');
}catch(error){if(ui){await ui.screenshot('P11.4-log-menu-failure.png').catch(()=>{});await writeFile('artifacts/P11.4-log-menu-failure.txt',await ui.evaluate('document.body.innerText').catch(String));}throw error;}
finally{try{await ui?.close();for(const c of fixtures){c.kill();if(c.exitCode===null&&c.signalCode===null)await new Promise(resolve=>c.once('exit',resolve));}for(const [d,prefix]of[[directory,'shared-terminal-log-menu-ui-中文-'],[output,'shared-terminal-save-ui-中文-']])if(d){const resolved=path.resolve(d);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith(prefix));await rm(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});}}finally{build(false);}}
