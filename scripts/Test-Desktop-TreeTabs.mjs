import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createSshFixtureScope, delay, desktopEvidence, launchDesktop} from './lib/DesktopHarness.mjs';
import {desktopKeyboard} from './lib/DesktopKeyboard.mjs';

const executable=path.resolve(process.argv[2]);
const report=path.resolve(process.argv[3]);
const memory=process.argv.includes('--memory-uart');
const evidence={...await desktopEvidence(executable),memory,checks:[],result:'FAIL'};
const scope=await createSshFixtureScope('shared-terminal-tree-tabs-');
let ui;
const ref=({connection_id,generation})=>({connection_id,generation});
const element=selector=>'document.querySelector('+JSON.stringify(selector)+')';
const dialog=element('dialog[open][aria-label="连接服务器"]');
const serialDialog=element('dialog[open][aria-label="连接串口设备"]');
const tab=id=>element(`[role="tab"][data-connection-id="${id}"]`);
const leaf=profile=>element(`[data-profile-id="${profile.id}"]`);
const list=()=>ui.invoke('service_list');
const ssh=request=>ui.invoke('ssh_request',{request});
const serial=request=>ui.invoke('serial_request',{request});
const order=key=>ui.evaluate(`[...document.querySelectorAll('[data-pane="${key}"] [role=tab]')].map(tab=>tab.dataset.connectionId)`);
const trace=name=>{evidence.checks.push(name);console.log(name);};
async function wait(read,label){
  for(let i=0;i<240;i++){const value=await read();if(value)return value;await delay(50);}
  throw new Error('Timed out: '+label);
}
async function otherConnection(previous){
  return wait(async()=>(await list()).find(c=>!previous.includes(c.connection_id)),'new exact connection');
}
async function activate(profile,entry='double'){
  await ui.waitFor('!!'+leaf(profile));
  if(entry==='double')await pointer(leaf(profile),'left',2);
  else if(entry==='context'){
    await pointer(leaf(profile),'right');
    await ui.waitFor('!!'+element('[role="menu"][aria-label="会话配置菜单"]'));
    await ui.click('连接');
  }else{
    await pointer(leaf(profile));
    await ui.click('连接选中配置');
  }
}
async function pointer(query,button='left',count=1){
  const point=await ui.evaluate(`(()=>{const target=${query};target.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=target.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    if(!target.contains(document.elementFromPoint(x,y)))throw Error('Covered pointer target: '+target.outerHTML);
    return {x,y};})()`);
  for(let clickCount=1;clickCount<=count;clickCount++){
    await ui.command('Input.dispatchMouseEvent',{type:'mousePressed',button,buttons:button==='left'?1:2,clickCount,...point});
    await ui.command('Input.dispatchMouseEvent',{type:'mouseReleased',button,buttons:0,clickCount,...point});
  }
}
async function focused(connection,key){
  await ui.waitFor(`!!${tab(connection.connection_id)}?.matches('[aria-selected=true]')
    && document.activeElement?.matches('textarea.xterm-helper-textarea')
    && document.activeElement.closest('[data-pane]')?.matches('[data-pane="${key}"][data-active=true][data-rendered-id="${connection.connection_id}"][data-rendered-generation="${connection.generation}"]')`);
}
async function assertBytes(connection,others,token){
  const contains=async c=>Buffer.from((await ui.invoke('service_read',{connection:ref(c),cursor:1})).events.flatMap(event=>event.bytes)).includes(token);
  const keyboard=desktopKeyboard(ui,[]);
  await keyboard.type(token);
  await wait(()=>contains(connection),'keyboard bytes on '+connection.connection_id);
  for(const other of others)assert.equal(await contains(other),false,'unselected connection received bytes');
}
async function opened(profile,entry,key,options={}){
  const before=await list();
  const previous=await order(key);
  await activate(profile,entry);
  const opened=await otherConnection(before.map(c=>c.connection_id));
  if(options.trust){
    await ui.waitFor('document.activeElement?.textContent==="暂不连接"');
    await ui.click('指纹一致，信任并继续');
  }
  await ui.waitFor('!'+dialog);
  await focused(opened,key);
  assert.deepEqual(await order(key),[...previous,opened.connection_id]);
  return opened;
}

