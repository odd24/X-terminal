import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {launchDesktop, delay} from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'shared-terminal-local-ui-中文-'));
const options = process.argv.slice(2);
const image = options.find(arg=>!arg.startsWith('--'));
const executable = image ? path.resolve(image) : undefined;
const measurePowerShell = options.includes('--powershell-baseline');
const outputFile = measurePowerShell?'artifacts/local-terminal-performance-result.json':'artifacts/local-terminal-software-result.json';
const prompt = '.local-terminal:not([hidden]) input[aria-label="本地命令输入"]';
const output = '.local-terminal:not([hidden]) .local-terminal-output';
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
const evidence = {result:'IN_PROGRESS', executable:executable??path.resolve('target/debug/shared-terminal-desktop.exe'), samples:[]};
let ui;
const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
  await ui.command('Input.dispatchKeyEvent', {type:'keyDown', key, code, windowsVirtualKeyCode, modifiers});
  await ui.command('Input.dispatchKeyEvent', {type:'keyUp', key, code, windowsVirtualKeyCode, modifiers});
};
const waitPrompt = () => ui.waitFor(`document.activeElement?.matches(${JSON.stringify(prompt)})`);
const contents = selector => `document.querySelector(${JSON.stringify(selector)})?.innerText`;
async function waitOutput(marker) {
  await ui.waitFor(`${contents(output)}?.includes(${JSON.stringify(marker)})`);
}
async function run(line, expected, idle = true) {
  await waitPrompt();
  await ui.command('Input.insertText', {text:line});
  await key('Enter', 'Enter', 13);
  if (expected) await waitOutput(expected);
  if (idle) await waitPrompt();
}
async function open(name) {
  const start = performance.now();
  if (name !== '本地 1') {
    await ui.evaluate("document.querySelector('details.new-menu').querySelector('summary').click()");
  }
  await ui.click('本地命令行');
  await waitPrompt();
  await ui.command('Input.insertText', {text:'x'});
  await ui.waitFor(`document.querySelector(${JSON.stringify(prompt)})?.value==='x'`);
  evidence.samples.push(performance.now() - start);
  await key('Backspace', 'Backspace', 8);
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), '');
}

