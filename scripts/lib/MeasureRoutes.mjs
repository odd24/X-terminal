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
    $ids=@(${desktop}); $web=@()
    while ($ids.Count) {
      $next=@()
      foreach ($parent in $ids) {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent AND Name='msedgewebview2.exe'")) {
          $next+=$p.ProcessId; $web+=$p.ProcessId
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
  report.singleEcho=await echo(ui,30,'K');
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
