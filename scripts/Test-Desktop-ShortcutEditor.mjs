import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {desktopEvidence, launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]);
const parent=await realpath(tmpdir());
const prefix='shared-terminal-shortcut-editor-中文-';
const root=await mkdtemp(path.join(parent,prefix));
const report={result:'IN_PROGRESS',...await desktopEvidence(executable),checks:[]};
const panel='.pane-active .adb-shortcut-panel:not([hidden])';
const title=panel+' > .adb-panel-heading h2';
const body=panel+' > .adb-panel-body';
const add=panel+' [aria-label="新建快捷指令"]';
const collapse=panel+' [aria-label="收起快捷指令"]';
const empty=panel+' .adb-empty';
const back=panel+' .adb-editor-back';
const form=panel+' form';
const name=form+' [aria-label="指令名称"]';
const description=form+' [aria-label="指令描述"]';
const command=form+' [aria-label="Windows 本地命令"]';
const save=form+' button[type="submit"]';
const modal='dialog:modal[aria-label="更改尚未保存"]';
const row=id=>panel+` [data-shortcut-id="${id}"]`;
const trigger=id=>row(id)+' .adb-row-menu-trigger';
const node=selector=>`document.querySelector(${JSON.stringify(selector)})`;
let ui;

async function press(key,code,windowsVirtualKeyCode,modifiers=0) {
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{
    type,key,code,windowsVirtualKeyCode,modifiers,...(key==='Enter'&&type==='keyDown'?{text:'\r'}:{})
  });
}
const enter=()=>press('Enter','Enter',13);
const tab=(backwards=false)=>press('Tab','Tab',9,backwards?8:0);
const focus=selector=>ui.waitFor(`document.activeElement===${node(selector)}`);
const text=selector=>ui.evaluate(`${node(selector)}?.textContent.trim()`);
const value=selector=>ui.evaluate(`${node(selector)}?.value`);
const scroll=()=>ui.evaluate(`${node(body)}.scrollTop`);
async function activate(selector) {
  await ui.evaluate(`${node(selector)}.focus()`);
  await focus(selector);
  await enter();
}
async function read() {
  return ui.invoke('local_adb_settings',{settings:null});
}
async function write(shortcuts) {
  return ui.invoke('local_adb_settings',{settings:{...await read(),shortcuts}});
}
async function list() {
  await ui.waitFor(`${node(title)}?.textContent==='快捷指令'&&!!${node(add)}&&!!${node(collapse)}&&!${node(modal)}`);
  assert.equal(await ui.evaluate(`!!${node(form)}`),false);
}
async function editor(heading) {
  await ui.waitFor(`${node(title)}?.textContent===${JSON.stringify(heading)}&&!!${node(form)}`);
  assert.equal(await text(back),'← 返回');
  assert.equal(await ui.evaluate(`!!${node(add)}||!!${node(collapse)}`),false);
  await focus(name);
}
async function edit(id) {
  await activate(trigger(id));
  await ui.waitFor(`document.activeElement?.matches('[role="menuitem"]')&&document.activeElement.textContent==='编辑'`);
  const originalScroll=await scroll();
  await enter();
  await editor('编辑快捷指令');
  return originalScroll;
}
async function addLocal(entry) {
  await activate(entry);
  await ui.waitFor(`!!${node('[role="menu"][aria-label="新建指令类型"]')}`);
  await press('ArrowDown','ArrowDown',40);
  assert.equal(await ui.evaluate('document.activeElement.textContent'),'本地命令');
  await enter();
  await editor('新增快捷指令');
}
async function confirmation() {
  await ui.waitFor(`!!${node(modal)}`);
  await focus(modal+' [data-dialog-autofocus]');
}

