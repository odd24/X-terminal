import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-file-drop-'));
const result={...await desktopEvidence(executable),
  source:process.argv.includes('--event-fixture')?'Tauri event injection':'Win32 OLE CF_HDROP fixture',
  checks:[],result:'IN_PROGRESS'};
const visible='.local-terminal:not([hidden])';
const current=mode=>'.pane-active '+visible+'[data-mode="'+mode+'"]';
const q=JSON.stringify;
const selector=css=>'document.querySelector('+q(css)+')';
const helper=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const eventFixture=process.argv.includes('--event-fixture');
let ui;

const record=(name, details={})=>result.checks.push({name,...details});
async function key(name,code,windowsVirtualKeyCode,modifiers=0){
  for(const type of ['keyDown','keyUp']){
    await ui.command('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode,modifiers});
  }
}
const type=text=>ui.command('Input.insertText',{text});
const enter=()=>key('Enter','Enter',13);
const cancelLine=()=>key('c','KeyC',67,2);
const screen=(where,token)=>ui.waitFor(selector(where)+'?.innerText.includes('+q(token)+')');
async function openTool(label){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(label);
}
async function nativeDrop(where,paths,{highlight=true,cancel=false,during}={}){
  const point=await ui.evaluate('(()=>{const r='+selector(where)+
    '.getBoundingClientRect();return [Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)]})()');
  if(eventFixture){
    const position={x:point[0],y:point[1]};
    const emit=(event,payload)=>ui.invoke('plugin:event|emit',{event:'tauri://drag-'+event,payload});
    await emit('enter',{paths,position});
    if(highlight)await ui.waitFor('!!document.querySelector("[data-file-drop-target]")');
    else{
      await delay(220);
      assert.equal(await ui.evaluate('!!document.querySelector("[data-file-drop-target]")'),false);
    }
    if(during)await during();
    if(cancel)await emit('leave');
    else await emit('drop',{paths,position});
    await ui.waitFor('!document.querySelector("[data-file-drop-target]")');
    return 'Tauri event injection fixture';
  }
  const list=path.join(root,'drag.json');
  await writeFile(list,JSON.stringify(paths));
  const process=spawn(helper,[
    '-NoProfile','-STA','-ExecutionPolicy','Bypass','-File','scripts/lib/Drop-TestFiles.ps1','-TargetProcessId',String(ui.app.pid),
    '-ExpectedExecutable',executable,'-X',String(point[0]),'-Y',String(point[1]),'-PathList',list,
    ...(cancel?['-Cancel']:[]),
  ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';
  for(const stream of [process.stdout,process.stderr])stream.setEncoding('utf8').on('data',chunk=>output+=chunk);
  const stop=setTimeout(()=>process.kill(),9000);
  const ended=new Promise((resolve,reject)=>{process.once('error',reject);process.once('close',resolve);});
  let seen=false;
  try{
    for(let index=0;index<115&&process.exitCode===null;index++){
      if(!seen&&await ui.evaluate('!!document.querySelector("[data-file-drop-target]")')){
        seen=true;
        if(during)await during();
      }
      await delay(40);
    }
    assert.equal(await ended,0,output);
    assert.equal(seen,highlight,output);
    assert.match(output,cancel?/40101\/0/:/40100\/[01]/);
    await ui.waitFor('!document.querySelector("[data-file-drop-target]")');
  }finally{clearTimeout(stop);if(process.exitCode===null&&process.signalCode===null)process.kill();}
  return output.trim();
}

const literal=value=>"'"+value.replace(/['‘’‚‛]/g,character=>character+character)+"'";
async function waitRead(file,condition){
  for(let attempt=0;attempt<150;attempt++){
    const actual=(await readFile(file,'utf8').catch(()=> '')).replace(/^\uFEFF/,'');
    if(condition(actual))return actual;
    await delay(40);
  }
  assert.fail('Expected synthetic shell output at '+path.basename(file));
}

try{
  const special=path.join(root,"工程 ' $ &");
  const second=path.join(root,'second ‘ quoted $.txt');
  await mkdir(special);
  await writeFile(second,'owned fixture');
  ui=await launchDesktop(root,{executable});
  await ui.evaluate(String(()=>{
    const original=window.fetch;
    window.fileDropReceipt=[];
    window.fetch=async function(request,init){
      const reply=await original.call(this,request,init);
      const body=typeof init?.body==='string'?JSON.parse(init.body):null;
      if(body?.action?.kind==='file_drop')window.fileDropReceipt.push([reply.status,await reply.clone().text()]);
      return reply;
    };
  }).replace(/^/,'(')+')()');
  await openTool('轻量命令行');
  const light=current('lightweight');
  await ui.waitFor('document.activeElement?.matches('+q(light+' textarea')+')');
  await type('cd ');
  const native=await nativeDrop(light+' .local-terminal-output',[special]);
  await screen(light,'工程');
  assert.notEqual(await ui.evaluate(selector(light+' .local-terminal-output')+'.title'),special);
  await enter();
  await ui.waitFor(selector(light+' .local-terminal-output')+'.title==='+q(special));
  record('Directory drop preserves its literal path and waits for explicit Enter',{native});
  await type('cd ');
  await ui.waitFor(selector(light+' .local-terminal-output')+'.innerText.trimEnd().endsWith("cd")');
  const beforeCancel=await ui.evaluate(selector(light+' .local-terminal-output')+'.innerText');
  await nativeDrop(light+' .local-terminal-output',[special],{cancel:true});
  assert.equal(await ui.evaluate(selector(light+' .local-terminal-output')+'.innerText'),beforeCancel);
  await cancelLine();
  record('Drag cancellation clears the highlight and preserves the draft');

  await ui.click('本地终端');
  const shell=current('powershell');
  await ui.waitFor('document.activeElement?.matches('+q(shell+' textarea')+')');
  await screen(shell,'PS ');
  const proof=path.join(root,'powershell-output.txt');
  const roundtrip='function SharedDropProbe { $args | Set-Content -LiteralPath '+literal(proof)+' -Encoding UTF8 }';
  await type(roundtrip);await enter();
  await delay(550);
  await type('SharedDropProbe ' + "'TAIL'");
  for(let index=0;index<6;index++)await key('ArrowLeft','ArrowLeft',37);
  const reply=await nativeDrop(shell+' .local-terminal-output',[special,second]);
  await screen(shell,'quoted');
  assert.equal(await readFile(proof,'utf8').catch(()=>''),'');
  await enter();
  const observed=await waitRead(proof,value=>value.includes('TAIL'));
  assert.deepEqual(observed.trimEnd().split(/\r?\n/),[special,second,'TAIL']);
  record('Multiple drop reached PSReadLine at the cursor and round-tripped ordered paths with preserved suffix',{native:reply});

  const blocked=path.join(root,'foreground.txt');
  await type('Set-Content -LiteralPath '+literal(blocked)+" -Value (Read-Host 'FOREGROUND_DROP_PROBE')");await enter();
  await screen(shell,'FOREGROUND_DROP_PROBE:');
  await nativeDrop(shell+' .local-terminal-output',[special],{highlight:false});
  await type('explicit-input');await enter();
  assert.equal((await waitRead(blocked,value=>!!value)).trim(),'explicit-input');
  record('Read-Host foreground gets only the explicit test input');
  await nativeDrop('[role="tab"][aria-selected="true"]',[special],{highlight:false});
  record('The tab rail rejects file drops');

  const firstTab='[role="tab"]:first-child';
  const coordinates=await ui.evaluate('(()=>{const from='+selector(firstTab)+'.getBoundingClientRect();const to='+
    selector(shell+' .local-terminal-output')+'.getBoundingClientRect();return {'+
    'from:{x:from.x+from.width/2,y:from.y+from.height/2},to:{x:to.x+to.width*.92,y:to.y+to.height/2}}})()');
  await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...coordinates.from,button:'left',buttons:1,clickCount:1});
  try{
    await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...coordinates.to,button:'left',buttons:1});
    await ui.waitFor('!!document.querySelector(".tab-split-preview[data-edge=right]")');
  }finally{
    await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...coordinates.to,button:'left',buttons:0,clickCount:1});
  }
  await ui.waitFor('document.querySelectorAll("[data-pane]").length===2');
  await ui.click('本地 2');
  await ui.waitFor('document.activeElement?.matches('+q(shell+' textarea')+')');
  const unfocused='[data-pane]:not(.pane-active) '+visible+'[data-mode="lightweight"]';
  await nativeDrop(unfocused+' .local-terminal-output',[special]);
  await screen(unfocused,'工程');
  assert.equal(await ui.evaluate('document.activeElement?.matches('+q(shell+' textarea')+')'),true);
  record('The existing tab drag still splits and a file drop follows the unfocused local pane without changing focus');

  const beforeStale=await ui.evaluate(selector(unfocused+' .local-terminal-output')+'.innerText');
  await nativeDrop(unfocused+' .local-terminal-output',[second],{during:async()=>{
    await ui.click('收起此窗格，保留连接');
    await ui.waitFor('document.querySelectorAll("[data-pane]").length===1');
  }});
  assert.ok(!(await ui.evaluate('Array.from(document.querySelectorAll(".local-terminal-output"),node=>node.innerText).join("\\n")')).includes('second ‘ quoted $.txt"'));
  assert.ok(beforeStale.includes('工程'));
  record('Collapsing a highlighted pane invalidates the pending drop');
  result.result='PASS';
}catch(error){
  result.result='FAIL';
  result.error=error.stack;
  result.acknowledgements=await ui?.evaluate('window.fileDropReceipt').catch(()=>undefined);
  throw error;
}finally{
  await ui?.close();
  await mkdir(path.dirname(report),{recursive:true});
  await writeFile(report,JSON.stringify(result,null,2)+'\n');
  assert.ok(path.basename(root).startsWith('shared-terminal-file-drop-'));
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
