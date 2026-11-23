import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop,delay} from './lib/DesktopHarness.mjs';
import {active,desktopKeyboard,terminalInput} from './lib/DesktopKeyboard.mjs';

const executable=path.resolve(process.argv[2]);
const root=await mkdtemp(path.join(tmpdir(),'shared-terminal-shortcut-uart-中文-'));
const result={result:'IN_PROGRESS',executable,scope:'passive in-memory UART only'};
let ui;
try{
  ui=await launchDesktop(root,{executable,fixture:true});
  assert.equal((await ui.invoke('service_status')).fixture,true);
  const serial=request=>ui.invoke('serial_request',{request});
  const inventory=await serial({op:'inventory'});
  assert.deepEqual(inventory.devices.map(device=>[device.port,device.instance_id]),[['COM7','SYNTHETIC-TEST-INSTANCE']]);
  assert.deepEqual(inventory.unidentified_ports,['COM99']);
  const {connection}=await serial({op:'quick_start',request_id:crypto.randomUUID(),revision:inventory.revision,device_id:inventory.devices[0].device_id,
    settings:{protocol:'serial',port:'COM7',baud_rate:57600,data_bits:8,stop_bits:1,parity:'none',flow:'none',encoding:'utf8',dtr_on_open:false,rts_on_open:false}});
  const ref={connection_id:connection.connection_id,generation:connection.generation};
  await ui.waitFor(`!!document.querySelector('[role="tab"][data-connection-id="${ref.connection_id}"]')`);
  await ui.selectTab(ref.connection_id);
  await ui.evaluate("document.querySelector('.pane-active > .terminal-pane-body > .terminal .xterm-helper-textarea').focus()");
  await ui.waitFor(active(terminalInput));
  await ui.waitFor("document.querySelector('.pane-active > .terminal-pane-body > .terminal')?.textContent.includes('UART synthetic Android启动 log 2')");
  const {key,enter}=desktopKeyboard(ui,[]);
  await key('F','KeyF',70,{modifiers:10});
  await ui.waitFor(active('[aria-label="终端查找文字"]'));
  await ui.fill('终端查找文字','UART synthetic Android启动 log 2');
  await enter();
  const searchStatus=`document.querySelector('[aria-label="终端查找状态"]')?.textContent`;
  await ui.waitFor(`${searchStatus}?.includes('当前保留缓冲区')`);
  assert.match(await ui.evaluate(searchStatus),/^1 \/ [1-9]/);
  await key('Escape','Escape',27);
  await ui.waitFor(active('.tools-menu > summary'));
  const page=await ui.invoke('service_read',{connection:ref,cursor:1});
  const original=Buffer.from(page.events.flatMap(event=>event.bytes)).toString();
  assert.match(original,/^UART synthetic Android启动 log 1\r\nUART synthetic Android启动 log 2\r\n/);
  assert.ok(page.events.every(event=>!event.gap_bytes));
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=\'退出桌面确认\']")');
  await ui.click('确认退出并停止服务');
  for(let n=0;n<240&&ui.app.exitCode===null;n++)await delay(50);
  assert.equal(ui.app.exitCode,0);
  result.result='PASS';
  console.log('PASS passive UART search, original output and prior Escape focus');
}catch(error){
  result.result='FAIL';result.error=String(error.stack);throw error;
}finally{
  await ui?.close();
  await writeFile('artifacts/desktop-shortcuts-uart-result.json',JSON.stringify(result,null,2));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
