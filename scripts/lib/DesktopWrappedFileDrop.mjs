import assert from 'node:assert/strict';
import {readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {delay} from './DesktopHarness.mjs';

const literal=value=>"'"+value.replace(/['‘’‚‛]/g,match=>match+match)+"'";
const prefix='adb install ';
const prompt='PS Q> ';
const at=selector=>'document.querySelector('+JSON.stringify(selector)+')';

export async function verifyWrappedDrop({ui,root,shell,key,type,enter,nativeDrop,record,evidence}){
  const output=shell+' .local-terminal-output';
  const bufferFile=path.join(root,'edit-buffer.json');
  const executionFile=path.join(root,'unexpected-execution.txt');
  const setup=[
    `function global:prompt { ${literal(prompt)} }`,
    `function global:adb { [IO.File]::WriteAllText(${literal(executionFile)},'unexpected command') }`,
    'Set-PSReadLineKeyHandler -Chord Ctrl+l -Function ClearScreen',
    "Set-PSReadLineKeyHandler -Chord Ctrl+g -ScriptBlock { $line=''; $cursor=0; "+
      '[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor); '+
      '$editor=[Microsoft.PowerShell.PSConsoleReadLine].Assembly.GetCustomAttributes([System.Reflection.AssemblyInformationalVersionAttribute],$false)[0]; '+
      '$sample=@{line=$line;cursor=$cursor;cols=[Console]::BufferWidth;editor=$editor.InformationalVersion;history=(Get-PSReadLineOption).HistorySaveStyle.ToString()}; '+
      `[IO.File]::WriteAllText(${literal(bufferFile)},($sample|ConvertTo-Json -Compress)) }`,
  ].join('; ');
  await type(setup);
  await enter();
  await ui.waitFor(at(output)+'?.innerText.includes('+JSON.stringify(prompt.trimEnd())+')');
  async function buffer(){
    await rm(bufferFile,{force:true});
    await key('g','KeyG',71,2);
    for(let retry=0;retry<120;retry++){
      try{return JSON.parse(await readFile(bufferFile,'utf8'));}catch{await delay(35);}
    }
    throw new Error('PSReadLine did not report the owned edit buffer');
  }
  const initial=await buffer();
  assert.equal(initial.history,'SaveNothing');
  assert.equal(initial.editor,'2.0.0+shared-terminal');
  record('The isolated shell started with the 2.0 editor backport and disabled history saving',
    {editor:initial.editor,history:initial.history});
  await ui.evaluate(`(async()=>{
    const host=${at(output)};
    let term;
    for(let f=host[Object.keys(host).find(key=>key.startsWith('__reactFiber'))];f&&!term;f=f.return){
      for(let h=f.memoizedState;h;h=h.next){
        const current=h.memoizedState?.current;
        if(current?.buffer?.active&&current?.onWriteParsed&&current?.element){term=current;break;}
      }
    }
    if(!term)throw Error('Owned PowerShell terminal was not located');
    const probe={term,events:0,raw:[],anchor:0};
    window.wrappedDropProbe=probe;
    const write=term.write.bind(term), decoder=new TextDecoder();
    term.write=(value,callback)=>{probe.raw.push(typeof value==='string'?value:decoder.decode(value));return write(value,callback);};
    const ipc=window.__TAURI_INTERNALS__;
    await ipc.invoke('plugin:event|listen',{event:'tauri://drag-drop',target:{kind:'Any'},handler:ipc.transformCallback(()=>probe.events++)});
  })()`);

  async function columns(cols){
    await ui.evaluate(`(()=>{const host=${at(output)},term=window.wrappedDropProbe.term;
      const cell=term.element.querySelector('.xterm-screen').getBoundingClientRect().width/term.cols;
      host.style.width=Math.ceil(${cols}*cell+1)+'px';
    })()`);
    for(let attempt=0;attempt<8;attempt++){
      await delay(180);
      const seen=await ui.evaluate('window.wrappedDropProbe.term.cols');
      if(seen===cols)return;
      await ui.evaluate(`${at(output)}.style.width=(parseInt(${at(output)}.style.width,10)+Math.sign(${cols}-${seen})*8)+'px'`);
    }
    throw new Error('Could not fit the owned terminal to '+cols+' columns');
  }
  async function start(draft){
    await key('c','KeyC',67,2);
    await delay(140);
    await key('l','KeyL',76,2);
    await type(draft);
    await delay(170);
    const initial=await buffer();
    assert.equal(initial.line,draft);
    await ui.evaluate(`(()=>{const p=window.wrappedDropProbe,b=p.term.buffer.active;
      p.anchor=b.baseY+b.cursorY; p.events=0;p.raw=[];window.fileDropReceipt.length=0;
    })()`);
    return initial;
  }
  async function visible(){
    return ui.evaluate(`(()=>{
      const p=window.wrappedDropProbe,b=p.term.buffer.active,rows=[];
      for(let i=p.anchor;i<b.length;i++){
        const l=b.getLine(i);rows.push({full:l.translateToString(false),text:l.translateToString(true),wrapped:l.isWrapped});
      }
      while(rows.at(-1)?.text==='')rows.pop();
      return {text:rows.map((row,i)=>i===rows.length-1?row.text:row.full).join(''),
        wrap:rows.filter(row=>row.wrapped).length,events:p.events,raw:p.raw.join(''),receipts:window.fileDropReceipt};
    })()`);
  }
  async function create(label,total){
    const head=label+' ';
    const filler=total-root.length-1-head.length-'.apk'.length;
    assert.ok(filler>=0);
    const filename=path.join(root,head+'x'.repeat(filler)+'.apk');
    await writeFile(filename,'owned synthetic APK');
    return filename;
  }
  async function caseDrop({name,cols,paths,before=prefix,offset=before.length,wanted,cursor}){
    await columns(cols);
    assert.equal((await start(before)).cols,cols);
    for(let count=offset;count<before.length;count++)await key('ArrowLeft','ArrowLeft',37);
    const native=await nativeDrop(output,paths);
    await ui.waitFor('window.fileDropReceipt.length===1');
    await delay(280);
    const drawn=await visible();
    const current=await buffer();
    const vtText=drawn.raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\r\n]/g,'');
    const vtCopies=paths.map(file=>vtText.split(literal(path.basename(file)).slice(1,-1)).length-1);
    assert.equal(drawn.text,prompt+wanted,name);
    assert.equal(drawn.events,1,name);
    assert.deepEqual(drawn.receipts,[[200,'null']],name);
    assert.equal(current.line,wanted,name);
    assert.equal(current.cursor,cursor,name);
    assert.equal(current.cols,cols,name);
    assert.deepEqual(vtCopies,paths.map(()=>1),name);
    assert.equal(await readFile(executionFile,'utf8').catch(()=>''),'',name);
    assert.ok(drawn.wrap>0,name);
    if(name==='Long path wraps once at 65 columns'){
      const screenshot=await ui.command('Page.captureScreenshot',{format:'png'});
      await writeFile(path.join(evidence,'wrapped-65-columns.png'),Buffer.from(screenshot.data,'base64'));
    }
    record(name,{native,cols,lines:drawn.wrap+1,cursor,oleEvents:drawn.events,receipts:drawn.receipts.length,length:current.line.length,vtCopies});
  }
  try{
    const long=await create('LONG PATH',235);
    for(const cols of [65,96]){
      const expected=prefix+literal(long);
      await caseDrop({name:`Long path wraps once at ${cols} columns`,cols,paths:[long],wanted:expected,cursor:expected.length});
    }
    const boundary=await create('EXACT EDGE',65*3-prompt.length-prefix.length-2);
    const atEdge=prefix+literal(boundary);
    assert.equal((prompt+atEdge).length,195);
    await caseDrop({name:'Exact wrap boundary keeps one draft and its end cursor',cols:65,paths:[boundary],wanted:atEdge,cursor:atEdge.length});
    const second=path.join(root,"SECOND ' 文件.apk");
    await writeFile(second,'owned second fixture');
    const suffix="'TAIL'";
    const middle=prefix+literal(long)+' '+literal(second)+' ';
    await caseDrop({name:'Multiple paths at a middle cursor keep the original suffix',cols:65,paths:[long,second],before:prefix+suffix,offset:prefix.length,wanted:middle+suffix,cursor:middle.length});
    await type('x');
    const typed=await buffer();
    assert.equal(typed.line,middle+'x'+suffix);
    assert.equal(typed.cursor,middle.length+1);
    record('Ordinary typed input after the drop follows the preserved cursor');

    await start('& ');
    await nativeDrop(output,[long]);
    await ui.waitFor('window.fileDropReceipt.length===1');
    assert.equal((await buffer()).line,'& ');
    assert.notEqual((await visible()).receipts[0]?.[1],'null');
    record('An invocation operator alone cannot turn a dropped path into a command');

    await start(prefix);
    await ui.evaluate('window.fileDropPreflight={hold:true}');
    try {
      await nativeDrop(output,[long]);
      await ui.waitFor('!!window.fileDropPreflight.release');
      const retired=await ui.evaluate('window.fileDropPreflight.action');
      assert.equal((await visible()).text.trimEnd(),(prompt+prefix).trimEnd());
      await ui.invoke('local_terminal',{action:{kind:'input',id:retired.id,request:retired.request,text:'\x03'}});
      await ui.waitFor(`window.__TAURI_INTERNALS__.invoke('local_terminal',{action:${JSON.stringify({
        kind:'file_drop_epoch',id:retired.id,request:retired.request,
      })}}).then(next=>next&&next!==${retired.generation})`);
      await ui.evaluate('window.fileDropPreflight.hold=false;window.fileDropPreflight.release()');
      await ui.waitFor('window.fileDropReceipt.length===1');
      assert.equal((await buffer()).line,'');
      assert.notEqual((await visible()).receipts[0]?.[1],'null');
      record('A delayed drop to a replaced editor generation leaves the new draft empty');
    } finally {
      await ui.evaluate('window.fileDropPreflight?.release?.();delete window.fileDropPreflight');
    }

    await start(prefix);
    const lost=await ui.interceptIpc({command:'local_terminal',op:'file_drop',mode:'hold_error'});
    try {
      await nativeDrop(output,[long]);
      await ui.waitFor('window.__desktopIpcResponseTest.count===1');
      await lost.release();
      await ui.waitFor('window.fileDropReceipt.length===1');
      await delay(420);
      assert.equal(await lost.count(),1);
      assert.equal((await buffer()).line,prefix+literal(long));
      assert.equal((await visible()).text,prompt+prefix+literal(long));
      record('A lost acknowledgement does not repeat the accepted edit');
    } finally { await lost.restore(); }
  } finally {
    await key('c','KeyC',67,2);
    await ui.evaluate(`${at(output)}.style.removeProperty('width')`);
  }
}