try {
  const fixture = path.join(directory, '测试 参数.cjs');
  const target = path.join(directory, '测试 目录');
  const argv = ['', '中文 空格', 'a"b', 'echo x | echo y', '尾部\\'];
  await mkdir(target);
  await writeFile(fixture, `
    const args = process.argv.slice(2);
    if (args[0] === 'lost') {
      require('node:fs').appendFileSync('lost-count.txt','one\\n');
      setTimeout(()=>process.stdout.write('LOST_TAIL\\n'),300);
    } else if (args[0] === 'interactive') {
      process.stdin.setRawMode(true);
      process.stdout.write('READY:' + process.pid + '\\n');
      process.stdin.on('data', bytes => {
        if (bytes.includes(3)) { process.stdout.write('INTERRUPTED\\n', () => process.exit(130)); return; }
        process.stdout.write('ECHO:' + bytes.toString('utf8') + '\\n');
      });
    } else {
      require('node:fs').writeFileSync('收到.json', JSON.stringify({cwd:process.cwd(), args}));
      process.stdout.write('ARGV_TAIL\\n', () => process.exit(7));
    }
  `, 'utf8');
  ui = await launchDesktop(directory, {executable});
  for (let n=1; n<=11; n++) {
    await open('本地 '+n);
    if (n>1) {
      await ui.click('关闭 本地 '+n);
      await ui.click('本地 1');
      await waitPrompt();
    }
  }
  const tabB = '本地 12';
  await run('cd ' + quote(target));
  await ui.waitFor(`document.querySelector(${JSON.stringify(prompt)})?.previousElementSibling.title===${JSON.stringify(target)}`);
  await run('git --version', 'git version');
  await run('fastboot --version', 'fastboot version');
  const node = quote(process.execPath);
  await run([node, quote(fixture), ...argv.map(quote)].join(' '), '前台进程退出（7）');
  const received = JSON.parse(await readFile(path.join(target, '收到.json'), 'utf8'));
  assert.deepEqual(received, {cwd:target, args:argv});
  await waitOutput('ARGV_TAIL');
  await ui.evaluate(`(()=>{
    const original=window.fetch;
    window.__localReply={original,count:0};
    window.fetch=async function(input,init){
      const response=await original.call(this,input,init);
      if(new URL(String(input)).pathname==='/local_terminal'&&JSON.parse(init?.body??'{}').action?.kind==='run'){
        window.__localReply.count++;
        const headers=new Headers(response.headers);
        headers.set('Tauri-Response','error');
        headers.set('content-type','application/json');
        return new Response('"lost after native acceptance"',{status:response.status,headers});
      }
      return response;
    };
  })()`);
  await run([node,quote(fixture),'lost'].join(' '),'LOST_TAIL');
  assert.equal(await ui.evaluate('window.__localReply.count'),1);
  await ui.evaluate('window.fetch=window.__localReply.original;delete window.__localReply');
  assert.equal(await readFile(path.join(target,'lost-count.txt'),'utf8'),'one\n');
  evidence.lostLaunch = 'one native invocation; original status and tail recovered';
  await run('no-local-such-tool', 'PATH 中找不到');
  await run('git "unclosed', '双引号未闭合');
  await run('git --version | more', '本地入口只运行单条命令');
  await key('ArrowUp','ArrowUp',38);
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(prompt)}).value`), 'git --version | more');
  await key('c','KeyC',67,2);
  await run([node, quote(fixture), 'interactive'].join(' '), 'READY:', false);
  const text = await ui.evaluate(contents(output));
  const pid = Number(text.match(/READY:(\d+)/)?.[1]);
  assert.ok(pid > 0);
  await open(tabB);
  await run('pwd');
  assert.notEqual(await ui.evaluate(`document.querySelector(${JSON.stringify(prompt)}).previousElementSibling.title`), target);
  await ui.click('本地 1');
  await ui.waitFor('document.activeElement?.matches(".local-terminal:not([hidden]) .xterm-helper-textarea")');
  evidence.echoMs = [];
  for(const value of ['中文','a','b','d','e','f','g','h','i','j']) {
    const start = performance.now();
    await ui.command('Input.insertText',{text:value});
    await waitOutput('ECHO:'+value);
    evidence.echoMs.push(performance.now()-start);
  }
  await key('c','KeyC',67,2);
  await waitOutput('已中断');
  await waitPrompt();
  assert.throws(() => process.kill(pid,0), error=>error.code==='ESRCH');
  await waitOutput('INTERRUPTED');
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(prompt)}).previousElementSibling.title`), target);
  assert.equal(await ui.evaluate('document.querySelector(".toolbar-log").disabled'), true);
  await run([node, quote(fixture), 'interactive'].join(' '), 'READY:', false);
  await delay(300);
  const runningText = await ui.evaluate(contents(output));
  const activePid = Number(Array.from(runningText.matchAll(/READY:(\d+)/g)).at(-1)?.[1]);
  assert.ok(activePid > 0 && activePid !== pid);
  await ui.click('关闭 本地 1');
  await ui.waitFor('!document.querySelector("[aria-label=\'关闭 本地 1\']")');
  assert.throws(() => process.kill(activePid,0), error=>error.code==='ESRCH');
  await ui.click(tabB);
  await waitPrompt();
  assert.deepEqual(await ui.invoke('service_list'), []);
  await ui.screenshot('local-terminal-software.png');
  if(measurePowerShell) evidence.powerShellConptyMs = [];
  for(let n=0;measurePowerShell&&n<11;n++) {
    const start = performance.now();
    const marker = 'PSBASE'+n+'>';
    await run(`pwsh -NoLogo -NoProfile -NoExit -Command "function prompt { '${marker} ' }"`, undefined, false);
    await ui.waitFor('document.activeElement?.matches(".local-terminal:not([hidden]) .xterm-helper-textarea")');
    await waitOutput(marker);
    await ui.command('Input.insertText',{text:'test'+n});
    await waitOutput(marker+' test'+n);
    evidence.powerShellConptyMs.push(performance.now()-start);
    await key('c','KeyC',67,2);
    await ui.command('Input.insertText',{text:'exit'});
    await key('Enter','Enter',13);
    await waitPrompt();
  }
  await ui.evaluate("document.querySelector('details.tools-menu summary').click()");
  await ui.click('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let i=0;i<200&&ui.app.exitCode===null;i++) await delay(50);
  assert.equal(ui.app.exitCode,0);
  await ui.close();
  ui = await launchDesktop(directory, {executable});
  assert.equal(await ui.evaluate('document.querySelectorAll(".local-terminal").length'),0);
  evidence.result = 'PASS';
  evidence.scope = ['isolated ordinary Windows WebView', '11 open-to-first-character observations', 'git, fastboot and controlled Node child', 'Chinese directory and exact argv', 'separate cwd and history, non-zero exit and launch diagnostics', 'background interactive process, key routing, interrupt, tail and PID teardown', 'remote log target disabled', 'managed exit and reopening without tasks'];
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = String(error.stack);
  if (ui) {
    await ui.screenshot('local-terminal-software-failure.png').catch(()=>{});
    evidence.window = await ui.evaluate('document.body.innerText').catch(String);
  }
  throw error;
} finally {
  await writeFile(outputFile, JSON.stringify(evidence,null,2));
  await ui?.close();
  await rm(directory,{recursive:true, force:true,maxRetries:10,retryDelay:100});
}
