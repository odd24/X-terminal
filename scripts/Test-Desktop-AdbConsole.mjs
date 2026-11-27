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
    const caption=await ui.evaluate('document.querySelector('+q(preview)+')?.innerText');
    await keys.enter();
    await ui.waitFor('!document.querySelector('+q(preview)+')');
    return {body,caption};
  }
  const id=await start();
  assert.notEqual(id,origin);
  const startup=await ui.evaluate(rendered);
  if(baseline){
    const clipboard='echo FIRST\necho SECOND\n';
    const {body}=await paste(clipboard);
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
  }else{
    const lines=async()=> (await calls()).split(/\r?\n/).filter(line=>line.startsWith('proof-line|')).map(line=>line.slice(11));
    const units=async()=> (await calls()).split(/\r?\n/).filter(line=>line.startsWith('proof-unit|')).map(line=>line.slice(11));
    async function waitRead(read,expected){
      for(let retry=0;retry<120;retry++){
        const value=await read();
        if(value.length>=expected)return value;
        await delay(40);
      }
      throw new Error('Owned ADB console input did not reach the expected count');
    }
    async function type(text){
      await ui.waitFor('document.activeElement?.matches('+q(active+' textarea')+')');
      for(const character of text){
        if(character===' ')await keys.key(' ','Space',32,{text:' '});
        else await keys.type(character);
      }
    }
    const command=async text=>{await type(text);await keys.enter();};
    const cases=[];
    for(const separator of ['\n','\r\n']){
      for(const trailing of [false,true]){
        const clipboard='echo FIRST'+separator+'echo SECOND'+(trailing?separator:'');
        const normalized=clipboard.replaceAll('\r\n','\n');
        const n=(await lines()).length, u=(await units()).length;
        const writes=await ui.evaluate('window.adbConsole.input.length');
        const {body,caption}=await paste(clipboard);
        assert.equal(body,normalized);
        assert.ok(caption.includes('行间换行可能执行上一条命令'));
        assert.ok(caption.includes(trailing?'原文末尾有换行':'原文末尾无换行'));
        const received=await waitRead(units,u+normalized.length);
        assert.deepEqual(received.slice(u),Array.from(Buffer.from(normalized),n=>n.toString(16).padStart(2,'0')));
        await waitRead(lines,n+(trailing?2:1));
        assert.deepEqual((await lines()).slice(n),trailing?['echo FIRST','echo SECOND']:['echo FIRST']);
        const outgoing=await ui.evaluate('window.adbConsole.input.slice('+writes+')');
        assert.deepEqual(outgoing.map(item=>[item.id,item.text,item.adb_shell_only]),[[id,normalized,true]]);
        if(!trailing){
          await keys.enter();
          await waitRead(lines,n+2);
          assert.deepEqual((await lines()).slice(n),['echo FIRST','echo SECOND']);
        }
        cases.push({separator:separator==='\n'?'LF':'CRLF',trailing,bytes:received.slice(u)});
      }
    }
    evidence.pasteCases=cases;
    mark('Four LF/CRLF and trailing-line cases send one ordered payload, and explicit Enter is required for the unfinished line');

    const transcript=await ui.evaluate("(()=>{const host=document.querySelector("+q(active+' .local-terminal-output')+");"+
      "for(let f=host[Object.keys(host).find(k=>k.startsWith('__reactFiber'))];f;f=f.return)"+
      "for(let h=f.memoizedState;h;h=h.next){const candidate=h.memoizedState?.current;"+
      "if(candidate?.buffer?.active&&candidate?.element){window.consoleTerm=candidate;return true}}return false})()");
    assert.equal(transcript,true);
    const history=()=>ui.evaluate("(()=>{const b=window.consoleTerm.buffer.active;"+
      "return Array.from({length:b.baseY},(_,i)=>b.getLine(i).translateToString(true)).join('\\n')})()");
    const beforeRedraw=await history();
    assert.ok(beforeRedraw.includes('adb -s fixed root'));
    assert.ok(beforeRedraw.indexOf('adb -s fixed root')<beforeRedraw.indexOf('adb -s fixed shell'));
    await command('redraw');
    await seen('OWNED_PTY_REDRAW');
    assert.equal(await history(),beforeRedraw);
    assert.ok((await ui.evaluate(rendered)).startsWith('OWNED_PTY_REDRAW'));
    assert.ok((await ui.evaluate('window.adbConsole.raw')).some(chunk=>chunk.includes('\x1b[H')));
    mark('A native absolute redraw changes only the shell viewport and preserves the startup transcript in scrollback');

    const instance=Number((await calls()).match(/proof-instance\|(\d+)/)?.[1]);
    assert.ok(instance>0);
    let interrupts=(await units()).filter(unit=>unit==='03').length;
    async function interrupt(){
      await pressC();interrupts++;
      for(let retry=0;retry<100;retry++){
        if((await units()).filter(unit=>unit==='03').length===interrupts)break;
        await delay(40);
      }
      assert.equal((await units()).filter(unit=>unit==='03').length,interrupts);
      assert.equal(await ui.evaluate(selected),id);
    }
    await interrupt();
    await type('echo discarded-draft');
    await seen('echo discarded-draft');
    await interrupt();
    const from=(await lines()).length;
    await command('identity');await seen('IDENTITY_'+instance);
    assert.deepEqual((await waitRead(lines,from+1)).slice(from),['identity']);
    await command('sleep 20');await seen('OWNED_SLEEP_STARTED');
    await interrupt();await seen('OWNED_SLEEP_INTERRUPTED');
    const next=(await lines()).length;
    await command('identity');
    assert.deepEqual((await waitRead(lines,next+1)).slice(next),['identity']);
    assert.deepEqual((await calls()).match(/proof-instance\|\d+/g),['proof-instance|'+instance]);
    assert.equal((await calls()).includes('proof-line|echo discarded-draft'),false);
    assert.equal((await ui.evaluate(rendered)).includes('OWNED_SLEEP_FINISHED'),false);
    const controlInputs=await ui.evaluate("window.adbConsole.input.filter(action=>action.text===String.fromCharCode(3))");
    assert.deepEqual(controlInputs.map(action=>[action.id,action.adb_shell_only]),Array(3).fill([id,true]));
    mark('Ctrl+C reaches the same live console at its prompt, with a partial line, and during an interruptible foreground job');

    await command('exit');
    await ui.waitFor('!document.querySelector('+q('[role=tab][data-connection-id="'+id+'"]')+')');
    assert.equal(await ui.evaluate(selected),origin);
    const disconnected=await start();
    const original=await ui.evaluate('window.adbConsole.input.find(item=>item.adb_shell_only)');
    await assert.rejects(ui.invoke('local_terminal',{action:{...original,id:disconnected,text:'echo WRONG_TARGET\n'}}),/任务已变化/);
    assert.equal((await calls()).includes('proof-line|echo WRONG_TARGET'),false);
    await command('disconnect');
    await seen('fixture: original transport disconnected');
    await seen('ADB 交互终端退出码 255');
    await seen('前台进程退出（255）');
    assert.equal(await ui.evaluate(selected),disconnected);
    mark('Explicit exit closes a checked result, a stale task cannot send to the new shell, and unexpected disconnect preserves its reason');
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
