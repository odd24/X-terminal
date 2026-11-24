import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {delay,desktopEvidence,launchDesktop} from './lib/DesktopHarness.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const root=await mkdtemp(path.join(await realpath(tmpdir()),'shared-terminal-serial-config-'));
const result={...await desktopEvidence(executable),checks:[],result:'IN_PROGRESS'};
const dialog='document.querySelector("dialog:modal")';
const port='document.querySelector("#config-serial-port")';
const serialMenu='document.querySelector(".tree-new-menu")';
const buttons='Array.from(document.querySelectorAll("dialog:modal button"))';
let ui;
const wait=async check=>{
  for(let attempt=0;attempt<120;attempt++){
    const value=await check();
    if(value)return value;
    await delay(50);
  }
  assert.fail('Timed out on the owned serial config fixture');
};
const page=()=>ui.invoke('config_request',{request:{op:'page',revision:null,offset:0,folders:false}});
const rpc=request=>ui.invoke('serial_request',{request});
const portValue=()=>ui.evaluate(port+'?.value');
const ready=()=>ui.waitFor(port+'&&!'+port+'.matches(":disabled")');
const status=text=>ui.waitFor(dialog+'?.innerText.includes('+JSON.stringify(text)+')');
const saveBlocked=()=>ui.evaluate(buttons+'.filter(button=>["保存","保存并连接"].includes(button.textContent)).every(button=>button.matches(":disabled"))');
const record=name=>result.checks.push(name);

async function open(){
  await ui.evaluate(serialMenu+'.open=true');
  await ui.click('新建串口配置');
  await ui.waitFor(dialog+'?.getAttribute("aria-label")==="新建串口配置"');
}
async function close(){
  await ui.click('关闭配置');
  await ui.waitFor('!'+dialog);
}

async function inventoryMode(mode){
  await ui.evaluate('window.serialInventoryMode='+JSON.stringify(mode));
}
async function refresh(){
  await ui.click('刷新端口');
  await ready();
}

