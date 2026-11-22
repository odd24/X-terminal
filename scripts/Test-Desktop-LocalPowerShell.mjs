import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]??'target/debug/shared-terminal-desktop.exe');
const hardware=process.argv.includes('--hardware');
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-powershell-中文-'));
const result={result:'IN_PROGRESS',executable,scope:hardware?'one authorized Android device':'isolated PowerShell and simulated ADB',checks:[]};
const visible='.local-terminal:not([hidden])';
const screen=`document.querySelector('${visible} .local-terminal-output')?.innerText`;
let ui;
const saw=marker=>ui.waitFor(`${screen}?.includes(${JSON.stringify(marker)})`);
const focus=()=>ui.waitFor(`!!document.activeElement?.closest('${visible}')&&document.activeElement?.matches('.xterm-helper-textarea')`);
const waitShell=()=>ui.waitFor(`/PS [^\\n]+>\\s*$/.test(${screen}??'')`);
const key=async (key,code,windowsVirtualKeyCode,modifiers=0)=>{
  for(const type of ['keyDown','keyUp']) await ui.command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode,modifiers});
};
const enter=()=>key('Enter','Enter',13);
const type=text=>ui.command('Input.insertText',{text});
const command=async text=>{await focus();await type(text);await enter();};
const foreground=running=>ui.waitFor(`document.querySelector('${visible}')?.dataset.foreground===${JSON.stringify(String(running))}`);
const selected=name=>ui.waitFor(`document.querySelector('.pane-active [role="tab"][aria-selected="true"]')?.textContent===${JSON.stringify(name)}`);
const decode=bytes=>bytes[0]===255&&bytes[1]===254?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8').replace(/^\uFEFF/,'');
const psPath=value=>"'"+value.replaceAll("'","''")+"'";
async function waitFile(name, expected) {
  for(let n=0;n<120;n++){
    const actual=await readFile(path.join(root,name)).catch(()=>null);
    if(actual&&decode(actual).trim()===expected)return;
    await delay(50);
  }
  assert.fail('expected file result: '+name);
}
async function openDefault(number=1) {
  if(number!==1)await ui.evaluate("document.querySelector('.pane-active .new-menu summary').click()");
  const start=performance.now();
  await ui.click('本地终端（PowerShell）');
  await selected('本地 '+number);
  await focus();
  await waitShell();
  assert.equal(await ui.evaluate(`document.querySelector('${visible}')?.dataset.mode`),'powershell');
  assert.equal(await ui.evaluate('!!document.querySelector(".local-prompt, input[aria-label=\'本地命令输入\']")'),false);
  return performance.now()-start;
}
async function seedAdb(image, shortcuts) {
  return ui.invoke('local_adb_settings',{settings:{revision:null,executable:image,shortcuts:shortcuts.map(([name,command])=>({id:crypto.randomUUID(),name,command}))}});
}
async function close() {
  await ui.evaluate("document.querySelector('details.tools-menu summary').click()");
  await ui.click('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
}

try {
  const systemPs=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const summary=() => JSON.parse(execFileSync(systemPs,['-NoLogo','-Command',
    '@{version=$PSVersionTable.PSVersion.ToString();profile=(Test-Path $PROFILE);adb=(Get-Command adb.exe -ErrorAction SilentlyContinue).Source}|ConvertTo-Json -Compress'
  ],{windowsHide:true,encoding:'utf8'}));
  const externalStart=performance.now();
  result.external=summary();
  result.externalCommandMs=performance.now()-externalStart;
  let target;
  if(hardware){
    assert.ok(result.external.adb,'external PowerShell can resolve adb.exe');
    const rows=execFileSync(result.external.adb,['devices','-l'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/);
    const header=rows.findIndex(line=>line.trim()==='List of devices attached');
    assert.ok(header>=0);
    const devices=rows.slice(header+1).map(row=>row.trim()).filter(Boolean);
    assert.equal(devices.length,1,'exactly one explicitly authorized device is required');
    target=devices[0].split(/\s+/);
    assert.equal(target[1],'device');
    result.inventory={devices:1,state:'device',usedSpaces:!devices[0].includes('\t')};
  }
  ui=await launchDesktop(root,{executable});
  if(hardware){
    await seedAdb(null,[['授权设备 shell','adb shell']]);
    result.firstPromptMs=await openDefault();
    await ui.click('快捷指令');
    await ui.waitFor('!!document.querySelector(".adb-shortcut-run[aria-label=\'授权设备 shell\']")');
    await ui.click('授权设备 shell');
    await selected('本地 2');await focus();await foreground(true);
    await ui.waitFor(`/[#$]\\s*$/.test(${screen}??'')`);
    // The only inputs delivered to the device are pwd and exit.
    await command('pwd');
    await ui.waitFor(`/^\\s*\\/[^\\r\\n]*$/m.test(${screen}??'')`);
    await command('exit');await foreground(false);await saw('前台进程退出（0）');
    await ui.click('授权设备 shell 的管理操作');
    await ui.click('查看最近诊断');
    const diagnostic=await ui.evaluate('document.querySelector("[aria-label=\'最近 ADB 诊断\']")?.innerText');
    assert.ok(diagnostic?.includes(result.external.adb));
    assert.ok(diagnostic.includes(target[0]));
    result.checks.push('actual received prompt, pwd output, exit 0 and exact resolved image; serial redacted from report');
  }else{
    await mkdir(path.join(root,'补全 目录'));
    await writeFile(path.join(root,'only-complete-样本.txt'),'completion-payload');
    const adb=path.join(root,'adb.exe');
    execFileSync('rustc',['--edition=2024','tests/fixtures/local-adb.rs','-o',adb],{windowsHide:true});
    await writeFile(path.join(root,'fixture-root.txt'),root);
    await writeFile(path.join(root,'inventory.txt'),'prepared       device product:synthetic\n');
    await seedAdb(adb,[['模拟设备 shell','adb shell']]);
    result.firstPromptMs=await openDefault();
    await command(`Set-Location -LiteralPath ${psPath(root)}`);
    await waitShell();
    await command(`@{version=$PSVersionTable.PSVersion.ToString();profile=(Test-Path $PROFILE);adb=(Get-Command adb.exe -ErrorAction SilentlyContinue).Source}|ConvertTo-Json -Compress > 'shell.json'`);
    let shell;
    for(let n=0;n<80&&!shell;n++){
      const bytes=await readFile(path.join(root,'shell.json')).catch(()=>null);
      if(bytes){try{shell=JSON.parse(decode(bytes));}catch{/* redirection can create the file before writing */}}
      if(!shell)await delay(40);
    }
    assert.deepEqual(shell,result.external);
    result.checks.push('same Windows PowerShell version, profile presence and PATH adb as ordinary external PowerShell');
    await focus();await type('Get-Content .\\only-com');await key('Tab','Tab',9);await saw('only-complete-样本.txt');
    await enter();await saw('completion-payload');
    await command("'alpha','beta' | Where-Object { $_ -eq 'beta' } > 'pipeline.txt'");
    await waitFile('pipeline.txt','beta');
    await command("Set-Content 'start.txt' started; Start-Sleep -Seconds 20; Set-Content 'unexpected.txt' did-not-stop");
    await waitFile('start.txt','started');await key('c','KeyC',67,2);await waitShell();
    await command("Set-Content 'after.txt' '中文可继续' -Encoding UTF8");
    await waitFile('after.txt','中文可继续');
    assert.equal(await readFile(path.join(root,'unexpected.txt')).catch(()=>null),null);
    result.checks.push('Tab completion, pipeline and redirection bytes, Ctrl+C stops running pipeline, Chinese survives terminal input');
    await focus();await type("Set-Content 'draft.txt' '原草稿' -Encoding UTF8");
    await ui.click('快捷指令');
    await ui.waitFor('!!document.querySelector(".adb-shortcut-run[aria-label=\'模拟设备 shell\']")');
    await ui.click('模拟设备 shell');
    await selected('本地 2');await focus();await saw('ADB_FIXTURE_FOREGROUND');
    await command('synthetic-input');await saw('ADB_FIXTURE_ECHO:synthetic-input');
    await ui.click('本地 1');await selected('本地 1');await focus();await enter();
    await waitFile('draft.txt','原草稿');
    assert.equal((await readFile(path.join(root,'adb-calls.txt'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('shell|')).length,1);
    await ui.screenshot('windows-0.1.15-powershell.png');
    result.checks.push('shortcut launches one interactive child in its own focused terminal and preserves original PowerShell draft');
    result.repeatedPromptMs=[];
    for(let number=3;number<=5;number++){
      result.repeatedPromptMs.push(await openDefault(number));
      await ui.click('关闭 本地 '+number);
      await ui.waitFor(`!document.querySelector('[aria-label="关闭 本地 ${number}"]')`);
    }
  }
  await close();
  result.result='PASS';
}catch(error){
  result.result='FAIL';result.error=String(error.stack);
  if(ui&&!hardware){await ui.screenshot('windows-0.1.15-powershell-failure.png').catch(()=>{});result.screen=await ui.evaluate(screen).catch(String);}
  throw error;
}finally{
  await writeFile(hardware?'artifacts/local-powershell-device-result.json':'artifacts/local-powershell-software-result.json',JSON.stringify(result,null,2));
  await ui?.close();
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
