import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay, desktopEvidence, launchDesktop} from './lib/DesktopHarness.mjs';
import {desktopKeyboard} from './lib/DesktopKeyboard.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const baseline=process.argv.includes('--baseline');
const temp=await realpath(tmpdir());
const root=await mkdtemp(path.join(temp,'shared-terminal-shortcut-stop-'));
const result={...await desktopEvidence(executable),checks:[],result:'FAIL'};
let ui;
const selected=()=>ui.evaluate('document.querySelector(".pane-active [role=tab][aria-selected=true]")?.dataset.connectionId');
const tab=id=>`document.querySelector('[role=tab][data-connection-id="${id}"]')`;
const rows='document.querySelector(".pane-active .local-terminal:not([hidden]) .xterm-rows")?.textContent';
const seen=text=>ui.waitFor(`${rows}?.includes(${JSON.stringify(text)})`);
const check=(name,details={})=>{result.checks.push({name,...details});console.log(name);};
try{
  ui=await launchDesktop(root,{executable,isolatedPowerShell:true,windowsHide:false});
  const keyboard=desktopKeyboard(ui,[]);
  const pressC=()=>keyboard.key('c','KeyC',67,{modifiers:2});
  const bat=async(name,body,close_on_success=true)=>{
    const script_path=path.join(root,name+'.bat');
    await writeFile(script_path,'@echo off\r\n'+body.replaceAll('\n','\r\n')+'\r\n','ascii');
    return {name,id:randomUUID(),script_path,close_on_success};
  };
  const stopped='echo OWNED_WAIT\n"%SystemRoot%\\System32\\ping.exe" -n 60 127.0.0.1 >nul\necho OWNED_CONTINUED\nset /p OWNED_END=OWNED_LATER_FAILURE:\nexit /b 255';
  const yes=await bat('StopYes',stopped);
  const no=await bat('StopNo',stopped);
  const unchecked=await bat('KeepStopped',stopped,false);
  const success=await bat('ExitZero','set /p OWNED_SUCCESS=OWNED_SUCCESS:\nexit /b 0');
  const uncheckedSuccess=await bat('KeepSuccess','set /p OWNED_SUCCESS=KEEP_SUCCESS:\nexit /b 0',false);
  const failed=await bat('Exit255','echo OWNED_FAILURE\nexit /b 255');
  const gap=await bat('OutputGap','set /p OWNED_GO=GAP_START:\nfor /L %%i in (1,1,5000) do echo '+
    'X'.repeat(240)+'\necho ready > "%~dp0gap-ready"\nset /p OWNED_DONE=GAP_EXIT:\nexit /b 0');
  const group={name:'StopCommand',id:randomUUID(),command:'"'+path.join(process.env.SystemRoot,'System32','ping.exe')+'" -n 60 127.0.0.1',desktop_kind:'local',close_on_success:true};
  const items=[yes,no,unchecked,success,uncheckedSuccess,failed,group,gap];
  const saved=await ui.invoke('local_adb_settings',{settings:{revision:null,shortcuts:items}});
  assert.deepEqual(saved.shortcuts.map(x=>!!x.close_on_success),items.map(x=>x.close_on_success));
  await ui.command('Page.reload');
  await ui.waitFor('!!document.querySelector("footer")');
  await ui.evaluate(`(()=>{
    let original=window.fetch;
    window.fetch=async function(url,init){
      let data;try{data=JSON.parse(init?.body)}catch{}
      const isPoll=new URL(String(url)).pathname==='/poll_local_output';
      const gap=window.gapGate;
      if(isPoll&&gap&&data?.id===gap.id)await gap.promise;
      const response=await original.call(this,url,init);
      const gate=window.stopGate;
      if(isPoll){
        const bytes=await response.clone().arrayBuffer();
        if(bytes.byteLength>=4){
          const len=new DataView(bytes).getUint32(0,true);
          const meta=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,len)));
          if(meta.overflow)window.overflowPoll={id:data?.id,exit:meta.exit_code};
          if(meta.exit_code!==null)window.completedPoll={id:data?.id,exit:meta.exit_code};
          if(gate&&data?.id===gate.id&&meta.exit_code===255)await new Promise(resolve=>gate.release=resolve);
        }
      }
      return response;
    };
  })()`);
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('轻量命令行');
  await ui.waitFor('!!document.querySelector(".pane-active .local-terminal:not([hidden]) .xterm-helper-textarea")');
  const light=await selected();
  async function run(item,origin){
    await ui.selectTab(origin);
    const row=`document.querySelector('.pane-active .adb-shortcut-panel:not([hidden]) .adb-shortcut-run[aria-label="${item.name}"]')`;
    if(!await ui.evaluate('!!'+row))await ui.click('快捷指令');
    await ui.waitFor('!!'+row);
    await ui.evaluate(row+'.click()');
    await ui.waitFor(`document.querySelector(".pane-active [role=tab][aria-selected=true]")?.dataset.connectionId!==${JSON.stringify(origin)}`);
    return selected();
  }
  async function stop(item,origin,response){
    const id=await run(item,origin);
    await seen('OWNED_WAIT');
    await pressC();
    await ui.waitFor(`(${rows}??'').includes('Y/N')`);
    assert.equal(await selected(),id);
    const prompt=await ui.evaluate(rows);
    await keyboard.type(response);
    await keyboard.enter();
    return {id,prompt};
  }
  const first=await stop(yes,light,'y');
  if(baseline){
    await seen('255');
    check('Baseline reproduced Ctrl+C then Y, exit 255 retains result',{prompt:first.prompt});
  }else{
    await ui.waitFor('!'+tab(first.id));
    assert.equal(await selected(),light);
    check('Confirmed cmd termination closes and restores lightweight origin',{prompt:first.prompt});
    const denied=await stop(no,light,'n');
    await seen('OWNED_LATER_FAILURE:');
    assert.equal(await selected(),denied.id);
    await keyboard.type('fail');
    await keyboard.enter();
    await seen('255');
    assert.equal(await selected(),denied.id);
    check('N continues and an independent exit 255 retains its result');
    const kept=await stop(unchecked,light,'y');
    await seen('255');
    assert.equal(await selected(),kept.id);
    check('Unchecked manual stop retains its result');
    const keptSuccess=await run(uncheckedSuccess,light);
    await seen('KEEP_SUCCESS:');
    await keyboard.enter();
    await seen('前台进程退出（0）');
    assert.equal(await selected(),keptSuccess);
    check('Unchecked successful exit retains its result');
    const bad=await run(failed,light);
    await seen('255');
    assert.equal(await selected(),bad);
    check('Uninterrupted exit 255 retains its result');
    await ui.selectTab(light);
    await ui.click('本地终端');
    await ui.waitFor('!!document.querySelector(".pane-active .local-terminal[data-mode=powershell]:not([hidden])")');
    const power=await selected();
    const good=await run(success,power);
    await seen('OWNED_SUCCESS:');
    await keyboard.enter();
    await ui.waitFor(`window.completedPoll?.id===${JSON.stringify(good)}&&window.completedPoll.exit===0`);
    await ui.waitFor('!'+tab(good));
    assert.equal(await selected(),power);
    check('Ordinary successful BAT restores its PowerShell origin');
    const back=await run(yes,power);
    await seen('OWNED_WAIT');
    await pressC();
    await ui.waitFor(`(${rows}??'').includes('Y/N')`);
    await ui.evaluate('window.stopGate={id:'+JSON.stringify(back)+'}');
    try{
      await keyboard.key('Y','KeyY',89,{modifiers:8,text:'Y'});
      await keyboard.enter();
      await ui.waitFor('!!window.stopGate.release');
      await ui.selectTab(light);
      await ui.waitFor('document.activeElement?.matches(\'.pane-active .local-terminal:not([hidden]) .xterm-helper-textarea\')');
      await ui.evaluate('window.beforeBackgroundClose=document.activeElement');
      await ui.evaluate('window.stopGate.release();delete window.stopGate');
    }finally{await ui.evaluate('window.stopGate?.release?.();delete window.stopGate');}
    await ui.waitFor('!'+tab(back));
    assert.equal(await selected(),light);
    assert.equal(await ui.evaluate('window.beforeBackgroundClose===document.activeElement'),true);
    check('Late completion closes only its background result and preserves current focus');
    const batch=await run(group,light);
    await seen('127.0.0.1');
    await pressC();
    await ui.waitFor('!'+tab(batch));
    assert.equal(await selected(),light);
    check('The local command group closes only when the worker observes the manual stop');
    const gapped=await run(gap,light);
    await seen('GAP_START:');
    await ui.evaluate('window.gapGate={id:'+JSON.stringify(gapped)+'};window.gapGate.promise=new Promise(resolve=>window.gapGate.release=resolve);true');
    try{
      await keyboard.enter();
      const marker=path.join(root,'gap-ready');
      const deadline=Date.now()+10000;
      while(!await access(marker).then(()=>true,()=>false)){
        assert.ok(Date.now()<deadline,'The BAT did not reach the end of its output burst');
        await delay(100);
      }
    }finally{await ui.evaluate('window.gapGate.release();delete window.gapGate');}
    await ui.waitFor(`window.overflowPoll?.id===${JSON.stringify(gapped)}&&window.overflowPoll.exit===null`);
    await seen('GAP_EXIT:');
    await keyboard.enter();
    await ui.waitFor(`window.completedPoll?.id===${JSON.stringify(gapped)}&&window.completedPoll.exit===0`);
    await seen('前台进程退出');
    assert.equal(await selected(),gapped);
    check('Output overflow on an earlier poll keeps the eventual successful result open');
  }
  result.result='PASS';
}catch(error){
  result.error=String(error.stack??error);
  result.screen=await ui?.evaluate(rows).catch(()=>undefined);
  throw error;
}finally{
  try{await ui?.close();}finally{
    await writeFile(report,JSON.stringify(result,null,2)+'\n');
    assert.equal(path.dirname(root),temp);
    assert.ok(path.basename(root).startsWith('shared-terminal-shortcut-stop-'));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
