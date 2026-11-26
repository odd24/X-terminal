import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';
import {desktopKeyboard} from './lib/DesktopKeyboard.mjs';

const exe=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const baseline=process.argv.includes('--baseline');
const temp=await realpath(tmpdir());
const root=await mkdtemp(path.join(temp,'shared-terminal-export-layout-'));
const evidence={...await desktopEvidence(exe),checks:[],viewports:[],result:'FAIL'};
const dialog='dialog[open][aria-label="导出快捷指令"]';
const node=selector=>'document.querySelector('+JSON.stringify(selector)+')';
const q=JSON.stringify;
let ui;
const has=text=>ui.waitFor(node(dialog)+'?.innerText.includes('+q(text)+')');
const check=name=>{evidence.checks.push(name);console.log(name);};
async function screenshot(name){
  const file=path.join(path.dirname(report),name+'.png');
  const shot=await ui.command('Page.captureScreenshot',{format:'png'});
  await writeFile(file,Buffer.from(shot.data,'base64'));
}
async function resize(width,height){
  const old=await ui.evaluate('[innerWidth,innerHeight]');
  const measured=JSON.parse(execFileSync('pwsh',['-NoProfile','-File','scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId',String(ui.app.pid),'-ExpectedExecutable',exe,'-Width',String(width),'-Height',String(height),'-PhysicalSize'],
    {encoding:'utf8',windowsHide:true,timeout:15000}));
  assert.deepEqual([measured.width,measured.height],[width,height]);
  if(height<700)await ui.waitFor('innerHeight<'+old[1]);
  evidence.viewports.push({measured,webview:await ui.evaluate('[innerWidth,innerHeight]')});
}
try{
  const script=path.join(root,'dmesg.bat'),attachment=path.join(root,'配套参数.txt');
  const removed=path.join(root,'待移除.txt');
  await writeFile(script,'@echo off\r\necho synthetic\r\n');
  await writeFile(attachment,'owned fixture');
  await writeFile(removed,'remove from draft only');
  const long='读取板端音视频信号及系统事件的诊断命令'.repeat(3);
  const items=[
    {id:randomUUID(),name:'root',command:'adb root',pinned:true},
    {id:randomUUID(),name:'dmesg.bat',script_path:script},
    {id:randomUUID(),name:'离线排查.bat',script_path:path.join(root,'missing.bat')},
    {id:randomUUID(),name:long,command:'adb devices'},
    ...Array.from({length:14},(_,i)=>({id:randomUUID(),name:'诊断命令 '+(i+1),command:'adb devices -l'})),
  ];
  ui=await launchDesktop(root,{executable:exe,isolatedPowerShell:true,windowsHide:false});
  await resize(1100,760);
  await ui.invoke('local_adb_settings',{settings:{revision:null,executable:null,shortcuts:items}});
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('轻量命令行');
  await ui.waitFor('!!document.querySelector(".pane-active .local-terminal:not([hidden])")');
  if(!await ui.evaluate('!!document.querySelector(".pane-active .adb-shortcut-panel:not([hidden])")'))await ui.click('快捷指令');
  await ui.waitFor('Array.from(document.querySelectorAll(".pane-active button")).some(b=>b.textContent==="管理"&&!b.disabled)');
  await ui.click('管理');
  await ui.click('导出快捷指令');
  await ui.waitFor('!!'+node(dialog));
  if(baseline){
    await has('预览导出');
    const old=await ui.evaluate('(()=>{const r='+node(dialog+' .shortcut-transfer-rows')+'; const label=r.querySelector("label");'+
      'return {direction:getComputedStyle(label).flexDirection,checkbox:Math.round(label.querySelector("input").getBoundingClientRect().width),label:Math.round(label.getBoundingClientRect().width)};})()');
    assert.equal(old.direction,'column');
    assert.ok(old.checkbox>=old.label-2);
    evidence.baseline=old;
    await screenshot('baseline-1100x760');
    check('Baseline shows a full-width checkbox above the name');
  }else{
    const keys=desktopKeyboard(ui,[]);
    const space=()=>keys.key(' ','Space',32);
    const tabKey=()=>keys.key('Tab','Tab',9);
    const active=()=>ui.evaluate('document.activeElement?.closest("label")?.textContent??document.activeElement?.textContent');
    const next=node(dialog+' .shortcut-export-footer .primary-action');
    const rows=dialog+' .shortcut-export-row';
    const selectAll=node(dialog+' .shortcut-export-tally input');
    const file=path.join(root,'layout.zip');
    await ui.evaluate("window.layoutPick={attachments:"+q([attachment,removed])+",export:"+q([file])+"};"+
      "(()=>{const original=window.fetch;window.fetch=function(url,init){"+
      "if(new URL(String(url)).pathname!='/pick_shortcut_package')return original.call(this,url,init);"+
      "const files=window.layoutPick[JSON.parse(init.body).mode]??[];"+
      "return Promise.resolve(new Response(JSON.stringify(files.map(path=>({path,name:path}))),"+
      "{headers:{'content-type':'application/json','Tauri-Response':'ok'}}));};})()");
    const layout=()=>ui.evaluate("(()=>{const d="+node(dialog)+",list=d.querySelector('.shortcut-export-list'),"+
      "foot=d.querySelector('.shortcut-export-footer');return {dialogX:d.scrollWidth-d.clientWidth,dialogY:d.scrollHeight-d.clientHeight,"+
      "dialogOverflow:getComputedStyle(d).overflowY,listX:list.scrollWidth-list.clientWidth,listY:list.scrollHeight-list.clientHeight,"+
      "footer:Math.round(foot.getBoundingClientRect().top),footerBottom:Math.round(foot.getBoundingClientRect().bottom),"+
      "rowBounds:[...list.querySelectorAll('.shortcut-export-row label')].map(label=>{const a=label.querySelector('input').getBoundingClientRect(),"+
      "b=label.querySelector('span').getBoundingClientRect();return {width:a.width,gap:b.left-a.right,"+
      "offset:Math.abs(a.top+a.height/2-b.top-b.height/2),height:label.parentElement.getBoundingClientRect().height};})};})()");
    function checkLayout(result,scroll=true){
      assert.ok(result.dialogX<=1&&result.listX<=1&&result.dialogY<=2&&result.dialogOverflow==='hidden',JSON.stringify(result));
      if(scroll)assert.ok(result.listY>0,'the list should scroll with 18 rows');
      assert.ok(result.footerBottom<=evidence.viewports.at(-1).webview[1]+1);
      assert.ok(result.rowBounds.every(row=>row.width<24&&row.gap>=0&&row.gap<14&&row.offset<2&&row.height<=43));
    }
    await has('已选 18 / 18');
    assert.equal(await active(),'包含指令引用的脚本文件');
    const initial=await layout();
    checkLayout(initial);
    assert.deepEqual(await ui.evaluate('Array.from(document.querySelectorAll('+q(rows+' .shortcut-export-name')+'),el=>el.textContent)'),items.map(item=>item.name));
    assert.equal(await ui.evaluate('document.querySelectorAll('+q(rows+' button')+').length'),2);
    await screenshot('selection-1100x760');
    await tabKey();
    assert.equal(await active(),'全选');
    await space();
    await has('已选 0 / 18');
    assert.equal(await ui.evaluate(next+'.disabled'),true);
    await space();
    await has('已选 18 / 18');
    await ui.evaluate(node(rows+' label[title="root"] .shortcut-export-name')+'.click()');
    await has('已选 17 / 18');
    assert.deepEqual(await ui.evaluate('['+selectAll+'.checked,'+selectAll+'.indeterminate]'),[false,true]);
    await ui.evaluate(selectAll+'.focus()');
    await space();
    await has('已选 18 / 18');
    await ui.evaluate(node(rows+' label[title="root"] .shortcut-export-name')+'.click()');
    await has('已选 17 / 18');
    assert.equal(await ui.evaluate('(()=>{const label=Array.from(document.querySelectorAll('+q(rows+' label')+')).find(label=>label.title==='+q(long)+');'+
      'const name=label.querySelector("span");return name.textContent===label.title&&name.scrollWidth>name.clientWidth&&getComputedStyle(name).textOverflow==="ellipsis";})()'),true);
    check('Original order, keyboard select all, mixed state, label toggle, zero-selected guard and full-name tooltip');

    await ui.click('添加配套文件 dmesg.bat');
    await has('配套文件（2）');
    await ui.click('配套文件（2） dmesg.bat');
    await has('待移除.txt');
    await ui.click('移除配套文件 '+removed);
    await ui.waitFor('!'+node(dialog)+'?.innerText.includes("待移除.txt")');
    await ui.click('返回选择');
    await has('配套文件（1）');
    assert.equal(await ui.evaluate('document.activeElement?.getAttribute("aria-label")'),'配套文件（1） dmesg.bat');
    assert.equal(await readFile(removed,'utf8'),'remove from draft only');
    check('Attachment management preserves one row per script and removes only the draft reference');

    await resize(670,500);
    const small=await layout();
    checkLayout(small);
    await ui.evaluate(node(dialog+' .shortcut-export-list')+'.scrollTop=300');
    assert.equal((await layout()).footer,small.footer);
    await ui.evaluate(node(dialog+' .shortcut-export-list')+'.scrollTop=0');
    await screenshot('selection-670x500');
    await ui.evaluate(next+'.focus()');
    await keys.enter();
    await has('指令 17 · 脚本 1 · 配套文件 1');
    await has('离线排查.bat');
    assert.equal(await ui.evaluate(node(dialog+' .shortcut-export-list details')+'.open'),false);
    checkLayout(await layout(),false);
    await screenshot('preview-670x500');
    await ui.evaluate(node(dialog+' .shortcut-export-list > details > summary')+'.click()');
    await ui.evaluate('Array.from(document.querySelectorAll('+q(dialog+' .shortcut-export-list summary')+')).find(node=>node.textContent==="dmesg.bat").click()');
    await has('配套参数.txt');
    assert.ok(await ui.evaluate(node(dialog+' .shortcut-export-list')+'.scrollWidth<='+node(dialog+' .shortcut-export-list')+'.clientWidth+1'));
    await ui.click('返回选择');
    await has('已选 17 / 18');
    await has('配套文件（1）');
    await resize(1100,760);
    await ui.click('下一步：预览');
    await has('指令 17 · 脚本 1 · 配套文件 1');
    await screenshot('preview-1100x760');
    await ui.click('保存 ZIP');
    await has('ZIP 已保存');
    assert.equal((await readFile(file)).subarray(0,2).toString(),'PK');
    check('Normal and narrow native layouts keep a fixed footer, collapsed manifest, named omissions and the same draft on return');
    evidence.layout={initial,small};
  }
  evidence.result='PASS';
}catch(error){
  evidence.error=String(error.stack??error);
  if(ui)await screenshot(baseline?'baseline-failure':'layout-failure').catch(()=>{});
  throw error;
}finally{
  try{await ui?.close();}
  finally{
    await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
    assert.equal(path.dirname(root),temp);
    assert.ok(path.basename(root).startsWith('shared-terminal-export-layout-'));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
