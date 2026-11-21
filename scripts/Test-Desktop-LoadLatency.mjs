import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
import {requestId} from '../apps/desktop/src/request-id.ts';

assert.ok(process.argv.slice(2).every(x=>x==='--calibrate'));
const calibration=process.argv.includes('--calibrate'),seconds=calibration?8:120;
const artifact=`artifacts/P22-load-latency-${calibration?'calibration':'formal'}-${randomUUID()}.json`;
const build=args=>{const r=spawnSync('cargo',args,{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'actual example build/ordinary restoration');};
const binaries=['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe'];
const hashes=async()=>Object.fromEntries(await Promise.all(binaries.map(async n=>[n,createHash('sha256').update(await readFile(path.resolve('target/debug',n))).digest('hex')])));
const before=await hashes(),source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
build(['build','-p','session-service','--example','gui_load_fixture','--example','gui_ssh_fixture','--locked']);
const reference=c=>({connection_id:c.connection_id,generation:c.generation});
const until=async(check,label,timeoutMs=10000)=>{const stop=performance.now()+timeoutMs;while(performance.now()<stop){if(await check())return;await delay(5);}throw Error(`timeout: ${label}`);};
const at=async time=>{while(performance.now()<time)await delay(Math.min(25,time-performance.now()));};
const expectedBlock=(stream,seq)=>{const b=Buffer.alloc(1024,97+(stream+seq)%26);b.write(`T18|${String(stream).padStart(2,'0')}|${String(seq).padStart(8,'0')}|`);b[1023]=10;return b;};
const quantile=values=>{assert.ok(values.length);const a=[...values].sort((a,b)=>a-b);return {count:a.length,p50:a[Math.ceil(.5*a.length)-1],p95:a[Math.ceil(.95*a.length)-1],max:a.at(-1),algorithm:'nearest-rank ceil(p*N), no sample exclusions'};};
let ui,fixture,directory,control,stderr='',aborted=false,observerBusy=false,inputBusy=false;
let measurementTasks=[],currentRead;
const connections=[],samples=[],remoteEvents=[],done=new Map(),observerBatches=[],resources=[],audit=[];
const streams=Array.from({length:20},()=>({cursor:1,frames:0,bytes:0,insideBytes:0,lateBytes:0,pending:Buffer.alloc(0),hash:createHash('sha256'),maxAvailableFrom:1,sourceGapBytes:0,truncated:false,buckets:Array(seconds).fill(0)}));
const report={source,calibration,seconds,plannedSamples:seconds,startedAt:new Date().toISOString(),thresholdMs:100,before,
  readAttempts:[],cleanupTimeline:[],
  endpoints:{local:'trusted DOM keydown -> original ssh_request/write_text fetch start, same WebView performance clock',hostUpperBound:'Host monotonic before CDP keyDown -> actual remote input notification arrival at Host; includes CDP/watcher/stdout overhead'},
  limitations:['No communication log captures or Agent grants; internal RPC audit remains enabled.','Not an 8 hour run, IME/DPI/full keyboard or complete T18/P22 acceptance.','Resource samples cover primary owned Desktop/service/fixture processes, Node and renderer JS heap; not all native WebView/GPU subprocess memory.']};
try {
  directory=await mkdtemp(path.join(os.tmpdir(),'shared-terminal-load-latency-ui-中文-'));
  fixture=spawn(path.resolve('target/debug/examples/gui_load_fixture.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  fixture.stderr.on('data',b=>stderr=(stderr+b).slice(-8192));
  const pending=new Map();let sequence=0,ready;let protocolFailure;
  const lines=createInterface({input:fixture.stdout});
  lines.on('line',line=>{try{
    const value=JSON.parse(line),arrival=performance.now();
    if(value.event==='ready')ready=value;
    else if(value.event==='input')remoteEvents.push({...value,hostArrival:arrival});
    else if(value.event==='source_done')done.set(value.stream,value);
    else if(value.id!==undefined){const p=pending.get(value.id);if(p){clearTimeout(p.timer);pending.delete(value.id);p.resolve(value);}}
  }catch{protocolFailure=Error('malformed synthetic fixture response');}});
  control=value=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('synthetic control timeout'));},10000);pending.set(id,{resolve,reject,timer});fixture.stdin.write(JSON.stringify({...value,id})+'\n');});
  await until(()=>{if(protocolFailure)throw protocolFailure;return !!ready;},'twenty endpoints ready');assert.equal(ready.servers.length,20);
  ui=await launchDesktop(directory);const service=await ui.invoke('service_status');assert.equal(service.fixture,false);
  report.servicePid=service.pid;report.testRoot=directory;
  const ssh=request=>ui.invoke('ssh_request',{request});
  for(let i=0;i<20;i++){
    const server=ready.servers[i],profile={id:randomUUID(),folder_id:null,name:`T18合成${i}`,settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}};
    await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}}});
    const c=(await ssh({op:'start',profile_id:profile.id,request_id:requestId(),cols:80,rows:24})).connection,ref=reference(c),answered=new Set();
    await until(async()=>{const s=await ssh({op:'status',connection:ref});assert.notEqual(s.connection.state,'FAILED');if(s.challenge&&!answered.has(s.challenge.id)){answered.add(s.challenge.id);if(s.challenge.kind==='host_key'){assert.equal(s.challenge.review.candidate.fingerprint,server.pin);await ssh({op:'answer_host',connection:ref,challenge_id:s.challenge.id,approve:true});}else await ssh({op:'authenticate',connection:ref,challenge_id:s.challenge.id,use_saved:true,password:null});}return s.connection.state==='CONNECTED';},`SSH ${i} ready`);
    connections.push(ref);
  }
  assert.equal((await ui.invoke('service_list')).filter(c=>c.state==='CONNECTED').length,20);
  assert.deepEqual((await ui.invoke('logging_request',{request:{op:'capture_list'}})).logs,[]);
  assert.deepEqual((await ui.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
  await ui.selectTab(connections[0].connection_id);await ui.waitFor(`document.querySelector('[data-pane="first"]')?.dataset.renderedId===${JSON.stringify(connections[0].connection_id)}`);
  await ui.evaluate(`document.querySelector('[data-pane="first"] .xterm-helper-textarea').focus()`);await ui.command('Performance.enable');await delay(250);
  for(let i=0;i<20;i++){const p=await ui.invoke('service_read',{connection:connections[i],cursor:1});assert.equal(p.truncated,false);streams[i].cursor=p.next_cursor;}
  assert.ok((await control({op:'metrics'})).received.every(b=>b.length===0));
  await ui.evaluate(`(()=>{const original=window.fetch,s={keys:[],writes:[]};window.__t18=s;
    document.addEventListener('keydown',e=>{if(e.target.classList.contains('xterm-helper-textarea')){const pane=e.target.closest('[data-pane]');s.keys.push({t:performance.now(),key:e.key,trusted:e.isTrusted,isComposing:e.isComposing,connection:pane?.dataset.renderedId,generation:Number(pane?.dataset.renderedGeneration)});}},true);
    window.fetch=async function(input,init){let r;try{r=JSON.parse(init?.body)?.request;}catch{}let row;if(new URL(String(input)).pathname==='/ssh_request'&&r?.op==='write_text'){row={t:performance.now(),request_id:r.request_id,text:r.text,connection:r.connection};s.writes.push(row);}const response=await original.call(this,input,init);if(row)row.end=performance.now();return response;};})()`);
  const started=await control({op:'start',seconds});const t0=performance.now()+Number(started.start_unix_ms)-Date.now();report.sourceStartUnixMs=Number(started.start_unix_ms);
  async function readStream(index){
    const began=performance.now(),state=streams[index];assert.ok(report.readAttempts.length<4096,'bounded observer attempt log');
    currentRead={stream:index,connection:connections[index],startedHost:began,cursor:state.cursor,phase:'invoke'};report.readAttempts.push(currentRead);const attempt=currentRead;
    const page=await ui.invoke('service_read',{connection:connections[index],cursor:state.cursor}),received=performance.now();currentRead.phase='validate';
    assert.deepEqual(page.connection,connections[index]);state.truncated||=page.truncated;assert.equal(page.truncated,false,`raw retention overtook observer ${index}`);assert.equal(page.disconnected,false);
    state.maxAvailableFrom=Math.max(state.maxAvailableFrom,page.available_from);
    for(const event of page.events){state.sourceGapBytes+=event.gap_bytes??0;assert.ok(!event.gap_bytes,`source gap ${index}`);state.pending=Buffer.concat([state.pending,Buffer.from(event.bytes)]);
      while(state.pending.length>=1024){const b=state.pending.subarray(0,1024);assert.deepEqual(b,expectedBlock(index,state.frames),`frame/sequence corruption source ${index}`);state.hash.update(b);state.frames++;state.bytes+=1024;
        const bucket=Math.floor((event.timestamp_ms-report.sourceStartUnixMs)/1000);if(bucket>=0&&bucket<seconds){state.insideBytes+=1024;state.buckets[bucket]+=1024;}else state.lateBytes+=1024;
        state.pending=state.pending.subarray(1024);
      }
    }
    state.cursor=page.next_cursor;
    attempt.finishedHost=performance.now();attempt.phase='completed';attempt.rawBytes=page.events.reduce((n,e)=>n+e.bytes.length,0);attempt.events=page.events.length;
    currentRead=undefined;
    return {stream:index,rpcMs:received-began,validateMs:performance.now()-received,events:page.events.length,bytes:page.events.reduce((n,e)=>n+e.bytes.length,0)};
  }
  const keyTask=(async()=>{for(let n=0;n<seconds;n++){
    const due=t0+250+n*1000;await at(due);if(aborted)return;assert.equal(observerBusy,false,'observer deadline overlaps a fixed keyboard event');
    const ch=String.fromCharCode(97+n%26),sample={id:randomUUID(),ordinal:n,key:ch,plannedHost:due,injectBefore:performance.now()};samples.push(sample);assert.ok(sample.injectBefore-due<=50,'Host injector missed fixed schedule');
    inputBusy=true;try{
      await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:ch,code:`Key${ch.toUpperCase()}`,text:ch,unmodifiedText:ch,windowsVirtualKeyCode:65+n%26});
      await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:ch,code:`Key${ch.toUpperCase()}`,windowsVirtualKeyCode:65+n%26});
      await until(()=>remoteEvents.filter(e=>e.stream===0).reduce((n,e)=>n+e.bytes.length,0)>n,'remote exact input receipt',Math.max(1,t0+650+n*1000-performance.now()));
      const bytes=remoteEvents.filter(e=>e.stream===0).flatMap(e=>e.bytes.map(byte=>({byte,arrival:e.hostArrival})));assert.equal(bytes[n].byte,ch.charCodeAt(0));sample.remoteNotification=bytes[n].arrival;sample.hostUpperBoundMs=sample.remoteNotification-sample.injectBefore;
    }finally{inputBusy=false;}
  }})();
  const observerTask=(async()=>{for(let k=0;k<seconds;k++){
    await at(t0+450+k*1000);if(aborted)return;assert.equal(inputBusy,false,'slow input still in flight at fixed observer slot');observerBusy=true;const began=performance.now(),reads=[];
    try{
      for(let i=(k%2)*10;i<(k%2)*10+10;i++){if(aborted)return;reads.push(await readStream(i));}
      if(k%10===0){const r=await control({op:'resources',pids:[ui.app.pid,service.pid]});const metrics=await ui.command('Performance.getMetrics');const heap=metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value;
        assert.ok(r.samples.every(p=>p.private<=1024**3&&p.working<=1024**3));assert.ok(process.memoryUsage().rss<=512*1024**2);assert.ok(heap<=512*1024**2);
        resources.push({hostAt:performance.now(),processes:r.samples,node:process.memoryUsage(),rendererJsHeap:heap,rendererTaskDuration:metrics.metrics.find(m=>m.name==='TaskDuration')?.value});
        const a=await ui.invoke('audit_history_request',{request:{op:'info'}});audit.push(a);assert.equal(a.status.state,'HEALTHY','normal internal audit must remain healthy');
      }
    }finally{observerBusy=false;observerBatches.push({k,start:began,end:performance.now(),deadline:t0+1150+k*1000,reads,aborted,expectedReads:10});}
    assert.ok(performance.now()<=t0+1150+k*1000,'ten-source observer missed fixed deadline; no key rescheduling');
    if(k%10===0)console.log(`T18 measured progress ${Math.round((performance.now()-t0)/1000)}s; inputs=${samples.length}, received frames per source min=${Math.min(...streams.map(s=>s.frames))}`);
  }})();
  measurementTasks=[keyTask.catch(e=>{aborted=true;throw e;}),observerTask.catch(e=>{aborted=true;throw e;})];
  await Promise.all(measurementTasks);
  await at(t0+seconds*1000);await until(()=>done.size===20,'twenty source completion');
  for(let i=0;i<20;i++)await until(async()=>{await readStream(i);return streams[i].frames===seconds*21;},`source ${i} drain`);
  const trace=await ui.evaluate(`({keys:window.__t18.keys,writes:window.__t18.writes,inputFailure:document.querySelector('.input-status')?.textContent})`);
  assert.equal(trace.keys.length,seconds);assert.equal(trace.writes.length,seconds);assert.equal(new Set(trace.writes.map(w=>w.request_id)).size,seconds);
  for(let n=0;n<seconds;n++){const key=trace.keys[n],write=trace.writes[n];assert.equal(key.trusted,true);assert.equal(key.isComposing,false);assert.equal(key.key,samples[n].key);assert.equal(key.connection,connections[0].connection_id);assert.equal(key.generation,connections[0].generation);assert.deepEqual(write.connection,connections[0]);assert.equal(write.text,key.key);samples[n].dom=key;samples[n].write=write;samples[n].localDispatchMs=write.t-key.t;assert.ok(samples[n].localDispatchMs>=0&&samples[n].hostUpperBoundMs>=0);}
  const remote=await control({op:'metrics'});assert.equal(remote.notification_failed,false);
  assert.deepEqual(remote.received[0],[...Buffer.from(samples.map(s=>s.key).join(''))]);assert.ok(remote.received.slice(1).every(b=>b.length===0),'unselected nineteen targets receive zero input');
  report.streams=streams.map((s,i)=>{const origin=done.get(i),sha256=s.hash.digest('hex');assert.equal(origin.error,null);assert.equal(origin.frames,seconds*21);assert.ok(origin.max_wall_mono_drift_ms<=20);assert.equal(s.frames,origin.frames);assert.equal(sha256,origin.sha256);assert.equal(s.pending.length,0);assert.ok(s.insideBytes/seconds>=20*1024,`actual source ${i} did not meet main-window rate`);return {stream:i,connection:connections[i],...origin,receivedFrames:s.frames,receivedBytes:s.bytes,insideWindowBytes:s.insideBytes,lateBytes:s.lateBytes,insideBytesPerSecond:s.insideBytes/seconds,secondBuckets:s.buckets,sha256,maxAvailableFrom:s.maxAvailableFrom,sourceGapBytes:0,truncated:false};});
  report.localDispatch=quantile(samples.map(s=>s.localDispatchMs));report.hostUpperBound=quantile(samples.map(s=>s.hostUpperBoundMs));
  report.localPass=report.localDispatch.p95<=100;report.shortEndToEndUpperBoundPass=report.hostUpperBound.p95<=100;report.passed=report.localPass&&report.shortEndToEndUpperBoundPass;
  report.samples=samples;report.observerBatches=observerBatches;report.resources=resources;report.audit=audit;report.remoteInputBytes=remote.received.map(b=>b.length);
  assert.deepEqual((await ui.invoke('logging_request',{request:{op:'capture_list'}})).logs,[]);assert.deepEqual((await ui.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
  await ui.screenshot(`P22-load-latency-${calibration?'calibration':'formal'}.png`);
  assert.equal(report.passed,true,'report local and conservative remote upper bound separately; no threshold relaxation');
}catch(error){aborted=true;report.passed=false;report.error=error.message;report.firstFailureHost=performance.now();report.readAtFirstFailure=currentRead&&{...currentRead,elapsedMs:performance.now()-currentRead.startedHost};
  await writeFile(artifact+'.first-fault.json',JSON.stringify({source,error:report.error,hostAt:report.firstFailureHost,readAtFirstFailure:report.readAtFirstFailure,sampleCount:samples.length,completedObserverBatches:observerBatches.length},null,2)+'\n');
  let settleTimer;try{report.taskSettlement=await Promise.race([Promise.allSettled(measurementTasks).then(rows=>rows.map(r=>r.status==='rejected'?{status:r.status,error:r.reason?.message}:{status:r.status})),new Promise(resolve=>{settleTimer=setTimeout(()=>resolve('bounded 11 second settle exceeded; no new input/source retries'),11000);})]);}finally{clearTimeout(settleTimer);}
  report.samples=samples;report.remoteEvents=remoteEvents;report.observerBatches=observerBatches;report.resources=resources;report.audit=audit;report.partialStreams=streams.map(({hash,pending,...s})=>({...s,pendingBytes:pending.length}));try{report.partialTrace=await ui?.evaluate(`({keys:window.__t18?.keys,writes:window.__t18?.writes,inputFailure:document.querySelector('.input-status')?.textContent})`);}catch(e){report.traceFailure=e.message;}
  console.error('T18 measurement failed:',error.message);}
finally{
  const cleanupErrors=[];
  if(ui){try{report.finalAudit=await ui.invoke('audit_history_request',{request:{op:'info'}});report.finalAuditObtained=true;if(report.finalAudit.status.state!=='HEALTHY'){report.passed=false;report.finalAuditProblem='normal internal audit not healthy';}}catch(e){report.finalAuditObtained=false;report.finalAuditFailure=e.message;}}
  try{if(fixture){report.cleanupTimeline.push({stage:'stop-source-start',hostAt:performance.now()});try{if(control&&fixture.exitCode===null)assert.equal((await control({op:'stop'})).result,'stopping');}catch(e){cleanupErrors.push(`fixture stop request: ${e.message}`);}fixture.stdin.end();const exited=new Promise(resolve=>{if(fixture.exitCode!==null||fixture.signalCode!==null)resolve();else fixture.once('exit',resolve);});const kill=setTimeout(()=>fixture.kill(),3000);await exited;clearTimeout(kill);report.fixtureExitCode=fixture.exitCode;assert.equal(fixture.exitCode,0,'own SSH fixture must exit normally');report.cleanupTimeline.push({stage:'source-exited',hostAt:performance.now()});}}catch(e){cleanupErrors.push(`owned fixture: ${e.message}`);}
  try{report.cleanupTimeline.push({stage:'close-owned-ui-start',hostAt:performance.now()});await ui?.close();report.cleanupTimeline.push({stage:'owned-ui-service-exited',hostAt:performance.now()});}catch(e){cleanupErrors.push(`owned Desktop/service: ${e.message}`);}
  if(stderr.includes('panicked'))cleanupErrors.push('owned fixture emitted a panic; see bounded synthetic stderr');
  report.fixtureStderr=stderr;report.ownedProcessesClosed=cleanupErrors.length===0;
  try{
    build(['build','-p','session-service','--locked']);report.ordinaryBuildRestored=true;
    const probe=await mkdtemp(path.join(os.tmpdir(),'shared-terminal-load-latency-normal-中文-'));let normal;
    try{normal=await launchDesktop(probe);assert.equal((await normal.invoke('service_status')).fixture,false);assert.deepEqual(await normal.invoke('service_list'),[]);assert.equal(await normal.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,e=>e==='FIXTURE_DISABLED')`),true);report.ordinaryRuntimeVerified=true;}
    finally{await normal?.close();assert.equal(path.dirname(path.resolve(probe)),path.resolve(os.tmpdir()));assert.ok(path.basename(probe).startsWith('shared-terminal-load-latency-normal-中文-'));await rm(probe,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  }catch(e){cleanupErrors.push(`ordinary restore/probe: ${e.message}`);}
  try{if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-load-latency-ui-中文-'));if(report.passed)await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});else report.retainedTestRoot=target;}}catch(e){cleanupErrors.push(`own root retained: ${e.message}`);}
  if(cleanupErrors.length){report.passed=false;report.cleanupErrors=cleanupErrors;}
  report.ownedProcessesClosed=cleanupErrors.length===0;
  report.after=await hashes();report.finishedAt=new Date().toISOString();await writeFile(artifact,JSON.stringify(report,null,2)+'\n');console.log(`T18 report ${artifact}`);
}
assert.equal(report.passed,true,'finite T18 software measurement did not pass');
console.log(`PASS T18 ${calibration?'calibration':'120 second software'}: twenty verified source rates, ${seconds} trusted key samples, local P95=${report.localDispatch.p95.toFixed(2)}ms, conservative Host-to-remote P95=${report.hostUpperBound.p95.toFixed(2)}ms; no 8 hour/logging claim`);
