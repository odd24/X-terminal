import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {launchDesktop, delay} from './lib/DesktopHarness.mjs';

const root = await mkdtemp(path.join(await realpath(tmpdir()), 'shared-terminal-local-mixed-中文-'));
const sshRoot = path.join(root,'ssh');
const ref = c=>({connection_id:c.connection_id,generation:c.generation});
let server, ui;
try {
  await mkdir(sshRoot);
  server=spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'),[sshRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const output=createInterface({input:server.stdout});
  const [line]=await once(output,'line');
  const data=JSON.parse(line);
  ui=await launchDesktop(root,{fixture:true});
  const ssh=request=>ui.invoke('ssh_request',{request});
  const config=request=>ui.invoke('config_request',{request});
  const profile={id:crypto.randomUUID(),folder_id:null,name:'local route SSH',settings:{
    protocol:'ssh2',host:'127.0.0.1',port:data.port,username:'synthetic',auth:'password',encoding:'utf8',
  }};
  await config({op:'save_profile',profile,credential:{action:'replace',value:{password:data.password,private_key:null,passphrase:null}}});
  const started=await ssh({op:'start',profile_id:profile.id,request_id:crypto.randomUUID(),cols:80,rows:24});
  const target=ref(started.connection), answered=new Set();
  for(let n=0;n<100;n++){
    const status=await ssh({op:'status',connection:target});
    assert.notEqual(status.connection.state,'FAILED');
    if(status.connection.state==='CONNECTED') break;
    const challenge=status.challenge;
    if(challenge&&!answered.has(challenge.id)){
      answered.add(challenge.id);
      if(challenge.kind==='host_key'){
        assert.equal(challenge.review.candidate.fingerprint,data.pin);
        await ssh({op:'answer_host',connection:target,challenge_id:challenge.id,approve:true});
      }else if(challenge.kind==='credentials'){
        await ssh({op:'authenticate',connection:target,challenge_id:challenge.id,use_saved:true,password:null});
      }
    }
    await delay(40);
  }
  assert.equal((await ssh({op:'status',connection:target})).connection.state,'CONNECTED');
  await ui.click('串口连接');
  await ui.waitFor('document.querySelector(\'[aria-label="UART端口"]\')?.options.length===2');
  await ui.fill('UART端口',await ui.evaluate('document.querySelector(\'[aria-label="UART端口"]\').options[1].value'));
  await ui.click('连接串口');
  await ui.waitFor('!document.querySelector("dialog:modal")');
  const uart=(await ui.invoke('service_list')).find(c=>c.protocol==='SERIAL'&&c.state==='CONNECTED');
  assert.ok(uart);
  const raw=async c=>Buffer.from((await ui.invoke('service_read',{connection:ref(c),cursor:1})).events.flatMap(event=>event.bytes)).toString();
  await ui.selectTab(target.connection_id);
  const ready=async connection=>ui.waitFor(`document.querySelector('.pane-active')?.dataset.renderedId===${JSON.stringify(connection.connection_id)}`);
  await ready(target);
  await ui.command('Input.insertText',{text:'SSH_ROUTE_ONLY'});
  for(let n=0;n<80&&!(await raw(target)).includes('SSH_ROUTE_ONLY');n++)await delay(30);
  assert.match(await raw(target),/SSH_ROUTE_ONLY/);
  assert.doesNotMatch(await raw(uart),/SSH_ROUTE_ONLY/);

  const fixture=path.join(root,'foreground.cjs');
  await writeFile(fixture,`process.stdin.setRawMode(true); let n=0;
    setInterval(()=>{if(++n<=150)process.stdout.write('LOCAL_TAIL_'+n+'\\n');},12);
    process.stdin.on('data',bytes=>{if(bytes.includes(3)){process.stdout.write('LOCAL_STOPPED\\n',()=>process.exit(130));}
      else process.stdout.write('LOCAL_ECHO_'+bytes.toString('utf8')+'\\n');});`);
  await ui.evaluate("document.querySelector('details.tools-menu').open=true");
  await ui.click('轻量命令行');
  const prompt='.local-terminal:not([hidden])[data-foreground="false"] .xterm-helper-textarea';
  await ui.waitFor(`document.activeElement?.matches(${JSON.stringify(prompt)})`);
  await ui.command('Input.insertText',{text:`"${process.execPath}" "${fixture}"`});
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await ui.waitFor('document.querySelector(".local-terminal-output").innerText.includes("LOCAL_TAIL_")');
  assert.equal(await ui.evaluate('document.querySelector(".toolbar-log").disabled'),true);
  await ui.selectTab(uart.connection_id);
  await ready(uart);
  await ui.command('Input.insertText',{text:'UART_ROUTE_ONLY'});
  await delay(250);
  assert.doesNotMatch(await raw(target),/UART_ROUTE_ONLY/);
  await ui.selectTab(target.connection_id);
  await ready(target);
  await ui.command('Input.insertText',{text:'SSH_RETURN'});
  for(let n=0;n<80&&!(await raw(target)).includes('SSH_RETURN');n++)await delay(30);
  assert.match(await raw(target),/SSH_RETURN/);
  await ui.click('本地 1');
  await ui.waitFor('!!document.activeElement?.closest(".local-terminal")');
  await ui.waitFor('document.querySelector(".local-terminal-output").innerText.includes("LOCAL_TAIL_150")');
  await ui.command('Input.insertText',{text:'OWNED_LOCAL'});
  await ui.waitFor('document.querySelector(".local-terminal-output").innerText.includes("LOCAL_ECHO_OWNED_LOCAL")');
  assert.doesNotMatch(await raw(target),/OWNED_LOCAL/);
  assert.doesNotMatch(await raw(uart),/OWNED_LOCAL/);
  await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
  await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
  await ui.waitFor('document.querySelector(".local-terminal-output").innerText.includes("LOCAL_STOPPED")');
  await ui.waitFor(`document.activeElement?.matches(${JSON.stringify(prompt)})`);
  await ui.evaluate("document.querySelector('details.tools-menu summary').click()");
  await ui.click('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  await writeFile('artifacts/local-route-software-result.json', JSON.stringify({result:'PASS',
    SSH2:'loopback exact keyboard echo and post-switch return', SERIAL:'memory UART connected independently',
    local:'150 background lines, local input echoed once, Ctrl+C and final output, no remote log target'},null,2));
} catch(error) {
  if(ui)await ui.screenshot('local-route-software-failure.png').catch(()=>{});
  throw error;
} finally {
  await ui?.close();
  if(server&&server.exitCode===null){server.stdin.end();await once(server,'exit');}
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
