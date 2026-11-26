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
  if(height<700)await ui.waitFor('innerHeight<'+old[1]);
  evidence.viewports.push({measured,webview:await ui.evaluate('[innerWidth,innerHeight]')});
}
try{
  const script=path.join(root,'dmesg.bat'),attachment=path.join(root,'配套参数.txt');
  await writeFile(script,'@echo off\r\necho synthetic\r\n');
  await writeFile(attachment,'owned fixture');
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