try{
  const server=await scope.start('ssh');
  ui=await launchDesktop(path.join(scope.root,'data'),{executable,fixture:memory,windowsHide:false});
  assert.equal((await ui.invoke('service_status')).fixture,memory);
  await ui.command('Page.bringToFront');
  const config=request=>ui.invoke('config_request',{request});
  await wait(async()=>{
    try{return (await config({op:'page',revision:null,offset:0,folders:false})).result==='page';}
    catch{return false;}
  },'isolated configuration channel ready');
  const save=async(profile,credential)=>{assert.equal((await config({op:'save_profile',profile,credential})).result,'saved_profile');return profile;};
  const profile=(name,stored=true)=>save({id:randomUUID(),folder_id:null,name,
    settings:{protocol:'ssh2',host:'127.0.0.1',port:server.port,username:'synthetic',auth:'password',encoding:'utf8'}},
    stored?{action:'replace',value:{password:server.password,private_key:null,passphrase:null}}:{action:'clear'});
  const saved=await profile('回环 SSH'),password=await profile('每次输入回环密码',false);
  if(memory){
    const inventory=await serial({op:'inventory'});
    const device=inventory.devices.find(item=>item.friendly_name?.includes('内存串口'));
    const {port}=device;
    const uart=await save({id:randomUUID(),folder_id:null,name:'内存 UART',settings:{protocol:'serial',port,
      baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8'}},{action:'clear'});
    await ui.click('刷新会话树');
    const first=await opened(saved,'double','first',{trust:true});
    await activate(uart,'summary');
    await ui.waitFor(`!!${serialDialog}?.querySelector('[aria-label="UART端口"]:enabled')`);
    await ui.fill('UART端口',device.device_id);
    await save({...uart,settings:{...uart.settings,baud_rate:38400}},{action:'clear'});
    await ui.click('连接串口');
    await ui.waitFor(`!!${serialDialog}?.querySelector('[role=alert]')`);
    assert.deepEqual((await list()).map(c=>c.connection_id),[first.connection_id]);
    await ui.click('取消连接窗口');
    await ui.waitFor('!'+serialDialog);
    await ui.click('刷新会话树');
    await ui.waitFor('!!'+element('[aria-label="刷新会话树"]:enabled'));
    await activate(uart,'summary');
    await ui.waitFor(`!!${serialDialog}?.querySelector('[aria-label="UART端口"]:enabled')`);
    await ui.fill('串口已保存连接',uart.id);
    await ui.waitFor(`${serialDialog}?.querySelector('[aria-label="UART波特率"]')?.value==='38400'`);
    await ui.fill('UART端口',device.device_id);
    const held=await ui.interceptIpc({command:'serial_request',op:'start_fixed',mode:'hold_error'});
    let next;
    try{
      await ui.click('连接串口');
      await wait(async()=>await held.count()===1,'saved serial fixed receipt held');
      next=await otherConnection([first.connection_id]);
      assert.equal(await ui.evaluate('!!'+tab(next.connection_id)),false);
      await held.release();
      await ui.waitFor(`${serialDialog}?.querySelector('[role=alert]')?.textContent.includes('请查询原连接结果')`);
    }finally{await held.restore();}
    await ui.click('查询串口连接结果');
    await ui.waitFor('!'+serialDialog);
    await focused(next,'first');
    assert.equal(next.protocol,'SERIAL');
    assert.deepEqual(await order('first'),[first.connection_id,next.connection_id]);
    assert.equal((await list()).length,2);
    await assertBytes(next,[first],'uart782');
    trace('拒绝过期串口配置，按原编号核对丢失回执，原窗格追加并将字节发送到内存 UART');
  }else{
    await ui.click('刷新会话树');
    const first=await opened(saved,'double','first',{trust:true});
    const second=await opened(saved,'context','first');
    const keyboard=desktopKeyboard(ui,[]);
    await keyboard.key('T','KeyT',84,{modifiers:10});
    const local=await wait(async()=>(await order('first')).find(id=>!([first,second].some(c=>c.connection_id===id))),'local PowerShell tab');
    await ui.selectTab(first.connection_id);
    const third=await opened(saved,'summary','first');
    assert.deepEqual(await order('first'),[first.connection_id,second.connection_id,local,third.connection_id]);
    await assertBytes(third,[first,second],'new782');
    trace('三种入口按顺序追加，混排保持，新 SSH 高亮、回显及键盘实际目标一致');

    await pointer(tab(first.connection_id),'right');
    await ui.click('复制会话');
    const copyDialog=element('dialog:modal[aria-label="连接服务器"]');
    await ui.waitFor('!!'+copyDialog);
    const copied=await otherConnection([first,second,third].map(c=>c.connection_id));
    await ui.waitFor('!'+copyDialog);
    await focused(copied,'first');
    assert.equal((await list()).length,4);
    assert.deepEqual(await order('first'),[first.connection_id,copied.connection_id,second.connection_id,local,third.connection_id]);
    trace('复制仍紧邻源标签');

    const toolsMenu=element('.tools-menu');
    await ui.evaluate(toolsMenu+'.open=true');
    await ui.click('标签左移');
    assert.deepEqual(await order('first'),[copied.connection_id,first.connection_id,second.connection_id,local,third.connection_id]);
    await ui.evaluate(toolsMenu+'.open=true');
    await ui.click('标签分组');
    await ui.waitFor('!!'+element('[aria-label="新分组名称"]'));
    await ui.fill('新分组名称','保留的 SSH 分组');
    await ui.click('新建分组');
    const groupSelect=element('select[aria-label="管理标签分组"]');
    await ui.waitFor(groupSelect+'?.value');
    const group=await ui.evaluate(groupSelect+'.value');
    await ui.fill(`标签归属 ${first.connection_id}`,group);
    await ui.click('关闭分组窗口');
    const grouped=await opened(saved,'summary','first');
    await assertBytes(grouped,[first,second,third,copied],'group853');
    trace('手动调整及分组后再次从树追加，原显示顺序和分组保留');

    await ui.splitTab(second.connection_id);
    await ui.waitFor(`!!${tab(second.connection_id)}?.closest('[data-pane="second"]')`);
    await ui.selectTab(second.connection_id);
    await focused(second,'second');
    const beforeIds=(await list()).map(c=>c.connection_id);
    const held=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'hold'});
    let waiting;
    try{
      await activate(password);
      await wait(async()=>await held.count()===1,'fixed start receipt held');
      waiting=await otherConnection(beforeIds);
      await delay(650);
      assert.equal(await ui.evaluate('!!'+tab(waiting.connection_id)),false,'snapshot must wait for exact receipt');
      await pointer(tab(third.connection_id));
      await focused(third,'first');
    }finally{await held.restore();}
    const passwordField=element('[aria-label="SSH登录密码"]');
    await ui.waitFor('!!'+passwordField+'&&!'+passwordField+'.disabled');
    assert.deepEqual(await order('second'),[second.connection_id,waiting.connection_id]);
    await focused(third,'first');
    await assertBytes(third,[first,second,waiting],'stay852');
    await ui.fill('SSH登录密码',server.password);
    await ui.click('登录');
    await ui.waitFor('!'+dialog);
    await focused(third,'first');
    assert.equal(await ui.evaluate(tab(waiting.connection_id)+'.getAttribute("aria-selected")'),'false');
    await assertBytes(third,[first,second,waiting],'stay853');
    trace('快照先到时未发布未确认标签，切换窗格后后台认证，无焦点回抢或串线');

    await ui.selectTab(second.connection_id);
    const beforeClose=(await list()).map(c=>c.connection_id);
    const closing=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'hold'});
    let late;
    try{
      await activate(password);
      await wait(async()=>await closing.count()===1,'closing original pane before receipt');
      late=await otherConnection(beforeClose);
      await pointer(element('[data-pane="second"] .pane-collapse'));
      await ui.waitFor('!'+dialog);
    }finally{await closing.restore();}
    await wait(async()=>['FAILED','DISCONNECTED'].includes((await ssh({op:'status',connection:ref(late)})).connection.state),'late exact generation closed');
    await ui.waitFor('!'+tab(late.connection_id));
    assert.ok((await list()).find(c=>c.connection_id===third.connection_id).state==='CONNECTED');
    trace('收起原窗格时清理迟到的准确连接，现有会话保留');

    await ui.selectTab(third.connection_id);
    const beforeUnknown=await list();
    const beforeOrder=await order('first');
    const lost=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'error'});
    let uncertain;
    try{
      await activate(password);
      await ui.waitFor(`${dialog}?.querySelector('[role=alert]')?.textContent.includes('连接结果不明')`);
      assert.equal(await lost.count(),1);
      uncertain=await otherConnection(beforeUnknown.map(c=>c.connection_id));
      await ui.selectTab(first.connection_id);
      await focused(first,'first');
    }finally{await lost.restore();}
    const attempts=(await server.control({op:'metrics'})).attempts;
    await ui.click('查询本次连接');
    await ui.waitFor('!!'+passwordField+'&&!'+passwordField+'.disabled');
    await focused(first,'first');
    assert.equal((await server.control({op:'metrics'})).attempts,attempts);
    assert.equal((await list()).length,beforeUnknown.length+1);
    await ui.fill('SSH登录密码',server.password);
    await ui.click('登录');
    await ui.waitFor('!'+dialog);
    await focused(first,'first');
    assert.deepEqual(await order('first'),[...beforeOrder,uncertain.connection_id]);
    await assertBytes(first,[second,third,uncertain],'same782');
    trace('同窗格主动切走后，只查询结果不明的原请求，保持输入焦点且没有重复建连');

    const beforeCancel=(await list()).map(c=>c.connection_id);
    const cancelled=await ui.interceptIpc({command:'ssh_request',op:'start_fixed',mode:'hold'});
    let cancelledConnection;
    try{
      await activate(password);
      await wait(async()=>await cancelled.count()===1,'cancelled fixed start receipt held');
      cancelledConnection=await otherConnection(beforeCancel);
      await keyboard.key('Escape','Escape',27);
      await ui.waitFor('!'+dialog);
    }finally{await cancelled.restore();}
    await wait(async()=>['FAILED','DISCONNECTED'].includes((await ssh({op:'status',connection:ref(cancelledConnection)})).connection.state),'cancel clears exact generation');
    await ui.waitFor('!'+tab(cancelledConnection.connection_id));
    trace('Escape 取消后只关闭迟到的原连接代次');
  }
  evidence.result='PASS';
}catch(error){
  evidence.error=String(error.stack??error);
  evidence.connections=await ui?.invoke('service_list').catch(()=>undefined);
  evidence.observed=await ui?.evaluate(`({focus:document.activeElement?.outerHTML.slice(0,250),
    dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>({label:d.getAttribute('aria-label'),status:d.querySelector('[role=status]')?.textContent,error:d.querySelector('[role=alert]')?.textContent})),
    panes:[...document.querySelectorAll('[data-pane]')].map(p=>({key:p.dataset.pane,active:p.dataset.active,rendered:p.dataset.renderedId,
    tabs:[...p.querySelectorAll('[role=tab]')].map(t=>[t.dataset.connectionId,t.getAttribute('aria-selected'),t.getAttribute('aria-label')])}))})`).catch(()=>undefined);
  throw error;
}finally{
  try{await ui?.close();}finally{
    await scope.close();
    await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
  }
}
