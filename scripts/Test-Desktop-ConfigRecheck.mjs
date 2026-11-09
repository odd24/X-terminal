import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
const build=fixture=>{const r=spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'ordinary service restoration must actually succeed');};
const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(await fn())return;await delay(30);}throw Error('Timeout: '+label);};
let directory,owner,ui;
const page=app=>app.invoke('config_request',{request:{op:'page',revision:null,offset:0,folders:false}});
const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
try{
 build(true);directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-config-recheck-ui-中文-'));
 async function openPair(suffix){owner=await launchDesktop(directory,{fixture:true,webviewDirectory:path.join(directory,'owner-'+suffix)});assert.equal((await page(owner)).result,'page');ui=await launchDesktop(directory,{fixture:true,webviewDirectory:path.join(directory,'blocked-'+suffix)});assert.equal((await page(ui)).code,'LOCKED');return ui.invoke('service_status');}
 const original=await openPair('serial');
 const prefs=await owner.invoke('config_request',{request:{op:'preferences'}});await owner.invoke('config_request',{request:{op:'save_preferences',revision:prefs.revision,preferences:{...prefs.preferences,font_size:19}}});
 const before=await readFile(path.join(directory,'config.sqlite'));
 await ui.click('串口连接');await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('读取连接配置失败')`);
 const alert=await ui.evaluate(`document.querySelector('dialog:modal [role="alert"]').textContent`);assert.ok(alert.includes('不是串口占用结果'));assert.ok(!alert.includes('保存旧窗口'));assert.ok(!alert.includes('读取端口或配置失败'));
 await ui.waitFor(`document.querySelector('[aria-label="UART端口"]').options.length===2`);assert.equal(await ui.evaluate(`${button('连接串口')}.disabled`),true);
 await ui.fill('UART波特率',1500000);await ui.fill('UART停止位',2);await ui.fill('UART端口',await ui.evaluate(`document.querySelector('[aria-label="UART端口"]').options[1].value`));
 const held=await ui.interceptIpc({command:'config_request',op:'recheck',mode:'hold'});
 await ui.evaluate(`(()=>{const b=${button('重新检查配置目录')};b.click();b.click();})()`);await wait(async()=>await held.count()===1,'one explicit recheck');assert.deepEqual(await ui.invoke('service_list'),[]);await held.restore();
 await ui.waitFor(`document.querySelector('[aria-label="配置目录复查状态"]').textContent.includes('本次复查仍未取得')`);assert.deepEqual(await readFile(path.join(directory,'config.sqlite')),before);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART波特率"]').value`),'1500000');
 await owner.close();owner=null;
 await ui.click('刷新端口');await ui.waitFor(`!${button('刷新端口')}.disabled`);assert.equal((await page(ui)).code,'LOCKED','normal reads never silently reacquire');
 const wrong=await ui.invoke('config_request',{request:{op:'recheck',service_id:crypto.randomUUID()}});assert.equal(wrong.code,'CONFLICT');assert.equal((await page(ui)).code,'LOCKED');
 const accepted=await ui.interceptIpc({command:'config_request',op:'recheck',mode:'hold'});await ui.click('重新检查配置目录');await wait(async()=>await accepted.count()===1,'actual reacquisition reply held');assert.equal((await page(ui)).result,'page');await ui.fill('UART波特率',921600);await accepted.restore();
 await ui.waitFor(`!document.querySelector('dialog:modal [role="alert"]')&&document.querySelector('[aria-label="UART端口"]').options.length===2`);
 assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART波特率"]').value`),'921600');assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART停止位"]').value`),'2');assert.deepEqual(await ui.invoke('service_list'),[]);
 const same=await ui.invoke('service_status');assert.equal(same.service_id,original.service_id);assert.equal(same.pid,original.pid);await ui.waitFor(`document.querySelector('[aria-label="字号"]').value==='19'`);
 await ui.screenshot('P12.1-config-recheck-serial.png');await ui.close();ui=null;
 // A fresh blocked service also recovers through SSH's original dialog, with no login.
 const next=await openPair('ssh');assert.notEqual(next.service_id,original.service_id);await ui.click('连接服务器');await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('不是串口占用结果')`);
 assert.equal(await ui.evaluate(`${button('连接')}.disabled`),true);await owner.close();owner=null;
 assert.equal((await ui.invoke('config_request',{request:{op:'recheck',service_id:original.service_id}})).code,'CONFLICT');
 const lost=await ui.interceptIpc({command:'config_request',op:'recheck',mode:'error'});await ui.click('重新检查配置目录');await wait(async()=>await lost.count()===1,'lost recheck reply hit');await ui.waitFor(`document.querySelector('[aria-label="配置目录复查状态"]').textContent.includes('复查')||document.querySelector('[aria-label="配置目录复查状态"]').textContent.includes('重试')`);await delay(200);assert.equal(await lost.count(),1);await lost.restore();assert.equal((await page(ui)).result,'page');assert.equal(await ui.evaluate(`${button('连接')}.disabled`),true,'lost reply cannot continue to SSH');assert.deepEqual(await ui.invoke('service_list'),[]);
 const revision=(await page(ui)).revision;await ui.click('重新检查配置目录');await ui.waitFor(`!document.querySelector('dialog:modal [role="alert"]')&&!${button('连接')}.disabled`);assert.equal((await page(ui)).revision,revision,'a repeated explicit recheck re-observes without reopening');assert.deepEqual(await ui.invoke('service_list'),[]);assert.equal((await ui.invoke('service_status')).service_id,next.service_id);
 // Port inventory failures are independent from a healthy configuration.
 await ui.click('收起连接窗口');const inventoryLost=await ui.interceptIpc({command:'serial_request',op:'inventory',mode:'error'});await ui.click('串口连接');await ui.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('读取端口清单失败')`);assert.equal(await inventoryLost.count(),1);assert.ok(!(await ui.evaluate(`document.querySelector('dialog:modal [role="alert"]').textContent`)).includes('读取连接配置失败'));await inventoryLost.restore();await ui.fill('UART波特率',1500000);await ui.click('刷新端口');await ui.waitFor(`!document.querySelector('dialog:modal [role="alert"]')&&document.querySelector('[aria-label="UART端口"]').options.length===2`);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="UART波特率"]').value`),'1500000');assert.deepEqual(await ui.invoke('service_list'),[]);
 await writeFile('artifacts/P12.1-config-recheck-result.json',JSON.stringify({result:'PASS',sameServiceRecovery:original.service_id,afterRestartService:next.service_id,root:'only owned synthetic root',recheckInFlight:1,lostRecheckResponse:1,originalDatabasePreserved:true,uartParametersPreserved:true,normalReadDoesNotReacquire:true,inventoryFailureSeparate:true,noAutomaticConnections:true,hardware:'in-memory inventory only; no COM opened'},null,2));
 console.log('PASS explicit same-service configuration recheck: current lock refusal, release recovery without restart, stale owner refusal, held/lost replies no continuation, UART parameters and DB preserved, SSH/serial dialogs, independent inventory failure; no COM opened');
}catch(error){if(ui){await ui.screenshot('P12.1-config-recheck-failure.png').catch(()=>{});await writeFile('artifacts/P12.1-config-recheck-failure.txt',await ui.evaluate('document.body.innerText').catch(String));}throw error;}
finally{try{await ui?.close();await owner?.close();if(directory){const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith('shared-terminal-config-recheck-ui-中文-'));await rm(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});}}finally{build(false);}}
