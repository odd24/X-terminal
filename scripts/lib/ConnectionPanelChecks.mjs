import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {desktopKeyboard} from './DesktopKeyboard.mjs';
import {measureCompactToolbar} from './ToolbarMenuChecks.mjs';

const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
const button = (label, within = 'button') => `Array.from(document.querySelectorAll(${JSON.stringify(within)})).find(button =>
  (button.textContent.trim()===${JSON.stringify(label)}||button.getAttribute('aria-label')===${JSON.stringify(label)})&&button.getClientRects().length)`;
const summary = query('.ssh-summary');
const sshDialog = query('dialog[aria-label="SSH2 连接工具"][open]');
const ref = c => ({connection_id:c.connection_id,generation:c.generation});

export async function checkConnectionPanels({ui, version, root, source, connect, wait, fit, setTheme, splitRight, keyGoesTo, webviewClick}) {
  const {key,enter} = desktopKeyboard(ui);
  const click = expression => webviewClick(ui, expression);
  const ssh = request => ui.invoke('ssh_request', {request});
  const list = () => ui.invoke('service_list');
  const state = expected => ui.waitFor(`${summary}?.dataset.state===${JSON.stringify(expected)}`);
  const action = async (label, within = 'button') => {
    const expression = button(label, within);
    await ui.waitFor(`!!(${expression})&&!((${expression}).disabled)`);
    await click(`(${expression})`);
  };
  async function tools(label) {
    await click(query('.tools-menu > summary'));
    await ui.waitFor("!!document.querySelector('.tools-menu .tools-menu-content[data-positioned]')");
    await action(label, '.tools-menu button');
  }
  async function openSsh() {
    await tools('SSH2 连接');
    await ui.waitFor(`!!${sshDialog}`);
  }
  async function closeSsh() {
    await action('关闭 SSH2 工具', '.ssh-panel button');
    await ui.waitFor(`!${sshDialog}`);
  }
  async function authenticate(peer) {
    await ui.waitFor(`!!(${button('拒绝 SSH2 主机')})||!!(${button('使用保存的 SSH2 凭据')})`);
    if (await ui.evaluate(`!!(${button('拒绝 SSH2 主机')})`)) {
      assert.equal(await ui.evaluate(`${query('.ssh-panel .fingerprint')}.textContent`), peer.pin);
      await click(query('[aria-label="已核对 SSH2 主机指纹"]'));
      await action('信任本次 SSH2 主机', '.ssh-panel button');
    }
    await action('使用保存的 SSH2 凭据', '.ssh-panel button');
    await state('CONNECTED');
    await peer.control({op:'keyboard_echo'});
  }
  async function originalAfterLostReply(op, label, connection, checkBeforeQuery) {
    const hook = await ui.interceptIpc({command:'ssh_request',op,mode:'error',connectionId:connection.connection_id});
    try {
      await action(label, '.ssh-panel button');
      await ui.waitFor("!!document.querySelector('.ssh-receipt code')");
      assert.equal(await hook.count(),1);
    } finally { await hook.restore(); }
    const id = await ui.evaluate("document.querySelector('.ssh-receipt code').textContent");
    assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    await checkBeforeQuery();
    assert.equal(await ui.evaluate("document.querySelector('.ssh-receipt code').textContent"),id);
    await action('查询原请求', '.ssh-panel button');
    await ui.waitFor("!document.querySelector('.ssh-receipt')");
    return id;
  }

  fit(1100,760);
  await ui.waitFor('innerWidth>=1080');
  const first = await source('panel-first'), second = await source('panel-second');
  const profile = {id:crypto.randomUUID(),folder_id:null,name:'开发服务器',settings:{
    protocol:'ssh2',host:'localhost',port:first.port,username:'synthetic',auth:'password',encoding:'utf8',
  }};
  const saved = await ui.invoke('config_request',{request:{op:'save_profile',profile,
    credential:{action:'replace',value:{password:first.password,private_key:null,passphrase:null}}}});
  assert.equal(saved.result,'saved_profile');
  await openSsh();
  await ui.waitFor(`${query('#saved-ssh-profile')}.value===${JSON.stringify(profile.id)}`);
  await ui.waitFor('document.activeElement.id==="saved-ssh-profile"');
  await key('Tab','Tab',9);
  await ui.waitFor('document.activeElement.getAttribute("aria-label")==="刷新 SSH2 配置"');
  assert.notEqual(await ui.evaluate('getComputedStyle(document.activeElement).outlineStyle'),'none');
  await enter();
  await ui.waitFor('!document.querySelector(".ssh-profile-row .icon-button").disabled');
  await action('建立 SSH2 连接','.ssh-panel button');
  await authenticate(first);
  const a = (await list())[0];
  const b = await connect(second,false);
  await action('刷新会话树','.session-sidebar button');
  await ui.selectTab(a.connection_id);
  await state('CONNECTED');
  const address = `localhost:${first.port}`;
  assert.ok((await ui.evaluate(`${summary}.textContent`)).includes(address));
  await closeSsh();
  assert.equal((await ssh({op:'status',connection:ref(a)})).connection.state,'CONNECTED');
  await keyGoesTo(a,'PANEL_CLOSE_PRESERVES_SSH',[b]);

  await splitRight(b);
  const geometry = {};
  for (const theme of ['light','dark']) {
    await setTheme(theme);
    for (const [width,height,kind] of [[1100,760,'wide'],[720,480,'narrow']]) {
      fit(width,height);
      await ui.waitFor(width===720?'innerWidth<=725':'innerWidth>=1080');
      const dimension = theme+'-'+kind;
      const toolbar = await measureCompactToolbar(ui);
      assert.equal(toolbar.height,38);
      assert.equal(toolbar.gap,20);
      assert.deepEqual(toolbar.controls.map(c=>c.label),['会话导航','日志','打开日志目录','更多工具']);
      assert.equal(toolbar.tabTops.length,2);
      const paneControls = await ui.evaluate(`[...document.querySelectorAll('.pane-tab-bar')].map(bar=>
        ['.new-menu > summary','.pane-collapse'].map(selector=>{
          const target=bar.querySelector(selector),rect=target.getBoundingClientRect(),icon=target.querySelector('svg').getBoundingClientRect();
          return [rect.width,rect.height,icon.width,icon.height,rect.right<=bar.getBoundingClientRect().right-3];
        }))`);
      assert.deepEqual(paneControls,Array.from({length:2},()=>[[28,28,16,16,true],[28,28,16,16,true]]));
      await ui.screenshot(`desktop-${version}-panes-${dimension}.png`);
      await openSsh();
      await state('CONNECTED');
      assert.ok((await ui.evaluate(`${summary}.textContent`)).includes(address));
      const row = await ui.evaluate(`[...document.querySelector('.ssh-profile-row').children].map(element=>{
        const b=element.getBoundingClientRect();return [b.top,b.height];
      })`);
      assert.equal(new Set(row.map(dim=>dim[0])).size,1);
      assert.deepEqual(row.map(dim=>dim[1]),[32,32,32]);
      assert.equal(await ui.evaluate('document.querySelector(".ssh-connection-detail").open'),false);
      await ui.screenshot(`desktop-${version}-ssh-${dimension}.png`);
      geometry[dimension]={toolbar,paneControls,sshProfileRow:row};
      await closeSsh();
    }
  }

  const paneAdd = query('[aria-label="终端窗格 2"] .new-menu > summary');
  await click(paneAdd);
  await ui.waitFor("!!document.querySelector('[aria-label=\"终端窗格 2\"] .new-menu [data-positioned]')");
  await action('连接服务器','[aria-label="终端窗格 2"] .new-menu button');
  await ui.waitFor("!!document.querySelector('dialog:modal .config-panel[aria-label=\"SSH快速连接\"]')");
  await key('Escape','Escape',27);
  await ui.waitFor("!document.querySelector('dialog:modal')");
  assert.equal((await list()).length,2);
  const paneCollapse = query('[aria-label="终端窗格 2"] .pane-collapse');
  assert.equal(await ui.evaluate(`${paneCollapse}.title`),'收起此窗格，保留连接');
  await ui.evaluate(`${paneCollapse}.focus()`);
  await enter();
  await ui.waitFor("document.querySelectorAll('[data-pane]').length===1");
  const afterFold = await list();
  assert.equal(afterFold.filter(c=>c.state==='CONNECTED').length,2);
  await ui.selectTab(b.connection_id);
  await keyGoesTo(b,'COLLAPSE_PRESERVES_SSH',[a]);

  await ui.selectTab(a.connection_id);
  await openSsh();
  await state('CONNECTED');
  await click(query('.ssh-connection-detail > summary'));
  assert.ok((await ui.evaluate("document.querySelector('.ssh-connection-detail').textContent")).includes(a.connection_id));
  const menu = query('.ssh-session-menu > summary');
  await ui.evaluate(`${menu}.focus()`);
  await enter();
  await ui.waitFor("document.querySelector('.ssh-session-menu').open");
  assert.equal(await ui.evaluate("document.querySelector('.ssh-session-menu button').disabled"),true);
  await key('Escape','Escape',27);
  await ui.waitFor(`document.activeElement===${menu}&&!document.querySelector('.ssh-session-menu').open`);

  const disconnectId = await originalAfterLostReply('disconnect','断开连接',a,async()=>{
    await state('DISCONNECTED');
    assert.equal((await ssh({op:'status',connection:ref(b)})).connection.state,'CONNECTED');
    await closeSsh();
    await openSsh();
  });
  const attempts = (await first.control({op:'metrics'})).accepted_connections;
  const reconnectId = await originalAfterLostReply('reconnect','重新连接',a,async()=>{
    await wait(async()=>(await first.control({op:'metrics'})).accepted_connections===attempts+1,'exact reconnect reached the saved endpoint once');
  });
  await authenticate(first);
  const next = (await list()).find(c=>c.connection_id===a.connection_id);
  assert.equal(next.generation,a.generation+1);
  assert.equal((await first.control({op:'metrics'})).accepted_connections,attempts+1);
  await tools('终端日志');
  await action('开始记录终端');
  await action('关闭日志面板');
  await closeSsh();
  await keyGoesTo(next,'KEEP_THIS_LOG_AFTER_FORGET',[b]);
  await tools('终端日志');
  await action('停止记录终端');
  await action('关闭日志面板');
  const recorded = await wait(async()=>{
    const {logs} = await ui.invoke('logging_request',{request:{op:'list',connection:ref(next)}});
    return logs.find(entry=>entry.durable&&entry.readable);
  },'recording of the exact ended generation synced to a user-visible file');
  assert.equal(path.basename(recorded.readable.filename),recorded.readable.filename);
  const logPath = path.join(root,'logs',recorded.readable.filename);
  const recordedBytes = await readFile(logPath);
  assert.ok(recordedBytes.includes('KEEP_THIS_LOG_AFTER_FORGET'));
  await openSsh();
  await state('CONNECTED');
  await action('断开连接','.ssh-panel button');
  await state('DISCONNECTED');
  async function showRemoval() {
    await click(menu);
    await action('移除连接记录','.ssh-session-menu button');
    await ui.waitFor("!!document.querySelector('.ssh-forget')");
  }
  await showRemoval();
  await ui.waitFor('document.activeElement.textContent==="取消移除"');
  await key('Escape','Escape',27);
  await ui.waitFor(`!${query('.ssh-forget')} && !!${sshDialog}`);
  assert.ok((await list()).some(c=>c.connection_id===a.connection_id));
  await showRemoval();
  await ui.selectTab(b.connection_id);
  await state('CONNECTED');
  assert.equal(await ui.evaluate(`!!${query('.ssh-forget')}`),false);
  await ui.selectTab(a.connection_id);
  await state('DISCONNECTED');
  await showRemoval();
  await ui.screenshot(`desktop-${version}-ssh-removal-confirmation.png`);
  const forgetId = await originalAfterLostReply('forget_start','确认移除连接记录',next,async()=>{
    await wait(async()=>!(await list()).some(c=>c.connection_id===a.connection_id),'only confirmed record removed');
    assert.deepEqual((await list()).map(ref),[ref(b)]);
  });
  const profilePage = await ui.invoke('config_request',{request:{op:'page',revision:null,offset:0,folders:false}});
  assert.ok(profilePage.profiles.some(p=>p.id===profile.id));
  assert.deepEqual(await readFile(logPath),recordedBytes);
  await closeSsh();

  const treeRefresh = button('刷新会话树','.session-sidebar button');
  assert.equal(await ui.evaluate(`(${treeRefresh}).querySelector('svg').getBoundingClientRect().width`),16);
  await action('刷新会话树','.session-sidebar button');
  await ui.selectTab(b.connection_id);
  for (const [label,close] of [['串口高级工具','关闭串口高级工具'],['终端日志','关闭日志面板'],['连接配置','关闭配置']]) {
    await tools(label);
    const icon = button(close);
    await ui.waitFor(`!!(${icon})`);
    assert.equal(await ui.evaluate(`(${icon}).querySelector('svg').getBoundingClientRect().width`),16);
    if (label === '终端日志') await action('开始记录终端');
    if (label === '连接配置') await action('刷新配置');
    await action(close);
  }
  const logs = await ui.invoke('logging_request',{request:{op:'list',connection:ref(b)}});
  assert.equal(logs.logs[0]?.active,true);
  assert.equal((await ssh({op:'status',connection:ref(b)})).connection.state,'CONNECTED');
  return {result:'PASS',geometry,disconnectId,reconnectId,forgetId,closeKeepsConnection:true,
    foldedConnectionAcceptsInput:true,exactLifecycleTarget:true,removedOnlyAfterConfirmation:true,savedLogPreserved:true};
}
