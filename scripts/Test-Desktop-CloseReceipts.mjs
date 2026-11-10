import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
const ordinary=process.argv.includes('--ordinary');
const executable=path.resolve(ordinary?'target/debug/shared-terminal-desktop.exe':'target/desktop-close-receipt-fixture/shared-terminal-desktop.exe');
const namespace='desktop-close-receipts-v1',results=[],roots=[];
let ui;
async function ownRoot(){const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-audit-diagnostic-中文-'));roots.push(root);return root;}
async function exists(file){try{await access(file);return true;}catch{return false;}}
async function until(test,label){for(let i=0;i<160;i++){if(await test())return;await delay(50);}throw new Error(`Timed out: ${label}`);}
async function open(root,mode='normal'){
  ui=await launchDesktop(root,{executable,fixture:!ordinary,extraArgs:ordinary?[]:['--close-receipt-fixture',mode]});
  const status=await ui.invoke('service_status');assert.deepEqual(await ui.invoke('service_list'),[]);
  assert.deepEqual((await ui.invoke('agent_management_request',{request:{op:'grant_list'}})).data,[]);
  return status;
}
async function close(root,id){
  let stderr='';ui.app.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16384);});
  await tools();
  await ui.evaluate(`setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出桌面').click(),50);true`);
  await until(()=>ui.app.exitCode!==null||ui.app.signalCode!==null,'actual native close');
  assert.equal(ui.app.exitCode,0);
  await ui.close();ui=undefined;
  const lines=stderr.split(/\r?\n/).filter(x=>x.startsWith('desktop_close_receipt_result '));assert.equal(lines.length,1,'one bounded publication result');
  const report=JSON.parse(lines[0].slice('desktop_close_receipt_result '.length));assert.equal(report.version,1);assert.equal(report.service_id,id);
  const file=path.join(root,namespace,`${id}.json`);
  const receipt=await exists(file)?JSON.parse(await readFile(file,'utf8')):null;
  return {report,receipt};
}
async function tools(){await ui.evaluate(`(()=>{const d=document.querySelector('details.tools-menu');if(!d.open)d.querySelector('summary').click();})()`);}
async function details(){await tools();assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='上次关闭信息').getClientRects().length>0`),true);await ui.click('上次关闭信息');await ui.waitFor(`!!document.querySelector('dialog[aria-label="上次关闭信息"]')`);}
async function notice(expected){await ui.waitFor(`!!document.querySelector('[aria-label="上次关闭提示"]')===${expected}`);}
try{
  await mkdir('artifacts',{recursive:true});
  if(ordinary){const refused=spawnSync(executable,['--close-receipt-fixture','normal'],{windowsHide:true,encoding:'utf8',timeout:10000});assert.ok(!refused.error);assert.notEqual(refused.status,0);assert.match(refused.stderr,/CLOSE_RECEIPT_FIXTURE_DISABLED/);}
  const selected=process.argv.find(x=>x.startsWith('--case='))?.slice(7);
  for(const mode of selected?[selected]:ordinary?['normal']:['normal','close','inflight','drop-ack','no-diagnostic']){
    const root=await ownRoot();
    if(mode==='no-diagnostic'){await mkdir(path.join(root,'terminal-audit'));await writeFile(path.join(root,'terminal-audit','user.txt'),'SYNTHETIC_PRIVATE_SENTINEL');}
    const first=await open(root,mode==='no-diagnostic'?'normal':mode);assert.equal(first.previous_close.attention,false);
    if(mode==='close'||mode==='inflight'){
      await writeFile(path.join(root,'audit-diagnostic-arm'),'arm');
      await ui.invoke('service_status');
    }
    let releaser;
    if(mode==='inflight'){
      await until(()=>exists(path.join(root,'audit-diagnostic-entered')),'inflight append entered');
      releaser=(async()=>{await until(()=>exists(path.join(root,'audit-diagnostic-closing')),'actual owner close entered');await writeFile(path.join(root,'audit-diagnostic-release'),'release');})();
    }
    const outcome=await close(root,first.service_id);await releaser;
    assert.equal(outcome.report.publication,'PUBLISHED');const r=outcome.receipt;
    assert.equal(r.service_id,first.service_id);assert.equal(r.owned_pid,first.pid);assert.equal(r.exited,true);assert.equal(r.kill_requested,false);assert.equal(r.kill_request_ok,null);assert.equal(r.exit_code,mode==='close'?1:0);
    assert.equal(r.shutdown_ack,mode==='drop-ack'?'UNKNOWN':'ACKNOWLEDGED');assert.equal(r.reader.join,'COMPLETE');assert.equal(r.reader.eof,true);
    assert.equal(r.reader.diagnostic?.outcome??null,mode==='no-diagnostic'?null:mode==='close'?'INCOMPLETE':'CLOSED');
    if(mode!=='no-diagnostic'){
      let shutdowns=0;
      for(const name of await readdir(path.join(root,'terminal-audit'))){if(!name.endsWith('.jsonl'))continue;for(const line of (await readFile(path.join(root,'terminal-audit',name),'utf8')).trim().split('\n')){const v=JSON.parse(line),e=v.payload?.event;if(e?.attempt?.request?.area==='SESSION'&&e.attempt.request.verb==='MAINTAIN'&&e.phase.kind==='received')shutdowns++;}}
      assert.equal(shutdowns,1,'real Shutdown is never replayed');
    }
    const encoded=JSON.stringify(r);assert.ok(!encoded.includes('SYNTHETIC_PRIVATE'));assert.ok(!encoded.includes(root));
    const second=await open(root);assert.notEqual(second.service_id,first.service_id);assert.equal(second.previous_close.receipt.service_id,first.service_id);assert.equal(second.previous_close.attention,mode==='close');
    await notice(mode==='close');await details();
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="上次关闭服务"]').textContent`),first.service_id);
    assert.ok((await ui.evaluate(`document.querySelector('[aria-label="上次进程退出"]').textContent`)).includes(`代码 ${r.exit_code}`));
    if(mode==='drop-ack')assert.ok((await ui.evaluate(`document.querySelector('[aria-label="上次关闭确认"]').textContent`)).includes('未知；未重发'));
    if(mode==='no-diagnostic')assert.equal(await ui.evaluate(`document.querySelector('[aria-label="上次审计关闭"]').textContent`),'审计关闭信息未知');
    if(mode==='close'){
      await ui.screenshot('P22-close-receipt-dark.png');
      const layout=await ui.evaluate(`(()=>{const d=document.querySelector('dialog[aria-label="上次关闭信息"]'),r=d.getBoundingClientRect();return {width:innerWidth,height:innerHeight,left:r.left,top:r.top,right:r.right,bottom:r.bottom,scroll:d.scrollHeight> d.clientHeight,horizontal:d.scrollWidth>d.clientWidth};})()`);assert.ok(layout.left>=0&&layout.right<=layout.width&&layout.top>=0&&layout.bottom<=layout.height);assert.equal(layout.horizontal,false);
      await ui.click('关闭退出信息');await tools();await ui.click('外观');await ui.fill('应用主题','light');await ui.click('关闭外观');await details();await ui.screenshot('P22-close-receipt-light.png');
      await ui.evaluate(`document.querySelector('dialog[aria-label="上次关闭信息"]').scrollTop=99999`);await ui.screenshot('P22-close-receipt-light-bottom.png');
      assert.ok((await ui.evaluate(`document.querySelector('dialog[aria-label="上次关闭信息"]').textContent`)).includes('关闭屏障 · I/O 类别失败'));
      await ui.click('关闭退出信息');
      await ui.click('收起关闭提示');await notice(false);
    }else await ui.click('关闭退出信息');
    const after=await ui.invoke('service_status');assert.equal(after.service_id,second.service_id);assert.deepEqual(await ui.invoke('service_list'),[]);
    await close(root,second.service_id);
    if(mode==='no-diagnostic')assert.equal(await readFile(path.join(root,'terminal-audit','user.txt'),'utf8'),'SYNTHETIC_PRIVATE_SENTINEL');
    results.push({mode,result:'PASS',ack:r.shutdown_ack,exit:r.exit_code,kill:r.kill_requested,diagnostic:r.reader.diagnostic?.outcome??null,priorCurrentSeparated:true});
  }
  // An unknown/future receipt must neither be repaired nor block ordinary startup/exit.
  for(const [name,bytes,availability] of selected?[]:[['future',JSON.stringify({version:2,private:'SYNTHETIC_PRIVATE_SENTINEL'}),'UNSUPPORTED'],['bad','{bad SYNTHETIC_PRIVATE_SENTINEL','UNTRUSTED'],['unknown','SYNTHETIC_PRIVATE_SENTINEL','UNTRUSTED']]){
    const root=await ownRoot(),dir=path.join(root,namespace),id=randomUUID();await mkdir(dir);await writeFile(path.join(dir,'store.lock'),'');
    const file=path.join(dir,name==='unknown'?'user.txt':`${id}.json`);await writeFile(file,bytes);
    const status=await open(root);assert.equal(status.previous_close.availability,availability);assert.equal(status.previous_close.attention,false);await notice(false);await details();assert.ok(!(await ui.evaluate(`document.querySelector('dialog[aria-label="上次关闭信息"]').textContent`)).includes('SYNTHETIC_PRIVATE'));await ui.click('关闭退出信息');
    const out=await close(root,status.service_id);assert.equal(out.receipt,null);assert.deepEqual(out.report.publication,{FAILED:availability});assert.equal(await readFile(file,'utf8'),bytes);assert.deepEqual((await readdir(dir)).sort(),[path.basename(file),'store.lock'].sort());
    results.push({mode:name,result:'PASS',publication:out.report.publication,serviceExitUnblocked:true,foreignPreserved:true});
  }
  await writeFile(`artifacts/P22-close-receipt-${selected??(ordinary?'ordinary':'fixture')}-result.json`,JSON.stringify({result:'PASS',cases:results,scope:'own synthetic roots only; no load or real devices'},null,2)+'\n');
  console.log('PASS native owner close/restart receipts, ACK loss, in-flight join, error exit, missing diagnostic, store refusal, isolation and UI.');
}catch(error){console.error('Close receipt fixture failed:',error.message);if(ui)await ui.screenshot('P22-close-receipt-failure.png').catch(()=>{});throw error;}
finally{
  await ui?.close();
  for(const root of roots){assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-audit-diagnostic-中文-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
}
