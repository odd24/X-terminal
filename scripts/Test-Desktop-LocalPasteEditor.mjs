import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay, desktopEvidence, launchDesktop} from './lib/DesktopHarness.mjs';
import {desktopKeyboard} from './lib/DesktopKeyboard.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const baseline=process.argv.includes('--baseline');
const temp=await realpath(tmpdir());
const root=await mkdtemp(path.join(temp,'shared-terminal-paste-editor-'));
const evidence={...await desktopEvidence(executable),checks:[],result:'FAIL'};
const q=JSON.stringify;
const shell='.pane-active .local-terminal:not([hidden])';
const textarea=shell+' .xterm-helper-textarea';
const dialog='dialog[open][aria-label="本地粘贴确认"]';
const selected='document.querySelector(".pane-active [role=tab][aria-selected=true]")?.dataset.connectionId';
const by=selector=>'document.querySelector('+q(selector)+')';
const focus='document.activeElement?.matches('+q(textarea)+')';
let ui;
try{
  ui=await launchDesktop(root,{executable,isolatedPowerShell:true,windowsHide:false});
  const keys=desktopKeyboard(ui,[]);
  const ctrl=(key,code)=>keys.key(key,'Key'+key.toUpperCase(),code,{modifiers:2});
  const pasteKey=()=>keys.key('v','KeyV',86,{modifiers:10});
  const insert=text=>ui.command('Input.insertText',{text});
  const output=by(shell+' .xterm-rows')+'?.textContent';
  const seen=text=>ui.waitFor('('+output+'??"").includes('+q(text)+')');
  const preview=()=>ui.waitFor('!!'+by(dialog));
  const closed=()=>ui.waitFor('!'+by(dialog));
  const action=text=>ui.evaluate('window.pasteFixture.text='+q(text));
  const activeButton=()=>ui.evaluate('document.activeElement?.textContent');
  const file=name=>path.join(root,name);
  const ps=text=>"'"+text.replaceAll("'","''")+"'";
  const snapshot=file('buffer.json');
  const ran=file('executed.txt');
  const setup=[
    'Set-Location -LiteralPath '+ps(root),
    "function global:prompt { 'PS Q> ' }",
    "Set-PSReadLineKeyHandler -Chord Ctrl+l -Function ClearScreen",
    "Set-PSReadLineKeyHandler -Chord Ctrl+g -ScriptBlock { $line=''; $cursor=0; "+
      '[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor); '+
      '[IO.File]::WriteAllText('+ps(snapshot)+',(@{line=$line;cursor=$cursor;cols=[Console]::BufferWidth}|ConvertTo-Json -Compress)) }',
    "function global:Write-OwnedSample { Add-Content -LiteralPath "+ps(ran)+" -Value 'ran'; 'attached LT6911_VIDEO' }",
  ].join('; ');
  const content="Write-OwnedSample 'synthetic device event and long ASCII value' |\n  Select-String 'attached|detached|lt6911_info|LT6911_VIDEO'";
  const applyCount=()=>count('power_shell_paste');
  const count=kind=>ui.evaluate('window.pasteFixture.actions.filter(a=>a.kind==='+q(kind)+').length');
  async function waitFile(filename){
    for(let i=0;i<100;i++){
      const text=await readFile(filename,'utf8').catch(()=> '');
      if(text)return text;
      await delay(40);
    }
    assert.fail('The owned output file did not appear: '+path.basename(filename));
  }
  async function buffer(){
    await rm(snapshot,{force:true});
    await ctrl('g',71);
    for(let i=0;i<100;i++){
      try{return JSON.parse(await readFile(snapshot,'utf8'));}catch{await delay(40);}
    }
    assert.fail('The owned PSReadLine buffer probe did not respond');
  }
  async function openPaste(text){
    await action(text);
    await pasteKey();
    await preview();
  }
  async function recorded(name,details={}){
    evidence.checks.push({name,...details});
    console.log(name);
  }
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('本地终端');
  await seen('SHARED_TERMINAL_ISOLATED_POWERSHELL_READY');
  await ui.waitFor(focus);
  const shellId=await ui.evaluate(selected);
  await ui.evaluate("window.pasteFixture={text:'',actions:[]};"+
    "(()=>{const original=window.fetch;window.fetch=async function(url,init){"+
    "const command=new URL(String(url)).pathname;"+
    "if(command==='/terminal_clipboard_read')return Promise.resolve(new Response(JSON.stringify(window.pasteFixture.text),{headers:{'content-type':'application/json','Tauri-Response':'ok'}}));"+
    "if(command==='/local_terminal'){const fixture=window.pasteFixture;const action=JSON.parse(init.body).action;fixture.actions.push(action);"+
    "if(action.kind==='power_shell_paste'&&fixture.hold)await new Promise(resolve=>fixture.release=resolve);}"+
    "return original.call(this,url,init);};})()");
  await insert(setup);
  await keys.enter();
  await seen('PS Q>');
  assert.equal((await buffer()).line,'');
  await openPaste(content);
  if(baseline){
    assert.equal(await activeButton(),'取消粘贴');
    await ui.click('确认粘贴');
    await closed();
    await seen('Select-String');
    const screen=await ui.evaluate(by(shell+' .xterm-rows')+'?.innerText');
    const observed=await buffer();
    assert.ok(screen.includes('Write-OwnedSample'));
    assert.ok(screen.includes('Select-String'));
    await recorded('Baseline defaulted to cancel and sent multiline clipboard as terminal input',
      {screen,buffer:observed,rawInput:await ui.evaluate('window.pasteFixture.actions.filter(a=>a.kind==="input").at(-2)?.text')});
  }else{
    assert.equal(await activeButton(),'确认粘贴');
    const before=await count('input');
    const enterEvent={key:'Enter',code:'Enter',windowsVirtualKeyCode:13};
    await ui.command('Input.dispatchKeyEvent',{type:'keyDown',text:'\r',...enterEvent});
    await ui.command('Input.dispatchKeyEvent',{type:'keyDown',text:'\r',autoRepeat:true,...enterEvent});
    assert.equal(await applyCount(),0);
    assert.equal(await activeButton(),'确认粘贴');
    await ui.command('Input.dispatchKeyEvent',{type:'keyUp',...enterEvent});
    await closed();
    await ui.waitFor(focus);
    await seen('Select-String');
    assert.equal(await count('input'),before);
    assert.equal(await applyCount(),1);
    const actual=await buffer();
    assert.deepEqual({line:actual.line,cursor:actual.cursor},{line:content,cursor:content.length});
    assert.equal(await readFile(ran,'utf8').catch(()=>''),'');
    await keys.enter();
    assert.deepEqual((await waitFile(ran)).trim().split(/\r?\n/),['ran']);
    await recorded('Enter confirms once, keeps LF as an editable pipeline, and only the next Enter executes it');
    await openPaste(content);
    await keys.key('Escape','Escape',27);
    await closed();
    await ui.waitFor(focus);
    assert.equal((await buffer()).line,'');
    await openPaste(content);
    await keys.key('Tab','Tab',9);
    assert.equal(await activeButton(),'取消粘贴');
    await keys.enter();
    await closed();
    await ui.waitFor(focus);
    assert.equal((await buffer()).line,'');
    assert.equal(await ui.evaluate(selected),shellId);
    await recorded('Escape and Tab then Enter cancel with focus restored and an unchanged draft');
    const userDraft="adb shell 'su 0 timeout 30 strace -f -s 4096 -e trace=recvmsg,recvfrom -p $(pidof ueventd) 2>&1' |\n  Select-String 'attached|detached|lt6911_info|LT6911_VIDEO'";
    await openPaste(userDraft);
    await keys.enter();
    await closed();
    const userBuffer=await buffer();
    assert.equal(userBuffer.line,userDraft);
    assert.equal(userBuffer.cursor,userDraft.length);
    await ctrl('c',67);
    assert.equal((await buffer()).line,'');
    await recorded('The reported two-line text retains both lines and indentation as a draft and is then discarded');

    await ui.evaluate("(()=>{const host="+by(shell+' .local-terminal-output')+"; "+
      "for(let f=host[Object.keys(host).find(k=>k.startsWith('__reactFiber'))];f;f=f.return)"+
      "for(let h=f.memoizedState;h;h=h.next){const term=h.memoizedState?.current;"+
      "if(term?.buffer?.active&&term?.onWriteParsed&&term?.element){window.ownedPasteTerm=term;return}}"+
      "throw new Error('Owned terminal not found')})()");
    await ui.evaluate("(()=>{const term=window.ownedPasteTerm,host="+by(shell+' .local-terminal-output')+";"+
      "const cell=term.element.querySelector('.xterm-screen').getBoundingClientRect().width/term.cols;"+
      "host.style.width=Math.ceil(53*cell+1)+'px';})()");
    await ui.waitFor('window.ownedPasteTerm.cols>=50&&window.ownedPasteTerm.cols<=55');
    const prefix='BEFORE ';
    const suffix=' AFTER';
    await ctrl('l',76);
    await insert(prefix+suffix);
    for(let i=0;i<suffix.length;i++)await keys.key('ArrowLeft','ArrowLeft',37);
    const draft=await buffer();
    assert.equal(draft.line,prefix+suffix);
    assert.equal(draft.cursor,prefix.length);
    await ui.evaluate("(()=>{const b=window.ownedPasteTerm.buffer.active;window.pasteAnchor=b.baseY+b.cursorY})()");
    await openPaste(content.replaceAll('\n','\r\n'));
    await keys.enter();
    await closed();
    const middle=await buffer();
    assert.deepEqual({line:middle.line,cursor:middle.cursor},{line:prefix+content+suffix,cursor:prefix.length+content.length});
    await ui.waitFor("(()=>{const b=window.ownedPasteTerm.buffer.active;const rows=[];let wrapped=0;"+
      "for(let i=window.pasteAnchor;i<=b.baseY+b.cursorY;i++){const line=b.getLine(i);"+
      "if(line.isWrapped&&rows.length){rows[rows.length-1]+=line.translateToString(false);wrapped++;}"+
      "else rows.push(line.translateToString(false));}"+
      "return wrapped>=2&&rows[0]?.trimEnd()==="+q('PS Q> '+prefix+content.split('\n')[0])+
      "&&rows[1]?.trimEnd()==="+q('>> '+content.split('\n')[1]+suffix)+"})()");
    await insert('x');
    assert.equal((await buffer()).line,prefix+content+'x'+suffix);
    assert.deepEqual((await readFile(ran,'utf8')).trim().split(/\r?\n/),['ran']);
    await recorded('CRLF at a narrow terminal preserves indentation, soft wraps, prefix, suffix, and the insertion cursor',{cols:middle.cols});
    await ctrl('c',67);
    assert.equal((await buffer()).line,'');

    await openPaste(content);
    const terminalWrites=await count('input');
    await ui.evaluate('window.pasteFixture.hold=true');
    await keys.enter();
    await ui.waitFor('!!window.pasteFixture.release');
    await closed();
    const held=await ui.evaluate('window.pasteFixture.actions.filter(a=>a.kind==="power_shell_paste").at(-1)');
    try{
      await ui.invoke('local_terminal',{action:{kind:'input',id:held.id,request:held.request,text:'\x03'}});
      await ui.waitFor("window.__TAURI_INTERNALS__.invoke('local_terminal',{action:"+
        q({kind:'power_shell_paste_epoch',id:held.id,request:held.request})+"}).then(value=>value&&value!=="+held.generation+")");
    }finally{await ui.evaluate('window.pasteFixture.hold=false;window.pasteFixture.release();delete window.pasteFixture.release');}
    await ui.waitFor("document.querySelector('.pane-active .local-terminal [role=alert]')?.textContent.includes('编辑目标已变化')");
    assert.equal(await count('input'),terminalWrites+1);
    assert.equal((await buffer()).line,'');
    await recorded('An elapsed editor generation rejects the original paste without falling back to terminal input');

    const appResult=file('app.txt');
    const foreground="[Console]::WriteLine('OWNED_FOREGROUND_WAIT'); "+
      "$a=[Console]::ReadLine(); $b=[Console]::ReadLine(); [IO.File]::WriteAllText("+ps(appResult)+",$a+'|'+$b);"+
      "[Console]::WriteLine('OWNED_FOREGROUND_DONE')";
    await insert(foreground);
    await keys.enter();
    await seen('OWNED_FOREGROUND_WAIT');
    await ui.waitFor("window.__TAURI_INTERNALS__.invoke('local_terminal',{action:"+
      q({kind:'power_shell_paste_epoch',id:held.id,request:held.request})+"}).then(value=>value===0)");
    const raw='owned one\rowned two\r';
    await openPaste(raw);
    assert.equal(await activeButton(),'确认粘贴');
    await keys.enter();
    await closed();
    await seen('OWNED_FOREGROUND_DONE');
    const foregroundRequest=await ui.evaluate('window.pasteFixture.actions.filter(a=>a.kind==="power_shell_paste").at(-1)');
    assert.equal(foregroundRequest.generation,0);
    assert.equal(foregroundRequest.text,raw);
    assert.equal(await waitFile(appResult),'owned one|owned two');
    await recorded('A live foreground reader receives its original CR bytes');

    await insert("[Console]::WriteLine('OWNED_STALE_WAIT'); [void][Console]::ReadLine()");
    await keys.enter();
    await seen('OWNED_STALE_WAIT');
    const epochCheck="window.__TAURI_INTERNALS__.invoke('local_terminal',{action:"+
      q({kind:'power_shell_paste_epoch',id:held.id,request:held.request})+"})";
    await ui.waitFor(epochCheck+'.then(value=>value===0)');
    await openPaste('foreground only\r');
    await ui.evaluate('window.pasteFixture.hold=true');
    await keys.enter();
    await ui.waitFor('!!window.pasteFixture.release');
    try{
      await ui.invoke('local_terminal',{action:{kind:'input',id:held.id,request:held.request,text:'\r'}});
      await ui.waitFor(epochCheck+'.then(value=>value>0)');
    }finally{await ui.evaluate('window.pasteFixture.hold=false;window.pasteFixture.release();delete window.pasteFixture.release');}
    await ui.waitFor("document.querySelector('.pane-active .local-terminal [role=alert]')?.textContent.includes('前台输入目标已变化')");
    assert.equal((await buffer()).line,'');
    await recorded('A retired foreground reader cannot deliver its confirmed bytes to the next editor');

    await ui.evaluate("document.querySelector('.tools-menu').open=true");
    await ui.click('轻量命令行');
    await ui.waitFor(focus);
    await openPaste('pwd\ncd\n');
    assert.equal(await activeButton(),'取消粘贴');
    assert.equal(await ui.evaluate(by(dialog+' button:disabled')+'?.textContent'),'确认粘贴');
    await keys.enter();
    await closed();
    await ui.waitFor(focus);
    const runs=await count('run');
    await openPaste('pwd\r\n');
    assert.equal(await activeButton(),'确认粘贴');
    await keys.enter();
    await closed();
    await seen('pwd');
    assert.equal(await count('run'),runs);
    await keys.enter();
    await ui.waitFor('window.pasteFixture.actions.filter(a=>a.kind==="run").length==='+(runs+1));
    await recorded('Unsupported paste defaults to cancel, and a lightweight trailing CRLF leaves an editable single line');
  }
  evidence.result='PASS';
}catch(error){
  evidence.error=String(error.stack??error);
  evidence.screen=await ui?.evaluate(by(shell+' .xterm-rows')+'?.innerText').catch(()=>undefined);
  throw error;
}finally{
  try{await ui?.close();}finally{
    await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
    assert.equal(path.dirname(root),temp);
    assert.ok(path.basename(root).startsWith('shared-terminal-paste-editor-'));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