try{
  ui=await launchDesktop(root,{executable,fixture:true,windowsHide:false});
  assert.equal((await ui.invoke('service_status')).fixture,true);
  const first=await rpc({op:'inventory'});
  const second=await rpc({op:'inventory'});
  assert.equal(first.result,'inventory');
  assert.equal(second.result,'inventory');
  assert.notEqual(first.revision,second.revision);
  assert.equal(first.devices[0].device_id,second.devices[0].device_id);
  assert.match(second.devices[0].friendly_name,/内存串口/);
  const primary=second.devices[0];
  const replacement={...primary,device_id:randomUUID(),instance_id:'SYNTHETIC-REPLACEMENT'};
  const other={device_id:randomUUID(),port:'COM8',instance_id:'SYNTHETIC-SECOND'};
  // Only the inventory response is replaced for the multi-device, unplug and
  // failure scenarios. Configuration writes and the final connection use IPC.
  await ui.evaluate('('+String(({replacement,other})=>{
    const original=window.fetch;
    window.serialInventoryMode='native';
    window.serialInventoryEdits=0;
    window.fetch=async function(request,init){
      const reply=await original.call(this,request,init);
      const body=typeof init?.body==='string'?JSON.parse(init.body):null;
      if(body?.request?.op!=='inventory'||!new URL(String(request)).pathname.endsWith('/serial_request'))return reply;
      const mode=window.serialInventoryMode;
      if(mode==='native')return reply;
      window.serialInventoryEdits++;
      const headers=new Headers(reply.headers);
      headers.delete('content-length');
      if(mode==='error'){
        headers.set('Tauri-Response','error');
        return new Response(JSON.stringify('InvalidState'),{status:reply.status,headers});
      }
      const inventory=await reply.json();
      if(mode==='multiple')inventory.devices.push(other);
      if(mode==='replacement')inventory.devices=[replacement];
      if(mode==='empty')inventory.devices=[];
      return new Response(JSON.stringify(inventory),{status:reply.status,headers});
    };
  })+')('+JSON.stringify({replacement,other})+')');

  await open();await ready();
  assert.equal(await portValue(),primary.device_id);
  assert.match(await ui.evaluate(port+'.selectedOptions[0].textContent'),/内存串口夹具/);
  await ui.fill('配置名称','串口夹具草稿');
  await ui.fill('波特率',57600);
  await refresh();
  assert.equal(await portValue(),primary.device_id);
  assert.equal(await ui.evaluate('document.querySelector("[aria-label=波特率]").value'),'57600');
  await inventoryMode('replacement');await refresh();
  assert.equal(await portValue(),'');
  assert.equal(await saveBlocked(),true);
  await status('原设备已拔出');
  assert.equal(await ui.evaluate('document.querySelector("[aria-label=配置名称]").value'),'串口夹具草稿');
  await inventoryMode('empty');await refresh();await status('未检测到可识别串口');
  assert.equal(await saveBlocked(),true);
  await inventoryMode('error');await refresh();await status('读取串口列表失败');
  assert.equal(await saveBlocked(),true);
  assert.equal((await page()).profiles.length,0);
  record('Single native fixture is preselected, refresh preserves identity and draft, replacement/empty/error block new saves');
  await close();

  await inventoryMode('multiple');await open();await ready();
  assert.equal(await portValue(),'');
  assert.equal(await saveBlocked(),true);
  assert.deepEqual(await ui.evaluate('Array.from('+port+'.options).map(option=>option.textContent.trim())'),
    ['请选择端口','COM7 · 内存串口夹具','COM8']);
  assert.equal(await ui.evaluate(dialog+'.scrollWidth<='+dialog+'.clientWidth'),true);
  await ui.fill('串口端口',primary.device_id);
  assert.equal(await saveBlocked(),false);
  await close();
  record('Multiple candidates require a selection and fall back to bare COM when a name is absent');

  await inventoryMode('native');
  const hold=await ui.interceptIpc({command:'serial_request',op:'inventory',mode:'hold'});
  try{
    await open();await wait(async()=>await hold.count()===1);
    assert.equal(await saveBlocked(),true);
    await close();
    await hold.release();
  }finally{await hold.restore();}
  await open();await ready();assert.equal(await portValue(),primary.device_id);await close();
  record('An in-flight inventory response is discarded after the owning dialog closes');

  const offline={id:randomUUID(),name:'串口离线夹具',folder_id:null,settings:{
    protocol:'serial',port:'COM88',baud_rate:9600,data_bits:8,stop_bits:1,parity:'none',
    flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8',
  }};
  const saved=await ui.invoke('config_request',{request:{op:'save_profile',profile:offline,credential:{action:'keep'}}});
  assert.equal(saved.result,'saved_profile');
  await ui.evaluate('document.querySelector(".tools-menu").open=true');
  await ui.click('连接配置');
  await ui.waitFor('!!'+dialog+'?.querySelector(".profile-list button")');
  await ui.evaluate('Array.from('+dialog+'.querySelectorAll(".profile-list button")).find(button=>button.textContent.startsWith("串口离线夹具")).click()');
  await ready();await status('COM88（当前未检测到）');
  await ui.fill('配置名称','串口离线已编辑');
  await ui.fill('波特率',38400);
  await ui.click('保存配置');
  await status('配置已保存');
  const stored=(await page()).profiles.find(profile=>profile.id===offline.id);
  assert.equal(stored.settings.port,'COM88');
  assert.equal(stored.settings.baud_rate,38400);
  assert.equal(stored.name,'串口离线已编辑');
  assert.deepEqual(await ui.invoke('service_list'),[]);
  await close();
  record('An offline saved COM port survives changes to name and baud without opening a device');

  await open();await ready();
  await ui.fill('配置名称','串口选择被替换');
  const save=await ui.interceptIpc({command:'config_request',op:'save_profile',mode:'hold'});
  try{
    await ui.click('保存并连接');await wait(async()=>await save.count()===1);
    await inventoryMode('replacement');await save.release();
    await ui.waitFor('!!document.querySelector("#uart-device")');
    await status('原选择的串口设备已变化');
    assert.equal(await ui.evaluate('document.querySelector("#uart-device").value'),'');
    assert.deepEqual(await ui.invoke('service_list'),[]);
  }finally{await save.restore();await ui.click('取消连接窗口');}
  record('Save-and-connect refuses to preselect a replacement on the same COM port');

  await inventoryMode('native');
  await open();await ready();
  await ui.fill('配置名称','串口真实夹具连接');
  await ui.click('保存并连接');
  await ui.waitFor('document.querySelector("#uart-device")?.value==='+JSON.stringify(primary.device_id));
  assert.deepEqual(await ui.invoke('service_list'),[]);
  await ui.click('刷新端口');
  await ui.waitFor('document.querySelector("#uart-device")?.value==='+JSON.stringify(primary.device_id)+
    '&&!document.querySelector("#uart-device").disabled');
  await ui.click('连接串口');
  await ui.waitFor('!'+dialog);
  const connected=await wait(async()=>(await ui.invoke('service_list')).find(item=>item.protocol==='SERIAL'&&item.state==='CONNECTED'));
  const connection={connection_id:connected.connection_id,generation:connected.generation};
  const actual=await rpc({op:'status',connection});
  assert.equal(actual.port,'COM7');
  assert.equal((await page()).profiles.find(profile=>profile.id===actual.profile_id).name,'串口真实夹具连接');
  await rpc({op:'close',connection});
  await wait(async()=>(await rpc({op:'status',connection})).connection.state==='DISCONNECTED');
  assert.ok(await ui.evaluate('window.serialInventoryEdits')>=4);
  record('Exact retained device revalidates in QuickSerial and explicitly opens the memory UART');

  await ui.click('串口连接');
  await ui.waitFor('document.querySelector("#uart-device")?.options.length===2&&!document.querySelector("#uart-device").disabled');
  assert.equal(await ui.evaluate('document.querySelector("#uart-device").value'),'');
  await ui.click('连接串口');
  await ui.waitFor('!!document.querySelector("#uart-device-error")');
  await ui.fill('UART端口',primary.device_id);
  await ui.click('连接串口');
  await ui.waitFor('!'+dialog);
  const quick=await wait(async()=>(await ui.invoke('service_list')).find(item=>item.protocol==='SERIAL'&&item.state==='CONNECTED'));
  const quickConnection={connection_id:quick.connection_id,generation:quick.generation};
  await rpc({op:'close',connection:quickConnection});
  await wait(async()=>(await rpc({op:'status',connection:quickConnection})).connection.state==='DISCONNECTED');
  record('Unseeded QuickSerial still requires an explicit device and can open a temporary memory UART');
  result.result='PASS';
}catch(error){
  result.result='FAIL';
  result.error=error.stack;
  throw error;
}finally{
  await ui?.close();
  await mkdir(path.dirname(report),{recursive:true});
  await writeFile(report,JSON.stringify(result,null,2)+'\n');
  assert.ok(path.basename(root).startsWith('shared-terminal-serial-config-'));
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
