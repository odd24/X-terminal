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
    "function global:prompt { 'PS Q> ' }",
    "Set-PSReadLineKeyHandler -Chord Ctrl+l -Function ClearScreen",
    "Set-PSReadLineKeyHandler -Chord Ctrl+g -ScriptBlock { $line=''; $cursor=0; "+
      '[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor); '+
      '[IO.File]::WriteAllText('+ps(snapshot)+',(@{line=$line;cursor=$cursor;cols=[Console]::BufferWidth}|ConvertTo-Json -Compress)) }',
    "function global:Write-OwnedSample { Add-Content -LiteralPath "+ps(ran)+" -Value 'ran'; 'attached LT6911_VIDEO' }",
  ].join('; ');
  const content="Write-OwnedSample 'synthetic device event and long ASCII value' |\n  Select-String 'attached|detached|lt6911_info|LT6911_VIDEO'";
  const count=kind=>ui.evaluate('window.pasteFixture.actions.filter(a=>a.kind==='+q(kind)+').length');
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
    "(()=>{const original=window.fetch;window.fetch=function(url,init){"+
    "const command=new URL(String(url)).pathname;"+
    "if(command==='/terminal_clipboard_read')return Promise.resolve(new Response(JSON.stringify(window.pasteFixture.text),{headers:{'content-type':'application/json','Tauri-Response':'ok'}}));"+
    "if(command==='/local_terminal')try{window.pasteFixture.actions.push(JSON.parse(init.body).action);}catch{}"+
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
    await keys.enter();
    await closed();
    await ui.waitFor(focus);
    await seen('Select-String');
    assert.equal(await count('input'),before);
    const actual=await buffer();
    assert.deepEqual({line:actual.line,cursor:actual.cursor},{line:content,cursor:content.length});
    assert.equal(await readFile(ran,'utf8').catch(()=>''),'');
    await keys.enter();
    await seen('attached LT6911_VIDEO');
    assert.deepEqual((await readFile(ran,'utf8')).trim().split(/\r?\n/),['ran']);
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