try {
  ui=await launchDesktop(root,{executable});
  execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1','-TargetProcessId',String(ui.app.pid),
    '-ExpectedExecutable',executable,'-Width','950','-Height','560'],{windowsHide:true,timeout:12000});
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click('轻量命令行');
  const toggle='.pane-active .adb-panel-toggle';
  await ui.waitFor(`!!${node(toggle)}`);
  if(!await ui.evaluate(`!!${node(panel)}`))await activate(toggle);
  await list();
  await ui.waitFor(`!!${node(empty)}`);
  await addLocal(empty);
  await activate(back);
  await list();
  await focus(empty);
  assert.equal((await read()).shortcuts.length,0);
  report.checks.push('empty list and add cancellation restore the first-item action without a write');

  const entries=Array.from({length:28},(_,index)=>({id:randomUUID(),name:`导航条目 ${index+1}`,
    command:'echo navigation-test',desktop_kind:'local',...(index===24?{description:'已保存描述\n第二行'}:{})}));
  await write(entries);
  const original=entries[24];
  await ui.waitFor(`!!${node(row(original.id))}`);
  await ui.evaluate(`${node(row(original.id))}.scrollIntoView({block:'center'})`);
  const top=await edit(original.id);
  assert.ok(top>0,'fixture must scroll the list');
  assert.equal(await value(description),original.description);
  await activate(back);
  await list();
  await focus(trigger(original.id));
  assert.equal(await scroll(),top);

  await edit(original.id);
  await ui.fill('指令描述','已改描述\n第三行');
  await activate(back);
  await confirmation();
  await tab(true);
  assert.equal(await ui.evaluate('document.activeElement.textContent'),'放弃更改');
  await tab();
  await focus(modal+' [data-dialog-autofocus]');
  await press('Escape','Escape',27);
  await focus(back);
  assert.equal(await value(description),'已改描述\n第三行');
  await activate(back);
  await confirmation();
  await enter();
  await focus(back);
  assert.equal(await value(description),'已改描述\n第三行');
  await ui.evaluate(`[...${node(form)}.querySelectorAll('button')].find(button=>button.textContent==='取消编辑').focus()`);
  await enter();
  await confirmation();
  await tab();
  await enter();
  await list();
  await focus(trigger(original.id));
  assert.equal(await scroll(),top);
  assert.equal((await read()).shortcuts.find(item=>item.id===original.id).description,original.description);
  report.checks.push('clean return restores scrolling and row focus, both dirty exits confirm, modal traps Tab, Escape and Continue preserve the draft');

  await edit(original.id);
  await ui.evaluate(`${node(form+' .shortcut-checkbox input')}.click()`);
  await ui.evaluate(`${node(form+' .shortcut-checkbox input')}.click()`);
  await ui.fill('指令名称','临时更名');
  await ui.fill('指令名称',original.name);
  await activate(back);
  await list();
  await focus(trigger(original.id));
  assert.equal(await scroll(),top);

  await edit(original.id);
  await ui.fill('指令名称','修订名称');
  await ui.fill('指令描述','正式描述\n可重试');
  await ui.fill('Windows 本地命令','');
  await activate(save);
  await ui.waitFor(`!!${node(panel+' .adb-panel-error [role="alert"]')}`);
  await focus(save);
  assert.equal(await value(name),'修订名称');
  assert.equal(await value(description),'正式描述\n可重试');
  assert.equal(await value(command),'');
  assert.equal((await read()).shortcuts.find(item=>item.id===original.id).name,original.name);
  await ui.fill('Windows 本地命令',original.command);
  await activate(save);
  await list();
  await focus(trigger(original.id));
  assert.equal(await scroll(),top);
  assert.equal((await read()).shortcuts.find(item=>item.id===original.id).description,'正式描述\n可重试');
  assert.equal(await text(row(original.id)+' .adb-shortcut-run'),'修订名称');
  report.checks.push('reverted fields count as clean, native save failure retains inputs and save focus, successful save returns to the renamed row');

  await addLocal(add);
  await ui.fill('指令描述','未保存的新增描述');
  await activate(back);
  await confirmation();
  await tab();
  await enter();
  await list();
  await focus(add);
  assert.equal(await scroll(),top);
  await addLocal(add);
  await ui.fill('指令名称','新增后定位');
  await ui.fill('Windows 本地命令','echo new-shortcut');
  await activate(save);
  await list();
  const added=(await read()).shortcuts.find(item=>item.name==='新增后定位');
  assert.ok(added);
  await focus(trigger(added.id));
  assert.ok(await ui.evaluate(`${node(trigger(added.id))}.getBoundingClientRect().bottom<=${node(body)}.getBoundingClientRect().bottom`));

  await edit(added.id);
  await write((await read()).shortcuts.filter(item=>item.id!==added.id));
  await activate(back);
  await list();
  await ui.waitFor(`!${node(row(added.id))}`);
  await focus(add);
  report.checks.push('new draft restores add focus, saved item is visible and focused, concurrent removal returns to a usable list action');
  report.result='PASS';
  console.log('PASS Windows shortcut edit navigation, draft guard, keyboard focus, scrolling and native save failure');
}catch(error){
  report.result='FAIL';
  report.error=String(error.stack);
  throw error;
}finally{
  await ui?.close();
  assert.equal(path.dirname(root),parent);
  assert.ok(path.basename(root).startsWith(prefix));
  await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  await writeFile(output,JSON.stringify({...report,isolatedRootRemoved:true},null,2)+'\n');
}
