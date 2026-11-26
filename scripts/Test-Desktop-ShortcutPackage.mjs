import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const nativePicker=process.argv.includes('--native-picker');
const native=promisify(execFile);
const tmp=await realpath(tmpdir());
const own=await mkdtemp(path.join(tmp,'shared-terminal-shortcut-package-'));
const roots=['source','target'].map(name=>path.join(own,name));
const archive=path.join(own,'transfer.zip');
const marker=path.join(own,'unexpected.txt');
const evidence={...await desktopEvidence(executable),nativePicker,checks:[],result:'FAIL'};
const q=JSON.stringify;
let ui;
const mark=(name)=>{evidence.checks.push(name);console.log(name);};
const pkg=action=>ui.invoke('shortcut_transfer',{action});
const prefs=settings=>ui.invoke('local_adb_settings',{settings});
const dialog=name=>'dialog[open][aria-label='+q(name)+']';
const waitDialog=name=>ui.waitFor('!!document.querySelector('+q(dialog(name))+')');
const summary=text=>ui.waitFor('Array.from(document.querySelectorAll("dialog[open] summary")).some(node=>node.textContent.includes('+q(text)+'))');
const counts=text=>ui.waitFor('Array.from(document.querySelectorAll("dialog[open] [role=status]")).some(node=>node.textContent.includes('+q(text)+'))');
const setPicker=files=>ui.evaluate('window.shortcutPackagePicker='+q(files));
async function dismiss(label){
  await ui.waitFor('Array.from(document.querySelectorAll("dialog[open] button")).some(button=>button.textContent==='+q(label)+'&&!button.disabled)');
  await ui.click(label);
  await ui.waitFor('!document.querySelector("dialog[open]")');
}
const closeDialog=()=>dismiss('取消');
async function open(root){
  ui=await launchDesktop(root,{executable,isolatedPowerShell:true});
  if(!nativePicker)await ui.evaluate("(()=>{const original=window.fetch;window.fetch=function(url,init){"+
    "if(new URL(String(url)).pathname!='/pick_shortcut_package')return original.call(this,url,init);"+
    "const files=window.shortcutPackagePicker[JSON.parse(init.body).mode]??[];"+
    "return Promise.resolve(new Response(JSON.stringify(files.map(path=>({path,name:path}))),"+
    "{headers:{'content-type':'application/json','Tauri-Response':'ok'}}));};})()");
  await setPicker({});
}
async function picker(label,purpose,file){
  await ui.waitFor('Array.from(document.querySelectorAll("dialog[open] button")).some(button=>(button.getAttribute("aria-label")||button.textContent)==='+q(label)+'&&!button.disabled)');
  await ui.click(label);
  if(!nativePicker)return;
  const args=['-NoProfile','-File','scripts/lib/NativeImportDialog.ps1','-TargetProcessId',String(ui.app.pid),
    '-Root',own,'-Purpose',purpose,'-Action',file?'select':'cancel'];
  if(file)args.push('-TargetPath',file);
  const result=await native('pwsh',args,{windowsHide:true,encoding:'utf8',timeout:23000});
  assert.match(result.stdout,/PASS native/);
}
async function manage(){
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('轻量命令行');
  await ui.waitFor('!!document.querySelector(".pane-active .local-terminal:not([hidden])")');
  if(!await ui.evaluate('!!document.querySelector(".pane-active .adb-shortcut-panel:not([hidden])")'))await ui.click('快捷指令');
  await ui.waitFor('Array.from(document.querySelectorAll(".pane-active button")).some(b=>b.textContent==="管理"&&!b.disabled)');
  await ui.click('管理');
}
async function previewImport(file=archive){
  await setPicker({import:[file]});
  await ui.click('导入快捷指令');
  await waitDialog('导入快捷指令');
  await picker('选择 ZIP','ShortcutPackageImport',file);
}
async function selectConflict(name,decision){
  await ui.fill('冲突处理 '+name,decision);
}
const exists=file=>access(file).then(()=>true,()=>false);
try{
  await Promise.all(roots.map(root=>mkdir(root)));
  const script=path.join(own,'tree','bin','dmesg.bat');
  const asset=path.join(own,'tree','assets','config.txt');
  await mkdir(path.dirname(script),{recursive:true});await mkdir(path.dirname(asset));
  const scriptBytes=Buffer.from('@echo off\r\necho ran>"'+marker+'"\r\ntype "%~dp0..\\assets\\config.txt"\r\n');
  await writeFile(script,scriptBytes);
  await writeFile(asset,'owned attached file');
  const configured=roots.map(root=>path.join(root,'adb.exe'));
  await Promise.all(configured.map(file=>writeFile(file,'fixture path only, never executed')));
  const rootButton={id:randomUUID(),name:'root',description:'提高权限\n原文',command:'adb root',pinned:true,close_on_success:true};
  const bat={id:randomUUID(),name:'dmesg.bat',description:'读取日志',script_path:script,close_on_success:true};
  const send={id:randomUUID(),name:'发送提示',command:'OWNED SEND',desktop_kind:'send',append_enter:true};
  const missing={id:randomUUID(),name:'缺失脚本',script_path:path.join(own,'missing.bat')};
  const extra={id:randomUUID(),name:'排除样本',command:'adb devices'};
  await open(roots[0]);
  await prefs({revision:null,executable:configured[0],shortcuts:[rootButton,bat,send,missing,extra]});
  await manage();
  await setPicker({attachments:[asset],export:[archive]});
  await ui.click('导出快捷指令');
  await waitDialog('导出快捷指令');
  assert.equal(await ui.evaluate('document.querySelectorAll("dialog[open] input[type=checkbox]:checked").length'),7);
  await ui.evaluate('Array.from(document.querySelectorAll("dialog[open] label")).find(node=>node.textContent.trim()==="排除样本").querySelector("input").click()');
  await picker('添加配套文件 dmesg.bat','ShortcutAttachments',asset);
  await ui.waitFor('document.querySelector("dialog[open]").textContent.includes("配套文件（1）")');
  await ui.click('下一步：预览');
  await ui.waitFor('document.querySelector("dialog[open]").innerText.includes("指令 4 · 脚本 1 · 配套文件 1")');
  await ui.evaluate('document.querySelector("dialog[open] .shortcut-export-list > details > summary").click()');
  await summary('缺失脚本 · 缺脚本');
  await ui.evaluate('Array.from(document.querySelectorAll("dialog[open] summary")).find(node=>node.textContent==="dmesg.bat").click()');
  assert.match(await ui.evaluate('document.querySelector("dialog[open] [aria-label=包内文件]").innerText'),/assets\/config\.txt/);
  await picker('保存 ZIP','ShortcutPackageExport',archive);
  await counts('ZIP 已保存');
  assert.equal((await readFile(archive)).subarray(0,2).toString(),'PK');
  const sourceSettings=await prefs(null);
  const withoutFiles=await pkg({kind:'preview_export',revision:sourceSettings.revision,ids:[bat.id],include_scripts:false,attachments:{}});
  assert.equal(withoutFiles.rows[0].status,'missing');
  assert.deepEqual(withoutFiles.rows[0].files,[]);
  const originalZip=await readFile(archive);
  await assert.rejects(pkg({kind:'write_export',token:withoutFiles.token,path:archive}),/尚不存在/);
  assert.deepEqual(await readFile(archive),originalZip);
  await pkg({kind:'cancel',token:withoutFiles.token});
  await ui.close();ui=undefined;
  mark('Source exports a selected subset with the script, sibling attachment, and missing-script preview');

  await open(roots[1]);
  const local={id:randomUUID(),name:'本机置顶',command:'adb devices',pinned:true};
  const older={...rootButton,command:'adb devices',description:'本机旧版'};
  await manage();
  await prefs({revision:null,executable:configured[1],shortcuts:[local,older]});
  if(nativePicker){
    await ui.click('导入快捷指令');
    await waitDialog('导入快捷指令');
    await picker('选择 ZIP','ShortcutPackageImport');
    await ui.waitFor('Array.from(document.querySelectorAll("dialog[open] button")).some(button=>button.textContent==="选择 ZIP"&&!button.disabled)');
    await closeDialog();
  }
  await previewImport();
  await summary('root · 冲突');
  await summary('dmesg.bat · 新增');
  await summary('缺失脚本 · 缺脚本');
  await ui.click('确认导入');
  await counts('新增 2 · 替换 0 · 完全相同 0 · 跳过 1 · 缺脚本 1');
  let current=await prefs(null);
  assert.equal(current.executable,configured[1]);
  assert.deepEqual(current.shortcuts.map(item=>item.name),['本机置顶','root','dmesg.bat','发送提示']);
  const imported=current.shortcuts.find(item=>item.id===bat.id);
  assert.ok(imported.script_path.startsWith(path.join(roots[1],'shortcut-assets')+path.sep));
  assert.deepEqual(await readFile(imported.script_path),scriptBytes);
  assert.equal(await readFile(path.resolve(path.dirname(imported.script_path),'../assets/config.txt'),'utf8'),'owned attached file');
  assert.equal(current.shortcuts.at(-1).append_enter,true);
  assert.equal(imported.close_on_success,true);
  assert.equal(await exists(marker),false);
  await dismiss('完成');
  mark('Target preserves its own ADB path and existing order, writes the exact script and attachment, and executes neither');

  await previewImport();
  await summary('dmesg.bat · 完全相同');
  assert.equal(await ui.evaluate('document.querySelector('+q('dialog[open] [aria-label="冲突处理 root"]')+').value'),'skip');
  await selectConflict('root','keep');
  await ui.click('确认导入');
  await counts('新增 1');
  await dismiss('完成');
  current=await prefs(null);
  assert.deepEqual(current.shortcuts.map(item=>item.name),['本机置顶','root','root','dmesg.bat','发送提示']);
  await previewImport();
  await summary('root · 完全相同');
  await ui.click('确认导入');
  await counts('新增 0 · 替换 0 · 完全相同 3');
  assert.equal((await prefs(null)).revision,current.revision);
  await dismiss('完成');
  current=await prefs({...current,shortcuts:current.shortcuts.filter(item=>item.id===older.id||item.name!=='root')});
  await previewImport();
  await summary('root · 冲突');
  await selectConflict('root','replace');
  await ui.click('确认导入');
  await counts('新增 0 · 替换 1');
  assert.deepEqual((await prefs(null)).shortcuts.find(item=>item.id===rootButton.id),rootButton);
  await dismiss('完成');
  mark('Skip, keep both, replace in position, and identical re-import with no new revision');

  await previewImport();
  await summary('root · 完全相同');
  await closeDialog();
  const stale=await pkg({kind:'preview_import',path:archive});
  current=await prefs(null);
  const advanced=await prefs({...current,layout:{columns:2,expanded:false}});
  await assert.rejects(pkg({kind:'apply_import',token:stale.token,decisions:{}}),/预览已失效/);
  assert.equal((await prefs(null)).revision,advanced.revision);
  const cancelled=await pkg({kind:'preview_import',path:archive});
  await pkg({kind:'cancel',token:cancelled.token});
  await assert.rejects(pkg({kind:'apply_import',token:cancelled.token,decisions:{}}),/预览已失效/);
  mark('Cancellation and a concurrent settings revision invalidate the original receipt');

  function writeZip(file,entries){
    const payload=Buffer.from(JSON.stringify(entries)).toString('base64');
    execFileSync('pwsh',['-NoProfile','-Command',
      '$rows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OWNED_SHORTCUT_ENTRIES))|ConvertFrom-Json; '+
      '$f=[IO.File]::Create($env:OWNED_SHORTCUT_ZIP); try {$z=[IO.Compression.ZipArchive]::new($f,[IO.Compression.ZipArchiveMode]::Create); '+
      'try {foreach($row in $rows){$stream=$z.CreateEntry($row.name).Open(); try {$b=[Text.Encoding]::UTF8.GetBytes($row.text);$stream.Write($b,0,$b.Length)} finally {$stream.Dispose()}}} finally {$z.Dispose()}} finally {$f.Dispose()}'
    ],{windowsHide:true,env:{...process.env,OWNED_SHORTCUT_ZIP:file,OWNED_SHORTCUT_ENTRIES:payload}});
  }
  const bad=path.join(own,'invalid.zip'),malformed=path.join(own,'corrupt.zip');
  await writeFile(malformed,'not a ZIP');
  writeZip(bad,[{name:'../escape.txt',text:'unsafe fixture name'}]);
  for(const file of [bad,malformed]){
    await assert.rejects(pkg({kind:'preview_import',path:file}),/ZIP 无效|损坏/);
  }
  assert.equal(await exists(path.join(own,'escape.txt')),false);
  assert.equal((await prefs(null)).revision,advanced.revision);
  assert.equal(await exists(marker),false);
  mark('Invalid and traversal-named ZIP entries leave configuration and files untouched');

  const hash=text=>createHash('sha256').update(text).digest('hex');
  const resources=['rollback-a.bat','rollback-b.bat'].map(name=>{
    const text='@echo '+name;
    const item={id:randomUUID(),name};
    const files={[name]:hash(text)};
    return {entry:{item,script:name,files},payload:{name:'assets/'+item.id+'/'+name,text},
      managed:path.join(roots[1],'shortcut-assets',hash(JSON.stringify(files)))};
  });
  const blocked=path.join(own,'rollback.zip');
  writeZip(blocked,[{name:'manifest.json',text:q({version:1,entries:resources.map(resource=>resource.entry)})},
    ...resources.map(resource=>resource.payload)]);
  await writeFile(resources[1].managed,'existing unmanaged marker');
  const pending=await pkg({kind:'preview_import',path:blocked});
  await assert.rejects(pkg({kind:'apply_import',token:pending.token,decisions:{}}),/无法读写/);
  assert.equal(await exists(resources[0].managed),false);
  assert.equal(await readFile(resources[1].managed,'utf8'),'existing unmanaged marker');
  assert.equal((await prefs(null)).revision,advanced.revision);
  mark('A later resource failure removes the earlier staged files and preserves the existing data');
  evidence.result='PASS';
}catch(error){
  evidence.error=String(error.stack??error);
  if(ui)evidence.dialog=await ui.evaluate('document.querySelector("dialog[open]")?.innerText').catch(()=>undefined);
  throw error;
}finally{
  try{await ui?.close();}
  finally{
    await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
    assert.equal(path.dirname(own),tmp);
    assert.ok(path.basename(own).startsWith('shared-terminal-shortcut-package-'));
    await rm(own,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
