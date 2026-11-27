import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';
import {desktopKeyboard} from './lib/DesktopKeyboard.mjs';

const exe=path.resolve(process.argv[2]),report=path.resolve(process.argv[3]);
const baseline=process.argv.includes('--baseline');
const temp=await realpath(tmpdir());
const root=await mkdtemp(path.join(temp,'shared-terminal-adb-console-'));
const evidence={...await desktopEvidence(exe),checks:[],result:'FAIL'};
const q=JSON.stringify;
const active='.pane-active .local-terminal:not([hidden])';
const rendered='document.querySelector('+q(active+' .xterm-rows')+')?.innerText';
const preview='dialog[open][aria-label="本地粘贴确认"]';
const selected='document.querySelector(".pane-active [role=tab][aria-selected=true]")?.dataset.connectionId';
let ui;
const seen=text=>ui.waitFor('('+rendered+'??"").includes('+q(text)+')');
const calls=()=>readFile(path.join(root,'calls.txt'),'utf8');
const mark=name=>{evidence.checks.push(name);console.log(name);};
try{
  const adb=path.join(root,'adb.exe');
  execFileSync('rustc',['--edition=2024','tests/fixtures/local-shortcut.rs','-o',adb],{windowsHide:true,timeout:25000});
  await writeFile(path.join(root,'fixture-root.txt'),'owned');
  await writeFile(path.join(root,'mode.txt'),'interactive-proof');
  process.env.SHORTCUT_FIXTURE_ROOT=root;
  delete process.env.ANDROID_SERIAL;
  const entry={id:randomUUID(),name:'shell',command:'adb -s fixed root\nadb -s fixed shell',desktop_kind:'local',close_on_success:true};
  ui=await launchDesktop(root,{executable:exe,isolatedPowerShell:true,windowsHide:false});
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:adb,shortcuts:[entry]}});
  await ui.command('Page.reload');
  await ui.waitFor('!!document.querySelector(".tools-menu")');
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('轻量命令行');
  await ui.waitFor('!!document.querySelector('+q(active+' textarea')+')');
  const origin=await ui.evaluate(selected);
  await ui.evaluate("window.adbConsole={raw:[],input:[],clipboard:''};"+
    "(()=>{const original=window.fetch;window.fetch=async function(url,init){"+
    "const route=new URL(String(url)).pathname;const fixture=window.adbConsole;"+
    "if(route==='/terminal_clipboard_read')return new Response(JSON.stringify(fixture.clipboard),{headers:{'content-type':'application/json','Tauri-Response':'ok'}});"+
    "if(route==='/local_terminal'){const a=JSON.parse(init.body).action;if(a.kind==='input')fixture.input.push(a);}"+
    "const response=await original.call(this,url,init);"+
    "if(route==='/poll_local_output'){const data=await response.clone().arrayBuffer();if(data.byteLength>=4){const n=new DataView(data).getUint32(0,true);"+
    "fixture.raw.push(new TextDecoder().decode(new Uint8Array(data,4+n)));}}return response;};})()");
  if(!await ui.evaluate('!!document.querySelector(".adb-shortcut-panel:not([hidden]) .adb-shortcut-run")'))await ui.click('快捷指令');
  const keys=desktopKeyboard(ui,[]);
  const pressC=()=>keys.key('c','KeyC',67,{modifiers:2});
  const insert=text=>ui.command('Input.insertText',{text});
  const pressPaste=()=>keys.key('v','KeyV',86,{modifiers:10});
  async function start(){
    await ui.click('shell');
    await seen('proof:/ #');
    await ui.waitFor('document.activeElement?.matches('+q(active+' textarea')+')');
    return ui.evaluate(selected);
  }
  async function paste(text){
    await ui.evaluate('window.adbConsole.clipboard='+q(text));
    await pressPaste();
    await ui.waitFor('!!document.querySelector('+q(preview)+')');
    const body=await ui.evaluate('document.querySelector('+q(preview+' pre')+')?.textContent');
    await keys.enter();
    await ui.waitFor('!document.querySelector('+q(preview)+')');
    return body;
  }
  const id=await start();
  assert.notEqual(id,origin);
  const startup=await ui.evaluate(rendered);
  if(baseline){
    const clipboard='echo FIRST\necho SECOND\n';
    const body=await paste(clipboard);
    for(let attempt=0;attempt<50;attempt++){
      if((await calls()).includes('proof-line|echo SECOND'))break;
      await delay(40);
    }
    await seen('RESULT_SECOND');
    const normal=await ui.evaluate(rendered);
    await insert('redraw');await keys.enter();
    await seen('OWNED_PTY_REDRAW');
    evidence.baseline={startup,body,normal,screen:await ui.evaluate(rendered),calls:await calls(),
      raw:await ui.evaluate('window.adbConsole.raw'),input:await ui.evaluate('window.adbConsole.input')};
    assert.ok(evidence.baseline.calls.includes('proof-line|echo FIRST'));
    assert.ok(evidence.baseline.calls.includes('proof-line|echo SECOND'));
    assert.ok(evidence.baseline.raw.some(chunk=>chunk.includes('\x1b[H')));
    assert.ok(evidence.baseline.screen.indexOf('OWNED_PTY_REDRAW')<evidence.baseline.screen.indexOf('adb -s fixed root'));
    await pressC();
    await ui.waitFor('!document.querySelector('+q('[role=tab][data-connection-id="'+id+'"]')+')');
    assert.ok(!(await calls()).includes('proof-unit|03'));
    mark('Baseline sent original LF lines but the application intercepted Ctrl+C and closed its checked result');
  }
  evidence.result='PASS';
}catch(error){
  evidence.error=String(error.stack??error);
  if(ui){
    evidence.screen=await ui.evaluate(rendered).catch(()=>undefined);
    evidence.raw=await ui.evaluate('window.adbConsole').catch(()=>undefined);
  }
  evidence.calls=await calls().catch(()=>undefined);
  throw error;
}finally{
  try{await ui?.close();}
  finally{
    await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
    assert.equal(path.dirname(root),temp);
    assert.ok(path.basename(root).startsWith('shared-terminal-adb-console-'));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
