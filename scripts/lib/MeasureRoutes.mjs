import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {connectDesktopPage,delay} from './DesktopHarness.mjs';

// All clocks below belong to the measured renderer. Exclude harness polling from timestamps.
async function install(page){
  await page.command('Performance.enable');
  await page.evaluate(`(()=>{
    const fetch=window.fetch;
    window.routeMetrics={};
    window.fetch=async function(input,init){
      const start=performance.now(), name=new URL(String(input)).pathname;
      const sample=window.routeMetrics;
      const response=await fetch.call(this,input,init);
      if(sample.capture&&name==='/service_read'){
        const page=await response.clone().json();
        if(page.connection.connection_id!==sample.capture.id||page.truncated||page.events.some(e=>e.gap_bytes))
          sample.capture.invalid=true;
        for(const e of page.events)sample.capture.text+=new TextDecoder().decode(Uint8Array.from(e.bytes));
      }
      if(sample.trace&&name==='/local_terminal'&&JSON.parse(init.body).action.kind==='run_adb')
        sample.trace.accepted=performance.now()-sample.started;
      if(sample.calls&&(name==='/desktop_session_snapshot'||name==='/service_read'))
        (sample.calls[name]??=[]).push(performance.now()-start);
      return response;
    };
  })()`);
}
async function stats(page){
  const {metrics}=await page.command('Performance.getMetrics');
  return metrics.find(m=>m.name==='TaskDuration').value;
}
function ownedCpu(ps,desktop,service){
  // Traverse only this harness's descendants. Exclude ADB and PowerShell children.
  const command=`
    Add-Type -Path 'scripts/lib/LoadSoakSnapshot.cs'
    $rows=@([LoadSoakSnapshot]::Processes() | Where-Object Name -eq 'msedgewebview2.exe')
    $ids=@(${desktop}); $web=@()
    while ($ids.Count) {
      $next=@()
      foreach ($parent in $ids) {
        foreach ($p in @($rows | Where-Object Parent -eq $parent)) {
          $next+=$p.Pid; $web+=$p.Pid
        }
      }
      $ids=$next
    }
    $result=@{}
    foreach($id in @(${desktop},${service})+$web){
      $p=Get-Process -Id $id -ErrorAction SilentlyContinue
      if($p){$result[[string]$id]=$p.TotalProcessorTime.TotalMilliseconds}
    }
    $result | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync(ps,['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000}));
}
async function idle(pages,ps,pids){
  const cpuBefore=ownedCpu(ps,...pids);
  const before=await Promise.all(pages.map(stats));
  for(const page of pages)await page.evaluate('window.routeMetrics={calls:{}}');
  await delay(30000);
  const windows=await Promise.all(pages.map(async(page,i)=>({
    calls:await page.evaluate('window.routeMetrics.calls'),
    rendererMs:1000*((await stats(page))-before[i])
  })));
  const cpuAfter=ownedCpu(ps,...pids);
  const cpu={desktop:0,service:0,webview:0};
  assert.ok(pids.every(id=>id in cpuBefore&&id in cpuAfter));
  for(const [id,end] of Object.entries(cpuAfter))if(id in cpuBefore)
    cpu[Number(id)===pids[0]?'desktop':Number(id)===pids[1]?'service':'webview']+=end-cpuBefore[id];
  return {windows,cpuMs:cpu};
}
async function detach(ui,executable,connection,ps){
  const {service_id}=await ui.invoke('service_status');
  const child=spawn(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/lib/Drag-TestWindow.ps1',
    '-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',executable,'-Title','共享终端',
    '-Points',JSON.stringify([{x:-35,y:150,outside:true}]),'-PlaceAtWorkAreaStart','-HoldOutside'],
    {windowsHide:true,stdio:['ignore','pipe','pipe']});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const reader=createInterface({input:child.stdout});
  try{
    const first=await reader[Symbol.asyncIterator]().next();
    assert.equal(first.value,'OWNED_POINTER_OUTSIDE');
    await ui.invoke('detach_session',{serviceId:service_id,connection:{
      connection_id:connection.connection_id,generation:connection.generation}});
  }finally{reader.close();assert.equal(await closed,0);}
  const target=(await ui.otherPages())[0];
  assert.ok(target);
  return connectDesktopPage(target);
}

export async function verifyWindowCommands({ui,first,second,executable,powershell}){
  const reference=({connection_id,generation})=>({connection_id,generation});
  const status=(page,connection)=>page.invoke('ssh_request',{request:{op:'status',connection:reference(connection)}});
  const firstRef=reference(first),secondRef=reference(second);
  const denied=/SESSION_IN_OTHER_WINDOW/;
  await ui.waitFor(`document.querySelector('[role=tab][data-connection-id="${second.connection_id}"]')?.getAttribute('aria-label')==='localhost'`);
  assert.deepEqual(reference((await status(ui,first)).connection),firstRef);
  const held=await ui.interceptIpc({command:'ssh_request',op:'status',connectionId:second.connection_id,mode:'hold'});
  const old=status(ui,second);
  let child;
  try{
    for(let wait=0;wait<100&&await held.count()===0;wait++)await delay(20);
    assert.equal(await held.count(),1);
    child=await detach(ui,executable,second,powershell);
    assert.deepEqual((await ui.invoke('service_list')).map(reference),[firstRef]);
    assert.deepEqual((await child.invoke('service_list')).map(reference),[secondRef]);
    await assert.rejects(status(child,first),denied);
    await assert.rejects(status(child,{...second,generation:second.generation+1}),denied);
    assert.deepEqual(reference((await status(child,second)).connection),secondRef);
    // The original main-webview response remains held. New requests run after restoring it.
    const fixed={op:'connect_status',profile_id:crypto.randomUUID(),revision:crypto.randomUUID(),request_id:crypto.randomUUID()};
    await assert.rejects(child.invoke('ssh_request',{request:fixed}),denied);
    await assert.rejects(ui.invoke('ssh_request',{request:fixed}),/PermissionDenied/);
    await assert.rejects(child.invoke('serial_request',{request:{op:'inventory'}}),denied);
    await assert.rejects(child.invoke('serial_request',{request:{op:'status',connection:firstRef}}),denied);
  }finally{
    await held.restore();
    try{
      assert.deepEqual(reference((await old).connection),secondRef);
      if(child)await assert.rejects(status(ui,second),denied);
    }finally{
      if(child){
        const label=await child.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label');
        try{await child.evaluate(`setTimeout(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:${JSON.stringify(label)}}),0);true`);}
        finally{child.close();}
      }
    }
  }
}

async function echo(ui,n,prefix){
  const times=[];
  for(let i=0;i<n;i++){
    const marker=prefix+String(i).padStart(2,'0')+'X';
    await ui.evaluate(`(()=>{
      const pane=document.querySelector('.pane-active');
      pane.querySelector('.xterm-helper-textarea').focus();
      const rows=pane.querySelector('.xterm-rows');
      window.echoMs=null;
      const start=performance.now();
      const obs=new MutationObserver(()=>{
        if(rows.textContent.includes(${JSON.stringify(marker)})){
          window.echoMs=performance.now()-start;obs.disconnect();
        }
      });
      obs.observe(rows,{subtree:true,childList:true,characterData:true});
    })()`);
    await ui.command('Input.insertText',{text:marker});
    await ui.waitFor('window.echoMs!==null');
    times.push(await ui.evaluate('window.echoMs'));
  }
  return times;
}

const wallNow=()=>performance.timeOrigin+performance.now();

async function clockBracket(readClock){
  let best;
  for(let attempt=0;attempt<8;attempt++){
    const before=wallNow(),sample=await readClock(),after=wallNow();
    const offset=sample-(before+after)/2,halfRoundTrip=(after-before)/2;
    if(!best||halfRoundTrip<best.halfRoundTrip)best={offset,halfRoundTrip};
  }
  return best;
}

async function echoStageSample(ui,marker,timing,background){
  await ui.evaluate(`(()=>{
    performance.clearMarks();
    window.__terminalEchoTiming=${timing};
    const pane=document.querySelector('.pane-active');
    const textarea=pane.querySelector('.xterm-helper-textarea');
    textarea.focus();
    const rows=pane.querySelector('.xterm-rows'), trace={start:performance.now(),connection:pane.dataset.renderedId};
    window.echoStageSample=trace;
    const noteInput=()=>{ trace.input=performance.now(); };
    pane.addEventListener('beforeinput',noteInput,{once:true,capture:true});
    const observer=new MutationObserver(()=>{
      if(!rows.textContent.includes(${JSON.stringify(marker)}))return;
      trace.dom=performance.now();
      observer.disconnect();
      pane.removeEventListener('beforeinput',noteInput,true);
      requestAnimationFrame(()=>{trace.frameAt=performance.now();});
    });
    observer.observe(rows,{subtree:true,childList:true,characterData:true});
  })()`);
  await Promise.all([ui.command('Input.insertText',{text:marker}),background?.()]);
  await ui.waitFor('window.echoStageSample.frameAt!==undefined');
  if(timing)await ui.waitFor(`['terminal-echo-writer','terminal-echo-reply'].every(name=>
    performance.getEntriesByName(name).some(mark=>mark.detail.connection===window.echoStageSample.connection))`);
  return ui.evaluate(`({
    ...window.echoStageSample,origin:performance.timeOrigin,
    marks:performance.getEntriesByType('mark').filter(mark=>mark.name.startsWith('terminal-echo-')&&mark.detail.connection===window.echoStageSample.connection)
      .map(mark=>({name:mark.name,t:mark.startTime,...mark.detail}))
  })`);
}

export async function measureEchoStages({ui,first,second,activate,key,pushOutput,fixtureControl}){
  const control=fixtureControl.get(first.connection_id);
  const rendererClock=()=>ui.evaluate('performance.timeOrigin+performance.now()');
  const peerClock=async()=>(await control({op:'clock'})).wall_at_us/1000;
  const rendererStart=await clockBracket(rendererClock),peerStart=await clockBracket(peerClock);
  const batches=[];
  let sequence=0;
  try{
    await activate(first);
    for(const scenario of ['single','split','split-load']){
      if(scenario==='split'){
        await key('b',66,10);
        await ui.splitTab(second.connection_id,'vertical');
        await ui.waitFor("document.querySelectorAll('[data-pane][data-rendered-id]').length===2");
        await activate(first);
      }
      for(const timing of [false,true,true,false]){
        const samples=[];
        for(let sample=0;sample<34;sample++){
          const sequenceId=++sequence;
          const marker=`L${String(sequenceId).padStart(4,'0')}Q`;
          const background=scenario==='split-load'
            ?()=>pushOutput.get(second.connection_id)(`${'x'.repeat(1500)}\r\nLOAD${sequenceId}END\r\n`)
            :undefined;
          const trace=await echoStageSample(ui,marker,timing,background);
          if(sample>=4)samples.push({sequenceId,marker,trace});
        }
        batches.push({scenario,timing,samples});
      }
    }
    const loadedPane=`[data-rendered-id="${second.connection_id}"] .xterm-rows`;
    await ui.waitFor(`document.querySelector(${JSON.stringify(loadedPane)})?.textContent.includes('LOAD${sequence}END')`);
  }finally{
    await ui.evaluate('window.__terminalEchoTiming=false;performance.clearMarks()');
  }
  const peerEnd=await clockBracket(peerClock),rendererEnd=await clockBracket(rendererClock);
  const remote=await control({op:'metrics'});
  const clockError=Math.max(rendererStart.halfRoundTrip,rendererEnd.halfRoundTrip)+
    Math.max(peerStart.halfRoundTrip,peerEnd.halfRoundTrip)+
    Math.abs(rendererEnd.offset-rendererStart.offset)+Math.abs(peerEnd.offset-peerStart.offset);
  for(const batch of batches){
    batch.samples=batch.samples.map(({sequenceId,marker,trace})=>{
      const received=remote.received.map((bytes,index)=>Buffer.from(bytes).toString()===marker?index:-1).filter(i=>i>=0);
      assert.equal(received.length,1,'each timed probe must reach its SSH peer once');
      const remoteAt=remote.received_at_us[received[0]]/1000-peerStart.offset+rendererStart.offset-trace.origin;
      const stages={sequenceId,controllerToDom:trace.dom-trace.start,domToFrame:trace.frameAt-trace.dom};
      if(!batch.timing){assert.equal(trace.marks.length,0);return stages;}
      const find=(name,match=()=>true)=>trace.marks.find(mark=>mark.name===`terminal-echo-${name}`&&match(mark));
      const dispatch=find('dispatch'),queue=find('queue',mark=>mark.id===dispatch?.id);
      const reply=find('reply',mark=>mark.id===dispatch?.id);
      const page=find('page');
      const writer=find('writer',mark=>mark.next===page?.next);
      assert.ok(queue&&dispatch&&reply&&page&&writer,'missing renderer measurement stage');
      return {...stages,inputToQueue:Number.isFinite(trace.input)?queue.t-trace.input:null,queuedToDispatch:dispatch.t-queue.t,
        writeIpc:reply.t-dispatch.t,dispatchToPeer:remoteAt-dispatch.t,peerToReadRequest:page.readStarted-remoteAt,
        readIpc:page.t-page.readStarted,pageToWriter:writer.t-page.t,writerToDom:trace.dom-writer.t};
    });
  }
  await ui.click('收起分屏，保留连接');
  await activate(first);
  await key('b',66,10);
  return {batches,clockError,rendererStart,rendererEnd,peerStart,peerEnd};
}

export async function measureRoutes({ui,first,second,group,single,activate,close,key,row,output,executable,powershell,pushOutput},report){
  await install(ui);
  report.shortcuts=[];
  for(let i=0;i<30;i++){
    const name=i%2?single:group;
    await ui.evaluate(`(()=>{
      const start=performance.now(),trace={};
      window.routeMetrics={started:start,trace};
      const obs=new MutationObserver(()=>{
        const out=document.querySelector(${JSON.stringify(output)});
        if(!out)return;
        trace.tab??=performance.now()-start;
        if(out.innerText.trim())trace.firstOutput??=performance.now()-start;
        if(out.innerText.includes('fixture:/ #')&&document.activeElement?.matches('.local-terminal .xterm-helper-textarea'))
          trace.prompt??=performance.now()-start;
        if(out.innerText.includes('/fixture-read-only')){trace.echo=performance.now()-start;obs.disconnect();}
      });
      obs.observe(document.querySelector('.pane-active'),{childList:true,characterData:true,subtree:true,attributes:true});
      ${row(name)}.click();
    })()`);
    await ui.waitFor('window.routeMetrics.trace.prompt!==undefined');
    await ui.command('Input.insertText',{text:'pwd'});await key('Enter',13);
    await ui.waitFor('window.routeMetrics.trace.echo!==undefined');
    const trace=await ui.evaluate('window.routeMetrics.trace');
    assert.ok(Number.isFinite(trace.accepted));
    report.shortcuts.push({name,...trace});
    await ui.command('Input.insertText',{text:'exit'});await key('Enter',13);
    await ui.waitFor(`document.querySelector(${JSON.stringify(output)})?.innerText.includes('前台进程退出（0）')`);
    await close(await ui.evaluate("document.querySelector('.pane-active [role=tab][aria-selected=true]').dataset.connectionId"));
  }
  const logging=request=>ui.invoke('logging_request',{request:{...request,connection:{
    connection_id:first.connection_id,generation:first.generation}}});
  const recording=second?undefined:await logging({op:'start',request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
  report.singleEcho=await echo(ui,30,'K');
  if(recording){
    await logging({op:'stop',log_id:recording.log_id});
    let state;
    for(let i=0;i<200;i++){
      state=await logging({op:'status',log_id:recording.log_id});
      if(state.worker_finished)break;
      await delay(20);
    }
    assert.ok(state.worker_finished&&state.durable);
    assert.equal(state.source_gap_bytes,0);
    assert.equal(state.rejected_raw_bytes,0);
    assert.ok(state.written_raw_bytes>=120);
    report.serialRecording={written:state.written_raw_bytes,records:state.written_records,gap:state.source_gap_bytes,rejected:state.rejected_raw_bytes,durable:state.durable};
  }
  if(second){
    await key('b',66,10);
    await ui.splitTab(second.connection_id);
    await ui.waitFor("document.querySelectorAll('[data-pane][data-rendered-id]').length===2");
    report.splitEcho=await echo(ui,30,'J');
    await ui.click('收起分屏，保留连接');
    await activate(first);
  }
  await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");
  await ui.waitFor("document.querySelector('.pane-active .local-terminal:not([hidden]) .xterm-rows')?.textContent.includes('PS ')");
  const pids=[ui.app.pid,(await ui.invoke('service_status')).pid];
  report.oneWindow=await idle([ui],powershell,pids);
  if(second){
    const detached=await detach(ui,executable,second,powershell);
    try{
      await detached.waitFor(`!!document.querySelector('[data-rendered-id="${second.connection_id}"]')`);
      await install(detached);
      report.twoWindows=await idle([ui,detached],powershell,pids);
      const snapshot=await ui.invoke('desktop_session_snapshot');
      assert.ok(!snapshot.sessions.some(c=>c.connection_id===second.connection_id));
      const view=await detached.invoke('desktop_session_snapshot');
      assert.deepEqual(view.sessions.map(c=>c.connection_id),[second.connection_id]);
      await detached.evaluate(`window.routeMetrics={capture:{id:${JSON.stringify(second.connection_id)},text:''}};true`);
      const burst=Array.from({length:1000},(_,i)=>String(i).padStart(4,'0')+' '+('x'.repeat(68))+'\r\n').join('')+'BURST_TAIL';
      await pushOutput.get(second.connection_id)(burst);
      await detached.waitFor("document.querySelector('.xterm-rows')?.textContent.includes('BURST_TAIL')");
      const captured=await detached.evaluate('window.routeMetrics.capture');
      assert.ok(!captured.invalid);
      assert.equal(captured.text,burst);
      report.burstBytes=burst.length;
      const label=await detached.evaluate('window.__TAURI_INTERNALS__.metadata.currentWindow.label');
      await detached.evaluate(`setTimeout(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:${JSON.stringify(label)}}),0);true`);
    }finally{detached.close();}
  }
  await activate(first);
  if(second)await key('b',66,10);
}
