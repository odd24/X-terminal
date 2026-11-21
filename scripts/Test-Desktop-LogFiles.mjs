import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requestId} from '../apps/desktop/src/request-id.ts';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
import {checkLogSharing} from './lib/RecordingNoticeChecks.mjs';
const releaseDesktop=process.argv[2]&&path.resolve(process.argv[2]);
const build=fixture=>{const r=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'fixture and ordinary restoration must actually succeed');};
const wait=async(check,label)=>{for(let i=0;i<300;i++){if(await check())return;await delay(20);}throw new Error(`Timeout: ${label}`);};
const ref=c=>({connection_id:c.connection_id,generation:c.generation});
let directory,output,ui;const fixtures=[];
try{
 if(!releaseDesktop)build(true);
 directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-log-files-ui-中文-'));output=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));
 async function server(name){const d=path.join(directory,name);await mkdir(d);const child=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[d],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixtures.push(child);const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();const next=async()=>{let t;try{return await Promise.race([lines.next().then(v=>JSON.parse(v.value)),new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]);}finally{clearTimeout(t);}};const data=await next();return {...data,control:async value=>{child.stdin.write(JSON.stringify(value)+'\n');return next();}};}
 const one=await server('one'),two=await server('two');ui=await launchDesktop(directory,{fixture:true,executable:releaseDesktop});
 const ssh=request=>ui.invoke('ssh_request',{request}),raw=async c=>Buffer.from((await ui.invoke('service_read',{connection:ref(c),cursor:1})).events.flatMap(e=>e.bytes));
 async function connect(server,profileId){const profile={id:profileId??crypto.randomUUID(),folder_id:null,name:'split server',settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
  if(!profileId)await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
  const r=await ssh({op:'start',profile_id:profile.id,request_id:requestId(),cols:80,rows:24});const target=ref(r.connection),answered=new Set();
  await wait(async()=>{const s=await ssh({op:'status',connection:target});if(s.connection.state==='FAILED')throw new Error('synthetic SSH failed');if(s.challenge&&!answered.has(s.challenge.id)){answered.add(s.challenge.id);if(s.challenge.kind==='host_key'){assert.equal(s.challenge.review.candidate.fingerprint,server.pin);await ssh({op:'answer_host',connection:target,challenge_id:s.challenge.id,approve:true});}else if(s.challenge.kind==='credentials')await ssh({op:'authenticate',connection:target,challenge_id:s.challenge.id,use_saved:true,password:null});}return s.connection.state==='CONNECTED';},'SSH login');return {...target,protocol:'SSH2',state:'CONNECTED',profileId:profile.id};}

 const a=await connect(one),b=await connect(two);
 await ui.click('串口连接');await ui.waitFor(`document.querySelector('[aria-label="UART端口"]')?.options.length===2`);await ui.fill('UART端口',await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').options[1].value`));await ui.fill('UART波特率',57600);await ui.click('连接串口');await ui.waitFor(`!document.querySelector('dialog:modal')`);const uart=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL');assert.ok(uart);
 const logging=request=>ui.invoke('logging_request',{request}),native=request=>ui.invoke('terminal_log_request',{request}),save=request=>ui.invoke('export_save_request',{request});
 const owner=(await ui.invoke('service_status')).service_id,target=c=>({service_id:owner,protocol:c.protocol,connection:ref(c)});
 const limits={segment_bytes:131072,segments:2};
 async function start(c){const id=requestId(),l=await logging({op:'start',connection:ref(c),request_id:id,limits});await wait(async()=>!!(await logging({op:'status',connection:ref(c),log_id:l.log_id})).readable,'readable created');const result=await logging({op:'start_status',connection:ref(c),request_id:id});assert.equal(result.log_id,l.log_id);return result;}
 const [la,lb,lu]=await Promise.all([start(a),start(b),start(uart)]);
 const file=l=>path.join(directory,'logs',l.readable.filename),names=await readdir(path.join(directory,'logs'),{withFileTypes:true});assert.equal(names.length,3);assert.ok(names.every(e=>e.isFile()));
 const date=l=>new Date(l.started_at_ms+8*3600000).toISOString().slice(0,19).replace('T','_').replaceAll(':','_');
 assert.ok(la.readable.filename.startsWith(`127.0.0.1_${date(la)}`));assert.ok(lb.readable.filename.startsWith(`127.0.0.1_${date(lb)}`));assert.ok(lu.readable.filename.startsWith(`COM7_${date(lu)}`));assert.notEqual(la.readable.filename,lb.readable.filename);
 const beforeB=await readFile(file(lb));const began=Date.now();await one.control({op:'push',text:'A-LIVE-GROWTH\r\n'});await wait(async()=>(await readFile(file(la),'utf8')).includes('A-LIVE-GROWTH'),'file grows without stopping');const flushObservedMs=Date.now()-began;assert.deepEqual(await readFile(file(lb)),beforeB);
 await two.control({op:'push',text:'B-LIVE-GROWTH\r\n'});await wait(async()=>(await readFile(file(lb),'utf8')).includes('B-LIVE-GROWTH'),'second SSH readable grows');await wait(async()=>(await readFile(file(lu),'utf8')).includes('Android启动 log'),'UART passive readable grows');
 for(let i=1;i<=160;i++){const before=(await logging({op:'status',connection:ref(a),log_id:la.log_id})).written_records;await one.control({op:'push',text:`FULL-${String(i).padStart(3,'0')}-${'x'.repeat(1000)}\r\n`});await wait(async()=>(await logging({op:'status',connection:ref(a),log_id:la.log_id})).written_records>before,'each synthetic read reaches writer');}
 await wait(async()=>{const l=await logging({op:'status',connection:ref(a),log_id:la.log_id});return l.readable.synced_records>=l.accepted_records;},'periodic sync while recording');
 const live=await logging({op:'status',connection:ref(a),log_id:la.log_id});assert.equal(live.phase,'RECORDING');assert.ok(live.written_records>128);assert.ok(live.readable.flushed_bytes>65536);assert.ok(live.retired_segments>0);assert.equal(live.source_gap_bytes,0);
 const fullId=requestId(),fullRequest={op:'prepare',target:target(a),request_id:fullId,source:{kind:'recorded',log_ids:[la.log_id]}};
 let full=await native(fullRequest);await wait(async()=>{full=await native({op:'status',target:target(a),request_id:fullId});return !['QUEUED','RUNNING'].includes(full.phase);},'full live export');assert.equal(full.phase,'COMPLETED');assert.equal(full.ranges.length,1);assert.equal(full.ranges[0].active,true);
 const staged=path.join(directory,'terminal-menu','terminal-log-exports',fullId,'export.jsonl');const frozen=await readFile(staged);assert.ok(frozen.includes(Buffer.from('FULL-001-')));assert.ok(frozen.includes(Buffer.from('FULL-160-')));assert.ok(frozen.length>65536);assert.equal(createHash('sha256').update(frozen).digest('hex'),full.sha256);
 await one.control({op:'push',text:'AFTER-FROZEN-EXPORT\r\n'});await wait(async()=>(await readFile(file(la),'utf8')).includes('AFTER-FROZEN-EXPORT'),'recording continues after export');assert.deepEqual(await readFile(staged),frozen);
 assert.equal((await native(fullRequest)).sha256,full.sha256);await assert.rejects(native({...fullRequest,source:{kind:'recorded',log_ids:[lb.log_id]}}));await assert.rejects(native({...fullRequest,target:{...target(a),connection:{...ref(a),generation:a.generation+1}}}));
 await assert.rejects(native({op:'prepare',target:target(a),request_id:requestId(),source:{kind:'recorded',log_ids:[lb.log_id]}}));await assert.rejects(native({op:'open_file',target:target(a),request_id:requestId(),log_id:la.log_id,path:'C:\\untrusted.log'}));
 // Native save uses the same protected selection/backup machinery and trusted fingerprint.
 const saveScope={mode:'MENU',connection:ref(a),log_id:fullId,request_id:fullId},saveId=requestId();await save({op:'start',scope:saveScope,save_id:saveId});
 const destination=path.join(output,'全部已记录.log');await new Promise((resolve,reject)=>{const c=spawn('pwsh',['-NoProfile','-File','scripts/lib/NativeSaveDialog.ps1','-TargetProcessId',String(ui.app.pid),'-Action','select','-TargetPath',destination],{windowsHide:true});let text='';c.stdout.on('data',d=>text+=d);c.stderr.on('data',d=>text+=d);c.on('exit',code=>code===0?resolve():reject(Error(text)));c.on('error',reject);});
 let saved;await wait(async()=>{saved=await save({op:'status',scope:saveScope,save_id:saveId});return saved.phase==='COMPLETED';},'native MENU save');assert.deepEqual(await readFile(destination),frozen);await wait(async()=>(await native({op:'status',target:target(a),request_id:fullId})).phase==='REMOVED','only own staged copy retired');assert.deepEqual(await readFile(destination),frozen);
 await logging({op:'stop',connection:ref(a),log_id:la.log_id});await wait(async()=>(await logging({op:'status',connection:ref(a),log_id:la.log_id})).durable,'first round durable');const la2=await start(a);assert.notEqual(la2.readable.filename,la.readable.filename);assert.equal((await readdir(path.join(directory,'logs'),{withFileTypes:true})).length,4);
 await one.control({op:'push',text:'SECOND-RECORDING-ROUND\r\n'});await wait(async()=>(await readFile(file(la2),'utf8')).includes('SECOND-RECORDING-ROUND'),'second recording grows same root');assert.equal((await logging({op:'status',connection:ref(b),log_id:lb.log_id})).active,true);assert.equal((await logging({op:'status',connection:ref(uart),log_id:lu.log_id})).active,true);
 const display='中文  \r\n      \r\n尾行  \r\n',displayId=requestId();let displayTask=await native({op:'prepare',target:target(uart),request_id:displayId,source:{kind:'viewport',text:display,top:17,rows:3,cols:6}});await wait(async()=>{displayTask=await native({op:'status',target:target(uart),request_id:displayId});return displayTask.phase==='COMPLETED';},'display artifact');assert.deepEqual(await readFile(path.join(directory,'terminal-menu/terminal-log-exports',displayId,'export.jsonl')),Buffer.from(display));await native({op:'cancel',target:target(uart),request_id:displayId});await wait(async()=>(await native({op:'status',target:target(uart),request_id:displayId})).phase==='REMOVED','cancel unused prepared display');
 const stop=async(c,l)=>{
  await logging({op:'stop',connection:ref(c),log_id:l.log_id});
  await wait(async()=>{
   const stopped=await logging({op:'status',connection:ref(c),log_id:l.log_id});
   return stopped.phase==='STOPPED'&&stopped.durable&&stopped.worker_finished;
  },'durable stop');
 };
 const activeUart=checkLogSharing(directory,lu.readable.filename,{remove:true});
 assert.ok([5,32].includes(activeUart.rename)&&[5,32].includes(activeUart.delete));
 await stop(uart,lu);
 const finalUart=checkLogSharing(directory,lu.readable.filename,{remove:true,findHolders:true});
 assert.deepEqual(finalUart,{rename:0,delete:0,holders:[]});
 await assert.rejects(readFile(file(lu)),{code:'ENOENT'});
 for(const [c,l,server,marker] of [[a,la2,one,'SSH-A-AFTER-UART-STOP'],[b,lb,two,'SSH-B-AFTER-UART-STOP']]){
  const active=await logging({op:'status',connection:ref(c),log_id:l.log_id});
  assert.equal(active.phase,'RECORDING');assert.equal(active.active,true);
  await server.control({op:'push',text:marker+'\r\n'});
  await wait(async()=>(await readFile(file(l),'utf8')).includes(marker),'unrelated recording still grows');
 }
 const sshRelease=[];
 for(const [c,l] of [[a,la2],[b,lb]]){
  await stop(c,l);
  const sharing=checkLogSharing(directory,l.readable.filename,{remove:true});
  assert.deepEqual(sharing,{rename:0,delete:0,holders:[]});
  sshRelease.push(sharing);
 }
 assert.deepEqual(checkLogSharing(directory,la.readable.filename,{remove:true}),{rename:0,delete:0,holders:[]});
 assert.equal((await ui.invoke('service_status')).service_id,owner);
 await writeFile(releaseDesktop?'artifacts/windows-0.1.8-stop-release-mixed.json':'artifacts/P11.4-log-files-result.json',JSON.stringify({result:'PASS',owner,flushObservedMs,files:(await readdir(path.join(directory,'logs'))).sort(),fullBytes:frozen.length,fullRecords:full.retained_records,sha256:full.sha256,retiredPrivateSegments:live.retired_segments,activeUart,finalUart,sshRelease,hardware:'synthetic SSH, passive memory UART only; no COM'},null,2));
 console.log('PASS stopped UART and SSH logs are renameable and deletable while the app remains running; unrelated recordings continue');
 console.log('PASS native shared live log root: two SSH+passive UART and multiple rounds, start-second filenames, disk growth before stop, flush/sync watermarks, full frozen live ranges beyond preview/rotation, exact display bytes, trusted MENU save SHA, scope/dedup/cleanup; no COM');
}catch(error){if(ui){await ui.screenshot('P11.4-log-files-failure.png').catch(()=>{});await writeFile('artifacts/P11.4-log-files-failure.txt',await ui.evaluate('document.body.innerText').catch(String));}throw error;}
finally{try{await ui?.close();for(const c of fixtures){c.kill();if(c.exitCode===null&&c.signalCode===null)await new Promise(resolve=>c.once('exit',resolve));}for(const [d,prefix]of[[directory,'shared-terminal-log-files-ui-中文-'],[output,'shared-terminal-save-ui-中文-']])if(d){const resolved=path.resolve(d);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith(prefix));await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}finally{if(!releaseDesktop)build(false);}}
