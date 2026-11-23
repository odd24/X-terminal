import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const runs=Number(process.argv[4]??5);
assert.ok(Number.isInteger(runs)&&runs>=1&&runs<=10);
const node=process.execPath;
const profiles=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile','-NonInteractive','-Command','$PROFILE.CurrentUserCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.AllUsersAllHosts | ForEach-Object {Test-Path -LiteralPath $_}'],
  {encoding:'utf8',windowsHide:true});
assert.equal(profiles.trim().split(/\s+/).join(','),'False,False,False,False','benchmark must avoid existing PowerShell profile scripts');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-performance-中文-'));
const result={result:'IN_PROGRESS',executable,runs,observations:[]};
const q=JSON.stringify;
const surface='.pane-active .local-terminal:not([hidden])';
const output=`document.querySelector(${q(surface+' .local-terminal-output')})?.innerText`;
const focused=`document.activeElement?.matches(${q(surface+' .xterm-helper-textarea')})`;
const login=`/PS [\\s\\S]+>\\s*$/.test(${output}??'')`;
const quote=s=>'"'+s+'"';
let ui;

async function until(condition){
  const end=performance.now()+10000;
  while(performance.now()<end){
    if(await ui.evaluate(condition))return;
    await delay(5);
  }
  throw Error('Timed out: '+condition);
}
async function timed(run){const start=performance.now();await run();return performance.now()-start;}
async function enter(){
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
}
const insert=text=>ui.command('Input.insertText',{text});
async function tool(name){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function select(n){
  await ui.click('本地 '+n);
  await until(`(${focused})&&[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(t=>t.textContent===${q('本地 '+n)})`);
}
async function collect(){
  const {metrics}=await ui.command('Performance.getMetrics');
  return Object.fromEntries(metrics.filter(({name})=>['TaskDuration','ScriptDuration','JSHeapUsedSize'].includes(name)).map(({name,value})=>[name,value]));
}
async function metrics(run){
  await ui.evaluate('window.__measureDesktop={calls:{},bytes:0,records:{},capture:false}');
  const before=await collect(),start=performance.now();
  await run();
  const elapsed=performance.now()-start,after=await collect();
  const counters=await ui.evaluate('window.__measureDesktop');
  return {elapsed,rendererTaskMs:(after.TaskDuration-before.TaskDuration)*1000,rendererScriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,
    heapBytes:after.JSHeapUsedSize,...counters};
}
async function mark(name){
  await until(`(${output})?.includes(${q(name)})`);
}
async function finished(id){
  await mark('END_'+id);
  await until(`document.querySelector(${q(surface)})?.dataset.foreground==='false'`);
}
async function exit(){
  await tool('退出桌面');
  await until('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();ui=undefined;
}
try{
  const fixture=path.join(root,'合成输出.cjs');
  await writeFile(fixture,`
let i=0;
const tick=setInterval(()=>{
  for(let n=0;n<12;n++){
    if(i===480){clearInterval(tick);process.stdout.write('END_'+process.argv[2]+'\\n');return;}
    process.stdout.write('SEQ_'+process.argv[2]+'_'+String(i++).padStart(4,'0')+'_'+('x'.repeat(48))+'\\n');
  }
},35);
`);
  for(let run=0;run<runs;run++){
    const directory=path.join(root,String(run));await mkdir(directory);
    const start=performance.now();
    ui=await launchDesktop(directory,{executable});
    const sample={startupMs:performance.now()-start,lightMs:[],powerShellMs:[],switchMs:[],echoMs:[]};
    await ui.command('Performance.enable');
    await ui.evaluate(`(() => {
      const fetch=window.fetch;
      window.fetch=function(input,init){
        const counters=window.__measureDesktop;
        if(!counters)return fetch.call(this,input,init);
        const command=new URL(String(input)).pathname.slice(1);
        let body;try{body=JSON.parse(init?.body)}catch{}
        const key=command+(command==='local_terminal'?'/'+body?.action?.kind:'');
        counters.calls[key]=(counters.calls[key]??0)+1;
        const pending=fetch.call(this,input,init);
        if(counters.capture&&(key==='local_terminal/poll'||key==='poll_local_output')){
          pending.then(async response=>{
            const raw=new Uint8Array(await response.clone().arrayBuffer());
            counters.bytes+=raw.length;
            const decoder=new TextDecoder();
            let text='';
            if(key==='local_terminal/poll'){
              const message=JSON.parse(decoder.decode(raw));
              text=decoder.decode(Uint8Array.from(message.bytes??[]));
            }else if(raw.length>=4){
              const size=new DataView(raw.buffer).getUint32(0,true);
              text=decoder.decode(raw.subarray(4+size));
            }
            const id=body?.action?.id??body?.id;
            counters.records[id??'unknown']=(counters.records[id??'unknown']??'')+text;
          }).catch(()=>{counters.captureError=true;});
        }
        return pending;
      };
    })()`);
    sample.lightMs.push(await timed(async()=>{await tool('轻量命令行');await until(`(${focused})&&(${output})?.includes('>')`);}));
    sample.lightMs.push(await timed(async()=>{await tool('轻量命令行');await select(2);}));
    for(const n of [3,4]){
      sample.powerShellMs.push(await timed(async()=>{await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");await until(`(${focused})&&(${login})&&[...document.querySelectorAll('[role=tab][aria-selected=true]')].some(t=>t.textContent===${q('本地 '+n)})`);}));
    }
    for(const [i,n] of [1,3,2,4,1,3,2,4].entries()){
      sample.switchMs.push(await timed(()=>select(n)));
      const marker='PERF_ECHO_'+i;
      sample.echoMs.push(await timed(async()=>{
        await insert(n<3?marker:`Write-Output ('PERF_ECHO_' + '${i}')`);
        if(n>=3)await enter();
        await mark(marker);
        if(n>=3)await until(login);
      }));
      if(n<3){
        await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
        await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
      }
    }
    sample.idle=await metrics(()=>delay(1800));
    assert.ok(Object.keys(sample.idle.calls).length,'IPC counter must observe real work');
    sample.output=await metrics(async()=>{
      const start=async(n,id)=>{await select(n);await insert([quote(node),quote(fixture),id].join(' '));await enter();};
      await start(1,'A');await start(2,'B');
      await finished('B');await select(1);await finished('A');
    });
    const producers=await ui.evaluate(`[1,2].map(n=>[...document.querySelectorAll('[role=tab]')].find(tab=>tab.textContent==='本地 '+n).dataset.connectionId)`);
    const captured=await metrics(async()=>{
      await ui.evaluate('window.__measureDesktop.capture=true');
      const start=async(n,id)=>{await select(n);await insert([quote(node),quote(fixture),id].join(' '));await enter();};
      await start(1,'C');await start(2,'D');
      await finished('D');await select(1);await finished('C');
      await delay(150);
    });
    assert.ok(!captured.captureError);
    assert.ok(Object.keys(captured.records).length>=2,'both producers must be sampled');
    for(const [index,id] of ['C','D'].entries()){
      const stream=captured.records[producers[index]]??'';
      const found=Array.from(stream.matchAll(new RegExp('SEQ_'+id+'_(\\d{4})_x{48}','g')),match=>Number(match[1]));
      assert.deepEqual(found,Array.from({length:480},(_,i)=>i));
      assert.doesNotMatch(stream,new RegExp('SEQ_'+(id==='C'?'D':'C')+'_'));
    }
    sample.wireBytes=captured.bytes;
    if(process.argv.includes('--tabs')){
      sample.tabScale={};
      for(const count of [4,20]){
        if(count===20)for(let n=5;n<=20;n++){await tool('轻量命令行');await select(n);}
        const times=[];
        for(let i=0;i<30;i++)times.push(await timed(()=>select(i%2?1:count)));
        sample.tabScale[count]=times;
      }
    }
    await exit();
    result.observations.push(sample);
  }
  result.result='PASS';
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui)await ui.screenshot('desktop-performance-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  await writeFile(report,JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
