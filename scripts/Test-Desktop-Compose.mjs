import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-compose-ui-中文-'));
const fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
let ui;
try {
  const server = await Promise.race([lines.next().then(item => JSON.parse(item.value)), delay(10000).then(() => { throw new Error('fixture startup timeout'); })]);
  ui = await launchDesktop(directory, { fixture: true });
  const profile = { id: crypto.randomUUID(), folder_id: null, name: '撰写合成SSH', settings: { protocol:'ssh2', host:'127.0.0.1', port:server.port, username:'synthetic', auth:'password', encoding:'utf8' } };
  await ui.invoke('config_request', { request: { op:'save_profile', profile, credential:{action:'replace',value:{password:server.password,private_key:null,passphrase:null}} } });
  await ui.click('SSH2 连接');
  await ui.waitFor(`document.querySelector('[aria-label="SSH2 配置"]').options.length===2`);
  await ui.fill('SSH2 配置',profile.id);
  const button = label => `Array.from(document.querySelectorAll('button')).find(item=>item.textContent===${JSON.stringify(label)})`;
  const previewSend=async()=>{
    await ui.waitFor(`!!(${button('预览撰写发送')})&&!(${button('预览撰写发送')}).disabled`);
    await ui.click('预览撰写发送');
    await ui.waitFor(`!!(${button('确认发送撰写')})`);
  };

  async function connect(first=false) {
    await ui.click('建立 SSH2 连接');
    if(first) {
      await ui.waitFor(`!!(${button('拒绝 SSH2 主机')})`);
      assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`),server.pin);
      await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
      await ui.click('信任本次 SSH2 主机');
    }
    await ui.waitFor(`!!(${button('使用保存的 SSH2 凭据')})`);
    await ui.click('使用保存的 SSH2 凭据');
    await ui.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith('CONNECTED')`);
    const id=await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`);
    return (await ui.invoke('service_list')).find(item=>item.connection_id===id);
  }
  const first=await connect(true), second=await connect();
  const ref=connection=>({connection_id:connection.connection_id,generation:connection.generation});
  const raw=async connection=>(await ui.invoke('service_read',{connection:ref(connection),cursor:1})).events.flatMap(event=>event.bytes);
  const waitRaw=async(connection,expected)=>{
    for(let attempt=0;attempt<200;attempt++){const bytes=await raw(connection);if(bytes.length>=expected.length){assert.deepEqual(bytes,expected);return;}await delay(25);}throw new Error('compose exact echo timed out');
  };
  const beforeFirst=await raw(first), beforeSecond=await raw(second);
  await ui.click('基础撰写');
  const text='第二中文\n$HOME; `literal`';
  await ui.fill('撰写正文',text);await ui.fill('撰写末尾换行','crlf');await previewSend();
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="撰写发送预览"]').textContent`)).includes('\\r\\n'));
  await ui.fill('会话',first.connection_id);
  await ui.waitFor(`document.querySelector('[aria-label="撰写目标"]').textContent.includes(${JSON.stringify(first.connection_id)})`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="撰写正文"]').value`),'');
  assert.equal(await ui.evaluate(`!!(${button('确认发送撰写')})`),false);
  await ui.fill('撰写正文','第一草稿');
  await ui.fill('会话',second.connection_id);
  await ui.waitFor(`document.querySelector('[aria-label="撰写正文"]').value===${JSON.stringify(text)}`);
  assert.equal(await ui.evaluate(`!!(${button('确认发送撰写')})`),false,'switch away/back cannot restore consent');
  await waitRaw(first,beforeFirst);await waitRaw(second,beforeSecond);
  await ui.fill('撰写末尾换行','crlf');await previewSend();
  await ui.evaluate(`const confirm=${button('确认发送撰写')};confirm.click();confirm.click();`);
  const secondExpected=[...beforeSecond,...Buffer.from(text+'\r\n')];
  await waitRaw(second,secondExpected);await waitRaw(first,beforeFirst);
  await ui.waitFor(`document.querySelector('[aria-label="撰写正文"]').value===''`);
  await ui.fill('会话',first.connection_id);
  await ui.waitFor(`document.querySelector('[aria-label="撰写正文"]').value==='第一草稿'`);
  await ui.waitFor(`!!(${button('预览撰写发送')})&&!(${button('预览撰写发送')}).disabled`);
  await previewSend();
  await ui.waitFor(`!!(${button('确认发送撰写')})`);
  await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await ui.command('Input.insertText',{text:'typed'});
  await ui.waitFor(`!(${button('确认发送撰写')})`);
  const firstTyped=[...beforeFirst,...Buffer.from('typed')];await waitRaw(first,firstTyped);
  // A real write is accepted by the service but its response is lost. No automatic retry.
  await ui.waitFor(`!!(${button('预览撰写发送')})&&!(${button('预览撰写发送')}).disabled`);
  await previewSend();
  const lost=await ui.interceptIpc({command:'ssh_request',op:'write_text',mode:'error'});
  await ui.click('确认发送撰写');
  await ui.waitFor(`document.querySelector('.status').textContent.includes('已停止本页面后续输入')`);
  assert.equal(await lost.count(),1);await lost.restore();
  await waitRaw(first,[...firstTyped,...Buffer.from('第一草稿')]);await waitRaw(second,secondExpected);
  await delay(200);await waitRaw(first,[...firstTyped,...Buffer.from('第一草稿')]);
  await ui.fill('会话',second.connection_id);
  await ui.fill('撰写正文','重载不保存');await ui.click('关闭撰写');await ui.click('基础撰写');
  await ui.waitFor(`document.querySelector('[aria-label="撰写正文"]').value==='重载不保存'`);
  await ui.screenshot('desktop-compose-native.png');
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value===${JSON.stringify(second.connection_id)})`);
  await ui.fill('会话',second.connection_id);await ui.click('基础撰写');
  await ui.waitFor(`document.querySelector('[aria-label="撰写目标"]').textContent.includes(${JSON.stringify(second.connection_id)})`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="撰写正文"]').value`),'');
  assert.equal((await ui.invoke('service_list')).length,2);
  await waitRaw(first,[...firstTyped,...Buffer.from('第一草稿')]);await waitRaw(second,secondExpected);
  console.log('PASS compose native SSH: independent same-Profile drafts, exact Unicode/LF/CRLF/literal shell text, switch-away/back discards approval, single-use double click, keyboard takeover, lost real write response hit=1/no retry, panel reopen preserves draft, reload clears content and consent without recreating connections; synthetic only');
} catch(error) {
  if(ui){console.error('compose failure:',await ui.evaluate(`JSON.stringify({main:document.querySelector('.status')?.textContent,selected:document.querySelector('[aria-label="会话"]')?.value,target:document.querySelector('[aria-label="撰写目标"]')?.textContent})`));console.error('compose connections:',await ui.invoke('service_list').catch(()=> 'unavailable'));await ui.screenshot('desktop-compose-failure.png');}
  throw error;
} finally {
  await ui?.close();fixture.stdin.end();if(fixture.exitCode===null)fixture.kill();
  for(let attempt=0;attempt<100&&fixture.exitCode===null&&fixture.signalCode===null;attempt++)await delay(50);
  assert.ok(fixture.exitCode!==null||fixture.signalCode!==null);
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('shared-terminal-compose-ui-中文-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
