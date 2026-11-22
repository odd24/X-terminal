import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay,dragNativeWindow} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-local-tabs-中文-'));
const result={result:'IN_PROGRESS',executable,checks:[]};
const q=JSON.stringify;
const query=css=>`document.querySelector(${q(css)})`;
const tab=name=>`[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent===${q(name)})`;
const active='[data-pane].pane-active';
const consoleView=active+' .local-terminal:not([hidden])';
const output=query(consoleView+' .local-terminal-output');
let ui;

async function tool(name) {
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(name);
}
async function focused(name) {
  await ui.waitFor(`${tab(name)}?.ariaSelected==='true'&&document.activeElement?.matches(${q(consoleView+' .xterm-helper-textarea')})`);
}
const press=(point,count=1)=>ui.command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:count});
const release=(point,count=1)=>ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:count});
const point=(element,x=.5,y=.5)=>ui.evaluate(`(()=>{const r=(${element}).getBoundingClientRect();return{x:r.left+r.width*${x},y:r.top+r.height*${y}}})()`);
async function drag(source,to,preview,cancel=false) {
  const from=await point(tab(source));
  await press(from);
  await ui.command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
  await ui.waitFor(preview);
  if(cancel)await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await release(to);
  await ui.waitFor("!document.querySelector('[data-drag-source]')");
}
async function doubleClick(name) {
  const where=await point(tab(name));
  for(const count of [1,2]){await press(where,count);await release(where,count);}
}
async function enter() {
  for(const type of ['keyDown','keyUp'])await ui.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
}
const type=text=>ui.command('Input.insertText',{text});
const names=()=>ui.evaluate("[...document.querySelectorAll('[role=tab]')].map(tab=>tab.textContent)");
const count=expected=>ui.waitFor(`document.querySelectorAll('[data-pane]').length===${expected}`);

try {
  const directory=path.join(root,'工作 路径');
  await mkdir(directory);
  ui=await launchDesktop(root,{executable});
  await tool('轻量命令行');await focused('本地 1');
  await type(`cd "${directory}"`);await enter();
  await ui.waitFor(`${output}?.title===${q(directory)}`);
  await type('retained-draft');
  await ui.waitFor(`${output}?.innerText.includes('retained-draft')`);
  await ui.evaluate(`window.originalLocal=${output}.querySelector('.xterm')`);
  await doubleClick('本地 1');await focused('本地 2');
  assert.equal(await ui.evaluate(`${output}.title`),directory);
  assert.ok(!(await ui.evaluate(`${output}.innerText`)).includes('retained-draft'));
  assert.deepEqual(await names(),['本地 1','本地 2']);
  result.checks.push('lightweight double-click opens one adjacent terminal with the source directory and its own empty draft');

  const from=await point(tab('本地 1'));
  const to=await point(tab('本地 2'),.9);
  dragNativeWindow(ui.app,[from,{x:(from.x+to.x)/2,y:from.y},to],{executable,title:'共享终端',raise:true});
  await ui.waitFor(`${tab('本地 2')}.closest('.connection-tab').nextElementSibling?.querySelector('[role="tab"]')===${tab('本地 1')}`);
  assert.deepEqual(await names(),['本地 2','本地 1']);
  await focused('本地 1');
  assert.equal(await ui.evaluate(`${output}.querySelector('.xterm')===window.originalLocal`),true);
  await ui.waitFor(`${output}?.innerText.includes('retained-draft')`);
  await drag('本地 1',await point(query(active+' .local-pane-body'),.85),`!!${query('.tab-split-preview')}`,true);
  await count(1);
  assert.deepEqual(await names(),['本地 2','本地 1']);
  await drag('本地 1',await point(query(active+' .local-pane-body'),.85),`!!${query('.tab-split-preview[data-edge="right"]')}`);
  await count(2);await focused('本地 1');
  assert.equal(await ui.evaluate(`${output}.querySelector('.xterm')===window.originalLocal`),true);
  await ui.waitFor(`${output}?.innerText.includes('retained-draft')`);
  await drag('本地 1',await point(tab('本地 2'),.1),`!!${query('[data-insertion="before"]')}`);
  await count(1);await focused('本地 1');
  assert.deepEqual(await names(),['本地 1','本地 2']);
  assert.equal(await ui.evaluate(`${output}.querySelector('.xterm')===window.originalLocal`),true);
  result.checks.push('native mouse reorders, Escape cancels, terminal edge splits, and cross-pane rail drop merges with the same renderer and draft');

  await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");
  await ui.click('本地终端（PowerShell）');await focused('本地 3');
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${output}?.innerText??'')`);
  await doubleClick('本地 3');await focused('本地 4');
  await ui.waitFor(`/PS [\\s\\S]+>\\s*$/.test(${output}?.innerText??'')`);
  const verify=path.join(root,'duplicate-powershell.txt').replaceAll("'","''");
  await type(`Set-Content -LiteralPath '${verify}' -Value 'POWER_COPY_OK' -Encoding UTF8`);await enter();
  for(let n=0;n<120;n++){
    const actual=await readFile(verify,'utf8').catch(()=>null);
    if(actual?.includes('POWER_COPY_OK'))break;
    await delay(50);
  }
  assert.match(await readFile(verify,'utf8'),/POWER_COPY_OK/);
  assert.deepEqual(await names(),['本地 1','本地 2','本地 3','本地 4']);
  result.checks.push('PowerShell double-click opens one independent interactive PowerShell process');
  await tool('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  result.result='PASS';
  console.log('PASS local tab pointer drag, split, merge, cancellation and independent copies');
}catch(error){
  result.result='FAIL';
  result.error=String(error.stack);
  if(ui)await ui.screenshot('local-tabs-failure.png').catch(()=>{});
  throw error;
}finally{
  await ui?.close();
  await writeFile('artifacts/local-tabs-software-result.json',JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
