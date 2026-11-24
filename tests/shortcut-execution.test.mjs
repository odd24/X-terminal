import assert from 'node:assert/strict';
import test from 'node:test';
import {ShortcutExecution,sameShortcutSource} from '../apps/desktop/src/shortcut-execution.ts';

const remote={pane:'first',owner:'service',connection:{protocol:'SSH2',connection_id:'A',generation:1}};
const local={pane:'first',local:'A'};
const adb={id:'button',name:'设备状态',command:'adb get-state'};

function setup(){
  const execution=new ShortcutExecution();
  const starts=[],intents=[],opens=[],writes=[];
  const ui={
    selected:()=>true,epoch:()=>1,writable:()=>true,
    readText:async()=>({text:'pwd',append_enter:true}),
    send:(...args)=>writes.push(args),error:assert.fail,
    prompt:()=>({busy:false,hasDraft:false}),
    open:async(pane,options)=>{opens.push(options);return 'B';},
    starting:value=>starts.push(value),dispatch:intent=>intents.push(intent),
  };
  return {execution,ui,starts,intents,opens,writes,run:(source,item)=>execution.execute(source,item,'revision',ui)};
}

test('background result B closes without restoring A over current C; receipts are tied to the result',()=>{
  const {execution}=setup();
  execution.origins.set('B',remote);
  assert.equal(execution.closeResult('B','first','C',true).restore,undefined);
  assert.equal(execution.origins.has('B'),false);
  execution.origins.set('B',remote);
  assert.equal(execution.closeResult('B','first','B',true).restore,remote);
  assert.equal(execution.closeResult('B','first','B',true).restore,undefined);
});

test('pending remote text checks epoch, selected identity and writability after lookup',async()=>{
  for(const change of ['closed','generation','service','protocol','pane','epoch','readonly','none']){
    const {ui,run,writes}=setup();
    const reply=Promise.withResolvers();
    let current=remote,epoch=1,writable=true;
    ui.readText=request=>{assert.deepEqual(request,{button:'button',revision:'revision'});return reply.promise;};
    ui.epoch=()=>epoch;ui.selected=source=>sameShortcutSource(source,current);ui.writable=()=>writable;
    const pending=run(remote,{...adb,desktop_kind:'send'});
    if(change==='closed')current=undefined;
    if(change==='generation')current={...remote,connection:{...remote.connection,generation:2}};
    if(change==='service')current={...remote,owner:'other'};
    if(change==='protocol')current={...remote,connection:{...remote.connection,protocol:'SERIAL'}};
    if(change==='pane')current={...remote,pane:'second'};
    if(change==='epoch')epoch++;
    if(change==='readonly')writable=false;
    reply.resolve({text:'pwd',append_enter:true});
    await pending;
    assert.deepEqual(writes,change==='none'?[['first',remote.connection,'pwd\r']]:[]);
  }
});

test('startup is single flight; late completion and diagnostic cannot settle a newer invocation',async()=>{
  const {execution,ui,run,intents,starts}=setup();
  const opened=Promise.withResolvers();
  let opens=0;
  ui.open=()=>{opens++;return opened.promise;};
  const pending=run(remote,adb);
  await run(remote,adb);
  assert.equal(opens,1);
  opened.resolve('B');await pending;
  const [old]=intents;
  assert.equal(execution.startingTab('B'),true);
  assert.equal(execution.settle(old.request),true);
  ui.open=async()=>'C';
  await run(remote,adb);
  assert.equal(execution.acceptsDiagnostic(old),false);
  assert.equal(execution.acceptsDiagnostic(intents[1]),true);
  assert.equal(execution.settle(old.request),false);
  assert.equal(execution.closeResult('B','first','C',false).released,false);
  assert.equal(execution.closeResult('C','first','C',false).released,true);
  assert.deepEqual(starts,[true,true]);
});

test('only idle ordinary ADB reuses a clean prompt; failed open frees the gate and scripts keep their button revision',async()=>{
  for(const [item,prompt,reuse] of [
    [adb,{busy:false,hasDraft:false},true],[adb,undefined,false],[adb,{busy:true,hasDraft:false},false],
    [adb,{busy:false,hasDraft:true},false],[{...adb,desktop_kind:'local'},{busy:false,hasDraft:false},false],
    [{...adb,close_on_success:true},{busy:false,hasDraft:false},false],
  ]){
    const {run,ui,intents,opens}=setup();ui.prompt=()=>prompt;
    await run(local,item);
    assert.equal(intents[0].id,reuse?'A':'B');assert.equal(opens.length,reuse?0:1);
  }
  const {ui,starts,run,opens}=setup(),open=ui.open;
  ui.open=async()=>undefined;
  await run(remote,adb);assert.deepEqual(starts,[true,false]);
  ui.open=open;
  await run(remote,{...adb,script_path:'script.bat'});
  assert.deepEqual(opens[0].script,{button:'button',revision:'revision'});
  await run(remote,adb);assert.equal(opens.length,2);
});
