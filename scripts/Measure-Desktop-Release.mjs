import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,launchDesktop} from './lib/DesktopHarness.mjs';

const [image,report] = process.argv.slice(2);
const root = await mkdtemp(path.join(tmpdir(),'shared-terminal-release-perf-中文-'));
let ui;
const count=8, frames=120, interval=50;
const summary=values=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return {count:sorted.length,p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)};
};
try {
  ui=await launchDesktop(root,{fixture:true,executable:path.resolve(image)});
  console.log('Measuring empty window');
  await ui.command('Performance.enable');
  const status=await ui.invoke('service_status');
  assert.equal(status.fixture,true);
  const phase=async run=>{
    const metrics=async()=>Object.fromEntries((await ui.command('Performance.getMetrics')).metrics.map(({name,value})=>[name,value]));
    const before=await metrics(), start=performance.now();
    await run();
    const elapsedMs=performance.now()-start, after=await metrics();
    return {elapsedMs,taskMs:(after.TaskDuration-before.TaskDuration)*1000,
      scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,layouts:after.LayoutCount-before.LayoutCount,
      styles:after.RecalcStyleCount-before.RecalcStyleCount};
  };
  const idle=await phase(()=>delay(frames*interval));
  const targets=[];
  for(let i=0;i<count;i++){
    const {connection_id,generation}=await ui.invoke('fixture_create');
    targets.push({connection_id,generation});
  }
  console.log('Measuring eight open tabs');
  await ui.waitFor('document.querySelectorAll(".connection-tab [role=tab]").length===8');
  await ui.fill('会话',targets[0].connection_id);
  await ui.waitFor('document.querySelector("[data-pane=first]").dataset.renderedId==='+JSON.stringify(targets[0].connection_id));
  await delay(350);
  const multi=await phase(()=>delay(frames*interval));
  const logging=request=>ui.invoke('logging_request',{request});
  const {log_id}=await logging({op:'start',connection:targets[0],request_id:crypto.randomUUID(),
    limits:{segment_bytes:262144,segments:2}});
  await ui.evaluate(`(()=>{
    const observed=window.releasePerfObserved={};
    new MutationObserver(()=>{
      const rows=document.querySelector('.xterm-rows');
      if(!rows)return;
      const now=performance.timeOrigin+performance.now();
      for(const token of rows.textContent.match(/PZ\\d{3}Z/g)??[])observed[token]??=now;
    }).observe(document.querySelector('[data-pane=first] .terminal'),{childList:true,characterData:true,subtree:true});
  })()`);
  const expected=targets.map(()=>[]), sent={};
  console.log('Measuring eight output sources');
  const flowing=await phase(async()=>{
    const start=performance.now();
    for(let i=0;i<frames;i++){
      const remaining=start+i*interval-performance.now();
      if(remaining>0)await delay(remaining);
      const token='PZ'+String(i).padStart(3,'0')+'Z';
      sent[token]=Date.now();
      const packets=targets.map((connection,index)=>{
        const packet=Buffer.from(token+' '+String(index)+' '+'x'.repeat(245)+'\r\n');
        expected[index].push(packet);
        return {connection,bytes:[...packet]};
      });
      await ui.evaluate('Promise.all('+JSON.stringify(packets)+
        '.map(args=>window.__TAURI_INTERNALS__.invoke("fixture_append",args)))');
    }
    await delay(Math.max(150,start+frames*interval-performance.now()));
  });
  const observations=await ui.evaluate('window.releasePerfObserved');
  console.log('Verifying output and shutdown');
  assert.equal(Object.keys(observations).length,frames,'all visible markers rendered');
  for(let i=0;i<count;i++){
    const exact=await ui.evaluate(`(async()=>{
      const page=await window.__TAURI_INTERNALS__.invoke('service_read',{connection:${JSON.stringify(targets[i])},cursor:1});
      const bytes=page.events.flatMap(event=>event.bytes);
      const expected=new TextEncoder().encode(${JSON.stringify(Buffer.concat(expected[i]).toString('ascii'))});
      return !page.truncated && page.events.every(event=>!event.gap_bytes) &&
        bytes.length===expected.length && bytes.every((byte,index)=>byte===expected[index]);
    })()`);
    assert.equal(exact,true,'exact stream '+i);
  }
  console.log('Verified source bytes');
  const logScope={connection:targets[0],log_id};
  await logging({op:'stop',...logScope});
  let recording;
  for(let i=0;i<200;i++){
    recording=await logging({op:'status',...logScope});
    if(recording.worker_finished)break;
    await delay(20);
  }
  assert.equal(recording.durable,true);
  assert.equal(recording.written_records,frames);
  assert.equal(recording.written_raw_bytes,Buffer.concat(expected[0]).length);
  assert.equal(recording.source_gap_bytes,0);
  assert.equal(recording.rejected_records,0);
  const result={result:'MEASURED',idle,multi,flowing,connections:count,frames,interval,
    exactBytes:expected.reduce((sum,packets)=>sum+Buffer.concat(packets).length,0),
    recording:{records:recording.written_records,bytes:recording.written_raw_bytes,durable:true},
    visibleMs:summary(Object.keys(sent).map(token=>observations[token]-sent[token]))};
  await writeFile(report,JSON.stringify(result,null,2)+'\n');
  const audit=(await ui.invoke('audit_history_request',{request:{op:'info'}})).status;
  assert.equal(audit.state,'HEALTHY');
  const original=targets.at(-1);
  const tab=`document.querySelector('[data-connection-id="${original.connection_id}"]')`;
  const start=performance.now();
  const renewed=await ui.invoke('fixture_lifecycle',{connection:original,action:'reconnect'});
  assert.equal(renewed.generation,original.generation+1);
  await ui.waitFor(`${tab}?.title.endsWith(' / ${renewed.generation}')`);
  const generationRefreshMs=performance.now()-start;
  const connection={connection_id:renewed.connection_id,generation:renewed.generation};
  await ui.invoke('fixture_lifecycle',{connection,action:'close'});
  await ui.waitFor(`${tab}?.title.includes('DISCONNECTED')`);
  await ui.invoke('fixture_lifecycle',{connection,action:'remove'});
  await ui.waitFor(`!${tab}`);
  Object.assign(result,{generationRefreshMs,closedAndRemovedTab:true});
  console.log('Audit healthy, closing Desktop');
  assert.equal(await ui.evaluate(`(()=>{
    const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click();
    const quit=Array.from(menu.querySelectorAll('button')).find(button=>button.textContent==='退出桌面');
    if(!quit||quit.disabled)return false;
    setTimeout(()=>quit.click(),50);
    return true;
  })()`),true);
  for(let i=0;i<160&&ui.app.exitCode===null;i++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  const close=JSON.parse(await readFile(path.join(root,'desktop-close-receipts-v1',status.service_id+'.json'),'utf8'));
  assert.equal(close.owned_pid,status.pid);
  assert.equal(close.shutdown_ack,'ACKNOWLEDGED');
  assert.equal(close.exited,true);
  assert.equal(close.exit_code,0);
  assert.equal(close.kill_requested,false);
  assert.equal(close.reader.diagnostic.outcome,'CLOSED');
  assert.equal(close.reader.diagnostic.accepted,close.reader.diagnostic.synced);
  Object.assign(result,{result:'PASS',close:{ack:close.shutdown_ack,exit:close.exit_code,audit:close.reader.diagnostic.outcome}});
  await ui.close();ui=undefined;
  await writeFile(report,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{
  await ui?.close();
  assert.equal(path.dirname(root),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('shared-terminal-release-perf-中文-'));
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
