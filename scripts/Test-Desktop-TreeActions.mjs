import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay,desktopEvidence} from './lib/DesktopHarness.mjs';
const executable=process.argv[2]?path.resolve(process.argv[2]):path.resolve('target/debug/shared-terminal-desktop.exe');
const output=process.argv[3]??'artifacts/P26.69-tree-actions-result.json';
const reportPrefix=process.argv[4]??'P26.69';
const deletionOp='delete_profile_if_revision';
let directory,ui,fixture;
const wait=async fn=>{for(let n=0;n<300;n++){if(await fn())return;await delay(50);}throw new Error('fixture state timeout');};
try{
 directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-tree-actions-ui-中文-'));
 fixture=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[directory],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]();let timer;const server=await Promise.race([lines.next().then(v=>JSON.parse(v.value)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),10000);})]).finally(()=>clearTimeout(timer));
 ui=await launchDesktop(directory,{executable});const config=request=>ui.invoke('config_request',{request}),list=()=>ui.invoke('service_list'),page=()=>config({op:'page',revision:null,offset:0,folders:false});
 const empty={id:crypto.randomUUID(),name:'空目录',parent_id:null},folder={id:crypto.randomUUID(),name:'父目录',parent_id:null},nested={id:crypto.randomUUID(),name:'子目录',parent_id:folder.id};for(const f of [empty,folder,nested])await config({op:'save_folder',folder:f});
 const profile=(folder_id,name='同名配置')=>({id:crypto.randomUUID(),name,folder_id,settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}});
 const a=profile(null),b=profile(folder.id),c=profile(null,'待外部移除');
 for(const p of [a,b,c])await config({op:'save_profile',profile:p,credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}});
 const originals=(await page()).profiles,credentialIds=(await config({op:'credentials_page',revision:null,offset:0})).entries.map(c=>c.id).sort();
 const treeVisible="!!document.querySelector('#connection-library')?.getClientRects().length";
 if(!await ui.evaluate(treeVisible))await ui.click('会话导航');
 await ui.waitFor(treeVisible);
 async function refreshTree(){
   await ui.waitFor("!!document.querySelector('[aria-label=刷新会话树]:enabled')");
   await ui.click('刷新会话树');
 }
 await refreshTree();
 const leaf=p=>`document.querySelector('[data-profile-id="${p.id}"]')`,branch=f=>`document.querySelector('[data-folder-id="${f.id}"] > button')`;
 await ui.waitFor(`!!(${leaf(a)})`);assert.equal(await ui.evaluate(`${leaf(b)}===null`),true);
 assert.equal(await ui.evaluate(`${leaf(a)}.querySelector('small')===null`),true);assert.ok((await ui.evaluate(`${leaf(a)}.title`)).includes('SSH2'));
 await ui.evaluate(`${branch(empty)}.click()`);await ui.waitFor(`document.querySelector('.tree-empty')?.textContent.includes('暂无配置')`);assert.ok(await ui.evaluate(`!!(${leaf(a)})`));
 await ui.evaluate(`${branch(folder)}.click()`);await ui.waitFor(`!!(${leaf(b)})`);const positions=await ui.evaluate(`({root:${leaf(a)}.getBoundingClientRect().left,child:${leaf(b)}.getBoundingClientRect().left})`);assert.ok(positions.child>positions.root);
 await ui.evaluate(`${branch(folder)}.click()`);await ui.waitFor(`${leaf(b)}===null`);assert.ok(await ui.evaluate(`!!(${leaf(a)})`));
 await ui.fill('搜索会话配置','同名');await ui.waitFor(`!!(${leaf(b)})`);await ui.evaluate(`${branch(folder)}.click()`);await ui.waitFor(`${leaf(b)}===null`);await ui.evaluate(`${leaf(a)}.click()`);assert.equal(await ui.evaluate(`${branch(folder)}.getAttribute('aria-expanded')`),'false');await ui.fill('搜索会话配置','');
 await ui.evaluate(`${leaf(a)}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await ui.waitFor(`!!document.querySelector('[aria-label="快速连接核对指纹"]')`);await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').click()`);await ui.click('信任并继续登录');await wait(async()=>(await list()).some(c=>c.state==='CONNECTED'));await ui.waitFor(`!document.querySelector('dialog:modal')`);const active=(await list())[0];
 const context=async p=>{await ui.evaluate(`${leaf(p)}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:60,clientY:300}))`);await ui.waitFor(`document.querySelector('[role="menu"]')?.textContent.includes('编辑')`);assert.equal(await ui.evaluate(`${leaf(p)}.getAttribute('aria-pressed')`),'true');};
 await ui.evaluate(`${branch(folder)}.click()`);await ui.waitFor(`!!(${leaf(b)})`);await context(b);await ui.screenshot(`${reportPrefix}-tree-actions-context.png`);await ui.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent==='编辑').click()`);await ui.waitFor(`document.querySelector('[aria-label="配置名称"]')?.value==='同名配置'`);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="所属目录"]').value`),folder.id);assert.equal(await ui.evaluate(`document.querySelector('[aria-label="凭据操作"]').value`),'keep');assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="新密码"]')`),false);
 await ui.fill('配置名称','修改后的子配置');await ui.fill('所属目录',nested.id);await ui.fill('主机','localhost');await ui.click('保存配置');await ui.waitFor(`document.querySelector('[aria-label="配置状态"]').textContent.includes('配置已保存')`);const edited=(await page()).profiles;assert.deepEqual(edited.find(p=>p.id===a.id),originals.find(p=>p.id===a.id));assert.equal(edited.find(p=>p.id===b.id).folder_id,nested.id);assert.equal(edited.find(p=>p.id===b.id).credential_ref,originals.find(p=>p.id===b.id).credential_ref);await ui.click('关闭配置');
 const treeDialog='document.querySelector(\'dialog:modal[aria-label="删除会话配置"]\')';
 const manager='document.querySelector(\'dialog:modal[aria-label="连接配置"]\')';
 const smallConfirm='document.querySelector(\'[aria-label="删除保存配置确认"]\')';
 const treeStatus=message=>ui.waitFor(`document.querySelector('[aria-label="会话树配置状态"]')?.textContent.includes(${JSON.stringify(message)})`);
 const managerStatus=message=>ui.waitFor(`document.querySelector('[aria-label="配置状态"]')?.textContent.includes(${JSON.stringify(message)})`);
 const panelStatus=message=>ui.waitFor(`${smallConfirm}?.querySelector('[role=status]')?.textContent.includes(${JSON.stringify(message)})`);
 const escape=async()=>{for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});};
 async function beginDelete(p){
   await context(p);await ui.click('删除');
   await ui.waitFor(`${treeDialog}?.textContent.includes(${JSON.stringify(p.id)})`);
   assert.equal(await ui.evaluate(`!!${manager}`),false);
   await ui.waitFor(`document.activeElement?.textContent==='取消删除'`);
 }
 async function openManager(p){
   await context(p);await ui.click('编辑');
   await managerStatus('配置已加载');
 }
 await ui.waitFor(`!!(${branch(nested)})`);await ui.evaluate(`${branch(nested)}.click()`);await ui.waitFor(`!!(${leaf(b)})`);
 await beginDelete(b);
 assert.ok(await ui.evaluate(`${treeDialog}.getBoundingClientRect().width<=450`));
 await ui.screenshot(`${reportPrefix}-tree-actions-delete.png`);
 await escape();await treeStatus('已取消删除');await ui.waitFor(`!${treeDialog}&&document.activeElement===${leaf(b)}`);
 assert.ok((await page()).profiles.some(p=>p.id===b.id));

 await beginDelete(b);
 const lost=await ui.interceptIpc({command:'config_request',op:deletionOp,mode:'hold_error'});
 await ui.evaluate(`(()=>{const button=[...${treeDialog}.querySelectorAll('button')].find(item=>item.textContent==='确认删除此配置');button.click();button.click();})()`);
 await wait(async()=>await lost.count()===1);
 await escape();assert.equal(await ui.evaluate(`!!${treeDialog}`),true);
 assert.ok(!(await page()).profiles.some(p=>p.id===b.id));
 await lost.release();await panelStatus('删除结果不明');
 assert.equal(await lost.count(),1);
 await ui.click('只读核对删除结果');await treeStatus('原配置已不存在');
 assert.equal(await lost.count(),1);
 await lost.restore();
 await ui.waitFor(`!${treeDialog}&&document.activeElement?.dataset.profileId&&document.activeElement!==${leaf(b)}`);
 assert.deepEqual((await page()).profiles.find(p=>p.id===a.id),originals.find(p=>p.id===a.id));

 await beginDelete(c);
 const changed={...c,name:'在确认期间修改'};
 await config({op:'save_profile',profile:changed,credential:{action:'keep'}});
 await ui.click('确认删除此配置');await panelStatus('配置已变化');
 assert.equal((await page()).profiles.find(p=>p.id===c.id).name,changed.name);
 await ui.click('返回');await treeStatus('配置已变化');await ui.waitFor(`${leaf(c)}?.textContent===${JSON.stringify(changed.name)}`);
 await beginDelete(c);
 const changedAgain={...c,name:'回执不明时仍在'};
 await config({op:'save_profile',profile:changedAgain,credential:{action:'keep'}});
 const lostConflict=await ui.interceptIpc({command:'config_request',op:deletionOp,mode:'error'});
 await ui.click('确认删除此配置');await panelStatus('删除结果不明');
 await ui.click('只读核对删除结果');await treeStatus('核对时原配置仍存在');await ui.waitFor(`document.activeElement===${leaf(c)}`);
 assert.equal(await lostConflict.count(),1);await lostConflict.restore();
 assert.equal((await page()).profiles.find(p=>p.id===c.id).name,changedAgain.name);

 const logs=request=>ui.invoke('logging_request',{request:{connection:{connection_id:active.connection_id,generation:active.generation},...request}});
 const recording=await logs({op:'start',request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}});
 assert.ok(recording.log_id);
 await beginDelete(a);await ui.click('确认删除此配置');await treeStatus('所选保存配置已删除');
 await ui.waitFor(`!${treeDialog}&&document.activeElement===${leaf(c)}`);
 assert.ok(!(await page()).profiles.some(p=>p.id===a.id));
 const stillActive=(await list()).find(c=>c.connection_id===active.connection_id);
 assert.equal(stillActive.generation,active.generation);assert.equal(stillActive.state,'CONNECTED');
 assert.deepEqual((await config({op:'credentials_page',revision:null,offset:0})).entries.map(c=>c.id).sort(),credentialIds);
 assert.ok((await logs({op:'list'})).logs.some(log=>log.log_id===recording.log_id));
 await logs({op:'stop',log_id:recording.log_id});

 await openManager(c);await ui.click('删除配置');
 await ui.waitFor(`${smallConfirm}?.textContent.includes(${JSON.stringify(c.id)})`);
 assert.equal(await ui.evaluate(`!!${treeDialog}`),false);
 await ui.click('取消删除');await managerStatus('已取消删除');
 await ui.waitFor(`!!${manager}&&document.activeElement?.textContent==='删除配置'`);
 assert.ok((await page()).profiles.some(p=>p.id===c.id));
 await ui.click('删除配置');
 const managerLost=await ui.interceptIpc({command:'config_request',op:deletionOp,mode:'hold_error'});
 await ui.click('确认删除此配置');await wait(async()=>await managerLost.count()===1);
 await escape();assert.equal(await ui.evaluate(`!!${manager}`),true);
 await managerLost.release();await panelStatus('删除结果不明');
 await ui.click('只读核对删除结果');await managerStatus('原配置已不存在');
 assert.equal(await managerLost.count(),1);await managerLost.restore();
 await ui.waitFor(`!!${manager}&&document.activeElement?.getAttribute('aria-label')==='搜索配置'`);
 assert.ok(!(await page()).profiles.some(p=>p.id===c.id));
 await ui.click('关闭配置');

 const stale=profile(null,'待外部删除');
 await config({op:'save_profile',profile:stale,credential:{action:'clear'}});
 await refreshTree();await ui.waitFor(`!!${leaf(stale)}`);
 await context(stale);await config({op:'delete_profile',id:stale.id});await ui.click('编辑');
 await managerStatus('所选配置已不存在');
 assert.equal(await ui.evaluate(`document.querySelector('[aria-label="配置编辑"] fieldset').disabled`),true);
 await ui.click('关闭配置');
 const last=profile(null,'最后一项');
 await config({op:'save_profile',profile:last,credential:{action:'clear'}});
 await refreshTree();await ui.waitFor(`!!${leaf(last)}`);await beginDelete(last);
 await ui.click('确认删除此配置');await treeStatus('所选保存配置已删除');
 await ui.waitFor(`document.activeElement?.matches('.tree-root-label')`);
 assert.equal((await page()).profiles.length,0);
 await ui.screenshot(`${reportPrefix}-tree-actions.png`);
 await writeFile(output,JSON.stringify({result:'PASS',...await desktopEvidence(executable),
   cases:['tree nesting, search and same-name exact edits','independent compact delete confirmation, Escape and original focus',
     'held and lost applied result, single dispatch and read-only resolution','native revision conflict and lost rejection with original still present',
     'active connection generation, recording and credential IDs preserved','manager cancel, lost-success check and focus; last tree row returns to root',
     'legacy ID-only deletion and stale target edit fail closed'],scope:'owned Windows desktop and synthetic loopback SSH'},null,2));
 console.log('PASS native tree and manager deletion, revision guards, focus, delayed and unknown results');
}catch(error){if(ui){await ui.screenshot(`${reportPrefix}-tree-actions-failure.png`).catch(()=>{});await writeFile(`artifacts/${reportPrefix}-tree-actions-failure.txt`,await ui.evaluate('document.body.innerText').catch(String));}throw error;
}finally{await ui?.close();fixture?.kill();if(fixture&&fixture.exitCode===null&&fixture.signalCode===null)await new Promise(resolve=>fixture.once('exit',resolve));if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-tree-actions-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}}
