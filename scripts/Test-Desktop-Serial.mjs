import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const build = fixture => {
  const result = spawnSync('cargo',['build','-p','session-service','--locked',...(fixture?['--features','serial-ui-fixture']:[])],{windowsHide:true,stdio:'inherit'});
  if(result.error)throw result.error;assert.equal(result.status,0,'serial service build must succeed');
};
let ui;let directory;
try {
  build(true);
  directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-serial-ui-中文-'));
  ui=await launchDesktop(directory,{fixture:true});
  const save=async(name,encoding='utf8',flow='none')=>{
    const profile={id:crypto.randomUUID(),folder_id:null,name,settings:{protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow,dtr_on_open:false,rts_on_open:flow==='hardware'?null:false,encoding}};
    assert.equal((await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'keep'}}})).result,'saved_profile');return profile;
  };
  const utf8=await save('synthetic UTF8');const hardware=await save('synthetic GBK hardware','gbk','hardware');
  const state=value=>ui.waitFor(`document.querySelector('[aria-label="串口状态"]')?.textContent.startsWith(${JSON.stringify(value)})`);
  const message=value=>ui.waitFor(`document.querySelector('.serial-panel [role="status"]')?.textContent.includes(${JSON.stringify(value)})`);
  const buttonDisabled=label=>ui.evaluate(`Array.from(document.querySelectorAll('button')).find(item=>item.textContent===${JSON.stringify(label)}).disabled`);
  const recent=async()=> (await ui.evaluate(`document.querySelector('[aria-label="串口最近请求"]').textContent`)).match(/[0-9a-f-]{36}/)[0];
  const ref=connection=>({connection_id:connection.connection_id,generation:connection.generation});
  const raw=async connection=>{
    const page=await ui.invoke('service_read',{connection:ref(connection),cursor:1});
    assert.equal(page.truncated,false);assert.equal(page.events.some(event=>event.gap_bytes),false);
    return page.events.flatMap(event=>event.bytes);
  };
  const waitRaw=async(connection,expected)=>{
    for(let attempt=0;attempt<200;attempt++){const bytes=await raw(connection);if(bytes.length>=expected.length){assert.deepEqual(bytes,expected);return;}await delay(25);}throw new Error('serial raw echo did not arrive');
  };
  await ui.click('串口高级工具');await ui.click('刷新串口配置与设备');
  await ui.waitFor(`document.querySelector('[aria-label="串口配置"]').options.length===3 && document.querySelector('[aria-label="串口设备"]').options.length===2`);
  assert.equal(await ui.evaluate(`document.querySelector('.serial-panel').textContent.includes('COM99')`),true);
  await ui.fill('串口配置',utf8.id);
  const device=await ui.evaluate(`document.querySelector('[aria-label="串口设备"]').options[1].value`);
  await ui.fill('串口设备',device);assert.equal(await buttonDisabled('打开串口'),true);
  await ui.evaluate(`document.querySelector('[aria-label="确认串口设备与控制线"]').click()`);await ui.click('打开串口');await state('CONNECTED');
  let connection=(await ui.invoke('service_list')).find(item=>item.protocol==='SERIAL');assert.equal(connection.generation,1);
  await ui.waitFor(`document.querySelector('footer [aria-label="活动编码"]')?.textContent==='编码：UTF-8' && document.querySelector('footer [aria-label="权限状态"]')?.textContent.includes('桌面输入可用')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="终端视口尺寸"]').title.includes('串口没有远端PTY')`),true);
  await ui.fill('串口发送格式','hex');await ui.fill('串口发送换行','cr_lf');await ui.fill('串口发送内容','00 ff');await ui.click('发送串口内容');await message('DRIVER_ACCEPTED');
  let expected=[0,255,13,10];await waitRaw(connection,expected);
  await ui.waitFor(`document.querySelector('[aria-label="串口HEX接收"]')?.textContent.includes('00 FF 0D 0A')`);
  const original=await recent();
  const duplicate=await ui.invoke('serial_request',{request:{op:'send',connection:ref(connection),request_id:original,content:'00 ff',format:'hex',ending:'cr_lf',pace:{chunk_bytes:1024,interval_ms:0}}});
  assert.equal(duplicate.state,'DRIVER_ACCEPTED');await waitRaw(connection,expected);
  await ui.fill('串口发送内容','GG');await ui.click('发送串口内容');await message('无效');await waitRaw(connection,expected);
  await ui.evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);await ui.command('Input.insertText',{text:'keyboard'});
  expected.push(...Buffer.from('keyboard'));await waitRaw(connection,expected);
  await ui.click('基础撰写');await ui.fill('撰写正文','串口撰写\nnext');await ui.fill('撰写末尾换行','crlf');await ui.click('预览撰写发送');await ui.click('确认发送撰写');
  expected.push(...Buffer.from('串口撰写\nnext\r\n'));await waitRaw(connection,expected);await ui.click('关闭撰写');

  await ui.fill('串口发送格式','text');await ui.fill('串口发送换行','lf');await ui.fill('串口每段字节',1);await ui.fill('串口段间隔',25);await ui.fill('串口发送内容','abc');await ui.click('发送串口内容');await message('DRIVER_ACCEPTED');
  expected.push(...Buffer.from('abc\n'));await waitRaw(connection,expected);
  const pid=(await ui.invoke('service_status')).pid;
  await ui.evaluate(`window.__serialReloadProbe=true`);await ui.command('Page.reload');
  await ui.waitFor(`window.__serialReloadProbe===undefined && document.querySelector('footer')?.textContent.includes('服务 ')`);
  assert.equal((await ui.invoke('service_status')).pid,pid);
  await ui.click('串口高级工具');await state('CONNECTED');await waitRaw(connection,expected);
  await ui.fill('串口每段字节',1);await ui.fill('串口段间隔',1000);await ui.fill('串口发送内容','x'.repeat(61));await ui.click('发送串口内容');
  await ui.waitFor(`document.querySelector('[aria-label="串口发送内容"]').value===''`);
  const pacedId=await recent();
  for(let attempt=0;attempt<200 && (await raw(connection)).length===expected.length;attempt++)await delay(10);
  await ui.click('停止发送并关闭串口');await state('DISCONNECTED');await message('UNKNOWN');
  const cancelled=await ui.invoke('serial_request',{request:{op:'input_status',connection:ref(connection),request_id:pacedId}});
  assert.equal(cancelled.state,'UNKNOWN');assert.ok(cancelled.driver_accepted>0 && cancelled.driver_accepted<61);
  expected.push(...Array(cancelled.driver_accepted).fill(120));await waitRaw(connection,expected);
  await ui.click('刷新串口配置与设备');await ui.waitFor(`document.querySelector('[aria-label="串口配置"]').options.length===3`);
  await ui.fill('串口配置',hardware.id);
  const freshDevice=await ui.evaluate(`document.querySelector('[aria-label="串口设备"]').options[1].value`);
  await ui.fill('串口设备',freshDevice);await ui.evaluate(`document.querySelector('[aria-label="确认串口设备与控制线"]').click()`);await ui.click('打开串口');
  await state('CONNECTED');connection=(await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
  await ui.waitFor(`document.querySelector('footer [aria-label="活动编码"]')?.textContent==='编码：GBK'`);
  const serialLog=await ui.invoke('logging_request',{request:{op:'start',connection:ref(connection),request_id:crypto.randomUUID(),limits:{segment_bytes:131072,segments:2}}});
  assert.equal(serialLog.encoding,'gbk');
  assert.equal(await buttonDisabled('RTS 开启'),true);assert.equal(await buttonDisabled('RTS 关闭'),true);
  const forbidden={op:'control',connection:ref(connection),request_id:crypto.randomUUID(),line:'RTS',asserted:true};
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('serial_request',{request:${JSON.stringify(forbidden)}}).then(()=>'unexpected',error=>String(error))`),'InvalidArgument');
  await ui.click('DTR 开启');await message('DTR 开启：CONTROL_APPLIED');await ui.click('BREAK 开启');await message('BREAK 开启：CONTROL_APPLIED');await ui.click('BREAK 关闭');await message('BREAK 关闭：CONTROL_APPLIED');
  await ui.fill('串口发送内容','中');await ui.fill('串口发送换行','cr_lf');await ui.fill('串口每段字节',1024);await ui.fill('串口段间隔',0);await ui.click('发送串口内容');await message('DRIVER_ACCEPTED');await waitRaw(connection,[0xd6,0xd0,13,10]);
  // Raw echo can precede the renderer's polling/write callback. capture() is
  // an explicit point-in-time snapshot, so waiting on its old text cannot
  // observe a later render. Re-sample the real button without resending input.
  await ui.click('屏幕快照');
  const firstGbkSnapshot=await ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]')?.textContent ?? ''`);
  const firstGbkService=await ui.invoke('service_screen',{connection:ref(connection)});
  assert.equal(firstGbkService.encoding,'gbk');assert.ok(firstGbkService.contents.includes('中'));
  console.log('GBK snapshot checkpoint:',JSON.stringify({firstSnapshot:firstGbkSnapshot,serviceContents:firstGbkService.contents}));
  await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('中'))`);
  // Each byte arrives in a separate poll, exercising the actual WebView decoder.
  await ui.fill('串口发送格式','hex');await ui.fill('串口发送内容','CE C4');await ui.fill('串口发送换行','none');await ui.fill('串口每段字节',1);await ui.fill('串口段间隔',250);await ui.click('发送串口内容');await message('DRIVER_ACCEPTED');
  await waitRaw(connection,[0xd6,0xd0,13,10,0xce,0xc4]);
  await delay(300);await ui.click('屏幕快照');await ui.waitFor(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('文')`);
  const gbkScreen=await ui.invoke('service_screen',{connection:ref(connection)});
  assert.equal(gbkScreen.encoding,'gbk');assert.ok(gbkScreen.contents.includes('中'));assert.ok(gbkScreen.contents.includes('文'));assert.equal(gbkScreen.decode_error_events,0);
  const gbkText=await ui.invoke('service_read_text',{connection:ref(connection),cursor:1});
  assert.equal(gbkText.events.map(event=>event.text).join(''),'中\r\n文');
  await ui.fill('串口发送格式','text');
  await ui.fill('串口发送内容','😀');await ui.click('发送串口内容');await message('无效');await waitRaw(connection,[0xd6,0xd0,13,10,0xce,0xc4]);
  await ui.fill('串口发送格式','hex');await ui.fill('串口发送内容','D6');await ui.click('发送串口内容');await message('DRIVER_ACCEPTED');
  await ui.screenshot('desktop-serial-synthetic.png');
  await ui.click('停止发送并关闭串口');await state('DISCONNECTED');
  await ui.waitFor(`document.querySelector('[aria-label="接收解码提示"]')?.textContent.includes('U+FFFD')`);
  const finalScreen=await ui.invoke('service_screen',{connection:ref(connection)});
  assert.equal(finalScreen.completed,true);assert.equal(finalScreen.decode_error_events,1);assert.ok(finalScreen.contents.includes('�'));
  let serialLogEnd;
  for(let attempt=0;attempt<200;attempt++){serialLogEnd=await ui.invoke('logging_request',{request:{op:'status',connection:ref(connection),log_id:serialLog.log_id}});if(serialLogEnd.worker_finished)break;await delay(20);}
  assert.equal(serialLogEnd.durable,true);assert.equal(serialLogEnd.natural_end,true);assert.equal(serialLogEnd.source_gap_bytes,0);
  const logText=(await readFile(path.join(directory,'terminal-logs',serialLog.log_id,'0000000000000001.text.jsonl'),'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(logText.slice(1).map(line=>line.event.text).join(''),'中\r\n文�');assert.equal(logText.at(-1).event.decode_error,true);
  const gb18030=await save('synthetic GB18030','gb18030');
  await ui.click('刷新串口配置与设备');await ui.waitFor(`document.querySelector('[aria-label="串口配置"]').options.length===4`);
  await ui.fill('串口配置',gb18030.id);
  await ui.fill('串口设备',await ui.evaluate(`document.querySelector('[aria-label="串口设备"]').options[1].value`));
  await ui.evaluate(`document.querySelector('[aria-label="确认串口设备与控制线"]').click()`);await ui.click('打开串口');await state('CONNECTED');
  connection=(await ui.invoke('service_list')).find(item=>item.state==='CONNECTED');
  await ui.fill('串口发送格式','hex');await ui.fill('串口发送换行','none');await ui.fill('串口每段字节',1);await ui.fill('串口段间隔',200);await ui.fill('串口发送内容','90 30 81 30');await ui.click('发送串口内容');await message('DRIVER_ACCEPTED');
  await waitRaw(connection,[0x90,0x30,0x81,0x30]);await delay(300);await ui.click('屏幕快照');await ui.waitFor(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('\u{10000}')`);
  // Editing the Profile does not change the active connection's encoding snapshot.
  gb18030.settings.encoding='utf8';
  await ui.invoke('config_request',{request:{op:'save_profile',profile:gb18030,credential:{action:'keep'}}});
  await ui.command('Page.reload');await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value===${JSON.stringify(connection.connection_id)})`);
  await ui.fill('会话',connection.connection_id);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="会话"]').value`),connection.connection_id);
  // Selection/replay spans several asynchronous polls after reload. Read the
  // current viewport on each attempt instead of waiting on one stale capture.
  await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('\u{10000}'))`);
  const gb18030Screen=await ui.invoke('service_screen',{connection:ref(connection)});
  assert.equal(gb18030Screen.encoding,'gb18030');assert.ok(gb18030Screen.contents.includes('\u{10000}'));
  await ui.waitFor(`document.querySelector('footer [aria-label="活动编码"]')?.textContent==='编码：GB18030'`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="接收解码提示"]')`),false);
  await ui.click('串口高级工具');await state('CONNECTED');await ui.click('停止发送并关闭串口');await state('DISCONNECTED');
  for(const item of await ui.invoke('service_list')) {
    await ui.fill('会话',item.connection_id);await ui.waitFor(`document.querySelector('[aria-label="串口状态"]')?.textContent.includes(${JSON.stringify(item.connection_id)})`);
    await ui.click('移除串口记录');await ui.waitFor(`!Array.from(document.querySelector('[aria-label="会话"]').options).some(option=>option.value===${JSON.stringify(item.connection_id)})`);
  }
  await ui.waitFor(`document.querySelector('.status').textContent.includes('尚无活动连接')`);
  console.log('PASS serial native WebView over synthetic worker: explicit device/control approval, HEX/CRLF, exact raw echo, dedup/no replay, native keyboard, paced text, cancel/close, reload, GBK strict encoding, hardware RTS, DTR/Break, terminal cleanup; no COM opened');
} finally {
  try {
    await ui?.close();
    if(directory){const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-serial-ui-中文-'));await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  } finally { build(false); }
}
