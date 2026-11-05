import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-clipboard-ui-中文-'));
let ui;
try {
  ui=await launchDesktop(directory,{fixture:true});
  await ui.click('新建合成会话');await ui.waitFor(`document.querySelector('.status').textContent==='服务输出已同步'`);
  const [scope]=await ui.invoke('service_list');const ref={connection_id:scope.connection_id,generation:scope.generation};
  const read=cursor=>ui.invoke('service_read',{connection:ref,cursor});
  let cursor=(await read(1)).next_cursor;
  const paste=text=>ui.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);
  const preview=()=>ui.waitFor(`!!document.querySelector('[aria-label="粘贴确认"]')`);
  const unchanged=async()=>{await delay(200);assert.equal((await read(cursor)).events.length,0,'unconfirmed/cancelled paste must not enter service');};
  await paste('第一行\r\n第二行\n第三行\r');await preview();await unchanged();
  assert.ok((await ui.evaluate(`document.querySelector('[aria-label="粘贴内容预览"]').textContent`)).includes('\\r\\n'));
  await ui.screenshot('desktop-terminal-paste-synthetic.png');
  await ui.click('确认发送粘贴');
  let page;for(let i=0;i<100;i++){page=await read(cursor);if(page.events.length)break;await delay(30);}
  assert.equal(Buffer.from(page.events.flatMap(e=>e.bytes)).toString(),'第一行\r\n第二行\n第三行\r');cursor=page.next_cursor;
  await paste('CANCEL\n');await preview();await ui.click('取消粘贴');await unchanged();
  await paste('TYPED\n');await preview();await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);await ui.command('Input.insertText',{text:'k'});
  await ui.waitFor(`!document.querySelector('[aria-label="粘贴确认"]')`);await delay(200);
  page=await read(cursor);assert.equal(Buffer.from(page.events.flatMap(e=>e.bytes)).toString(),'k');cursor=page.next_cursor;
  await paste('SWITCH\n');await preview();await ui.click('新建合成会话');
  await ui.waitFor(`document.querySelector('[aria-label="会话"]').value!==${JSON.stringify(ref.connection_id)}`);
  await ui.fill('会话',ref.connection_id);await ui.waitFor(`document.querySelector('.status').textContent==='服务输出已同步'`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="粘贴确认"]')`),false);await unchanged();
  await ui.invoke('fixture_append',{connection:ref,bytes:[...Buffer.from('\x1b[?2004h')]});await delay(300);cursor=(await read(cursor)).next_cursor;
  await paste('BRACKET\n');await preview();await ui.click('确认发送粘贴');await delay(200);
  page=await read(cursor);assert.equal(Buffer.from(page.events.flatMap(e=>e.bytes)).toString(),'\x1b[200~BRACKET\n\x1b[201~');cursor=page.next_cursor;
  await paste('MODE\n');await preview();await ui.invoke('fixture_append',{connection:ref,bytes:[...Buffer.from('\x1b[?2004l')]});await delay(300);cursor=(await read(cursor)).next_cursor;
  await ui.click('确认发送粘贴');await ui.waitFor(`document.querySelector('[aria-label="剪贴板状态"]').textContent.includes('模式已变化')`);await unchanged();
  await paste('RELOAD\n');await preview();await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="粘贴确认"]')`),false);await unchanged();
  console.log('PASS native WebView clipboard event routing: exact CR/LF, explicit bounded preview/one-shot confirmation, cancel, typed takeover, switch away/back, bracketed mode and mode-change refusal, reload drops proposal; synthetic service only');
} finally {
  await ui?.close();const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-clipboard-ui-中文-'));await rm(target,{recursive:true,force:true});
}
