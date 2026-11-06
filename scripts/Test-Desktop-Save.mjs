import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-save-ui-中文-'));const data=path.join(directory,'应用数据');const output=path.join(directory,'自选输出');await mkdir(data);await mkdir(output);
let ui;const request=request=>ui.invoke('logging_request',{request});
const scope=async()=>JSON.parse(await ui.evaluate(`sessionStorage.getItem('terminal-export-save-v1')`));
const native=async(action,target)=>new Promise((resolve,reject)=>{const child=spawn('pwsh',['-NoProfile','-File','scripts/lib/NativeSaveDialog.ps1','-TargetProcessId',String(ui.app.pid),'-Action',action,...(target?['-TargetPath',target]:[])],{windowsHide:true});let text='';child.stdout.on('data',chunk=>text+=chunk);child.stderr.on('data',chunk=>text+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve(text):reject(new Error(text)));});
const save=value=>ui.invoke('export_save_request',{request:value});
const state=async text=>{try{await ui.waitFor(`document.querySelector('[aria-label="导出另存状态"]')?.textContent.includes(${JSON.stringify(text)})`);}catch(error){const task=await scope();throw new Error(`${error.message}\nNative task: ${JSON.stringify(task?await save({op:'status',...task}).catch(String):null)}\nUI: ${await ui.evaluate(`document.querySelector('[aria-label="导出另存状态"]')?.textContent`)}`);}};
async function pick(target) { await ui.click('另存导出文件');try { await native('select',target); } catch(error) { const task=await scope();throw new Error(`${error.message}\nNative task: ${JSON.stringify(task?await save({op:'status',...task}).catch(String):null)}\nUI: ${await ui.evaluate(`document.querySelector('[aria-label="导出另存状态"]')?.textContent`)}`); } return scope(); }
try {
  ui=await launchDesktop(data,{fixture:true});await ui.click('新建合成会话');await ui.waitFor(`document.querySelector('.status')?.textContent==='服务输出已同步'`);
  const [c]=await ui.invoke('service_list');const connection={connection_id:c.connection_id,generation:c.generation};
  const log=await request({op:'start',connection,request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});await ui.invoke('fixture_append',{connection,bytes:[...Buffer.from('synthetic 中文 export\r\n')]});await request({op:'stop',connection,log_id:log.log_id});
  for(let n=0;n<300;n++){if((await request({op:'status',connection,log_id:log.log_id})).worker_finished)break;await delay(20);}
  await ui.click('终端日志');await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true`);await ui.click('刷新历史目录');await ui.waitFor(`!document.querySelector('[aria-label="历史日志选择"]').disabled`);await ui.fill('历史日志选择',log.log_id);await ui.click('导出选中日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="日志导出文件路径"]')`);const sourcePath=await ui.evaluate(`document.querySelector('[aria-label="日志导出文件路径"]').value`);const original=await readFile(sourcePath);
  const fresh=path.join(output,'新文件.jsonl');const first=await pick(fresh);await state('本次另存已完成');assert.deepEqual(await readFile(fresh),original);assert.deepEqual(await readFile(sourcePath),original);
  assert.equal((await save({op:'start',...first})).phase,'COMPLETED','same save ID returns the original result without reopening picker');
  await ui.click('打开保存目录');await native('explorer',output);
  const lost=await ui.interceptIpc({command:'export_save_request',op:'start',mode:'error'});const unknownPath=path.join(output,'丢应答.jsonl');const unknown=await pick(unknownPath);
  await state('保留原任务编号');assert.equal(await lost.count(),1);await delay(300);assert.equal(await lost.count(),1);await lost.restore();
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="另存文件路径"]')`),false,'an unknown reply cannot claim a saved destination');
  await ui.click('查询另存结果');await state('本次另存已完成');assert.deepEqual(await readFile(unknownPath),original);assert.equal((await save({op:'start',...unknown})).phase,'COMPLETED');
  const replaced=path.join(output,'现有文件.jsonl');await writeFile(replaced,'keep original');const second=await pick(replaced);await state('等待明确替换确认');
  const before=await save({op:'status',...second});assert.equal(before.phase,'AWAITING_CONFIRMATION');assert.equal(await readFile(replaced,'utf8'),'keep original');
  await ui.screenshot('desktop-save-confirm-synthetic.png');
  const foreign={...second,scope:{...second.scope,connection:{...second.scope.connection,generation:second.scope.connection.generation+1}}};
  await assert.rejects(save({op:'status',...foreign}));await assert.rejects(save({op:'confirm',...second,confirmation:before.confirmation,path:replaced}));
  await ui.invoke('fixture_append',{connection,bytes:[...Buffer.from('SAVE-LIVE-OUTPUT\r\n')]});
  let responsive=false;for(let n=0;n<100;n++){await ui.click('屏幕快照');if(await ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('SAVE-LIVE-OUTPUT')`)){responsive=true;break;}await delay(50);}assert.ok(responsive,'native save confirmation must leave the terminal output stream responsive');
  await assert.rejects(save({op:'confirm',...second,confirmation:crypto.randomUUID()}));
  assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认替换并保存').disabled`),true);
  await ui.evaluate(`document.querySelector('[aria-label="确认替换保存文件"]').click()`);await ui.click('确认替换并保存');await state('本次另存已完成');
  const done=await save({op:'status',...second});assert.equal(done.phase,'COMPLETED');assert.deepEqual(await readFile(replaced),original);assert.equal(await readFile(done.backup,'utf8'),'keep original');
  await ui.screenshot('desktop-save-completed-synthetic.png');
  await writeFile(replaced,'later user edit');assert.equal((await save({op:'confirm',...second,confirmation:before.confirmation})).phase,'COMPLETED');assert.equal(await readFile(replaced,'utf8'),'later user edit');
  assert.equal(createHash('sha256').update(await readFile(fresh)).digest('hex'),createHash('sha256').update(original).digest('hex'));
  const cancelled=await pick(replaced);await state('等待明确替换确认');await ui.click('取消另存');await state('另存已取消');assert.equal(await readFile(replaced,'utf8'),'later user edit');
  await ui.click('另存导出文件');await native('cancel');await state('另存已取消');
  const expires=await pick(replaced);await state('等待明确替换确认');for(let n=0;n<7;n++){await delay(10000);await ui.invoke('service_status');}await state('替换确认已到期');assert.equal((await save({op:'status',...expires})).phase,'EXPIRED');assert.equal(await readFile(replaced,'utf8'),'later user edit');
  const changed=Buffer.from(original);changed[0]^=1;await writeFile(sourcePath,changed);const refused=path.join(output,'源变化不得发布.jsonl');await pick(refused);await state('另存失败');await assert.rejects(readFile(refused));await writeFile(sourcePath,original);
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);await ui.click('终端日志');await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true`);await state('已恢复另存编号');await ui.click('查询另存结果');await state('另存失败');
  assert.deepEqual(await readFile(sourcePath),original);assert.equal((await readdir(output)).filter(name=>name.endsWith('.partial')).length,0);
  await ui.screenshot('desktop-save-synthetic.png');console.log('PASS native save picker/publication/explicit replacement/backup/scope/dedup/lost reply/cancel/lease/tamper/reload/open directory; synthetic only');
} catch(error) {
  console.error('SAVE_BODY_FAILURE', error);
  if(ui) { try { console.error('SAVE_UI_STATE',await ui.evaluate(`document.querySelector('[aria-label="导出另存状态"]')?.textContent`)); await ui.screenshot('desktop-save-failure-synthetic.png'); } catch(diagnosticError) { console.error('SAVE_DIAGNOSTIC_FAILURE',String(diagnosticError)); } }
  throw error;
} finally {await ui?.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('shared-terminal-save-ui-中文-'));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
