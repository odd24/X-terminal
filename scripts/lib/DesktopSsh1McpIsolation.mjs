import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { processRpc } from '../jsonrpc-client.mjs';
import { delay } from './DesktopHarness.mjs';
import { active } from './DesktopKeyboard.mjs';

const marker = 'P13_SSH2_READ_ONLY_SENTINEL';
const query = selector => `document.querySelector(${JSON.stringify(selector)})`;

export async function verifyDesktopSsh1McpIsolation({ ui, keyboard, directory, preview, ssh1, ssh1Peer, owner }) {
  const child = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const ended = once(child, 'exit');
  ended.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  async function reply() {
    let timer;
    try {
      const line = await Promise.race([replies.next(), ended.then(() => { throw new Error('SSH2 fixture exited'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSH2 fixture reply timed out')), 5000); })]);
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    } finally { clearTimeout(timer); }
  }
  const control = request => {
    child.stdin.write(JSON.stringify(request) + '\n');
    return reply();
  };
  const management = request => ui.invoke('agent_management_request', { request });
  const broker = request => ui.invoke('bridge_management_request', { request });
  const helperCount = () => Number(execFileSync('pwsh', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${owner.pid} AND Name='ssh1-helper.exe'").Count`],
  { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim());
  let rpc, grantId;
  try {
    const fixture = await reply();
    await ui.click('连接服务器');
    await ui.waitFor(`${query('[aria-label="SSH服务器"]:not([disabled])')}!==null`);
    await ui.fill('SSH服务器', '127.0.0.1');
    await ui.fill('SSH用户名', 'synthetic');
    await ui.evaluate(`[...document.querySelectorAll('summary')].find(node=>node.textContent==='高级连接设置').parentElement.open=true`);
    await ui.fill('SSH端口', fixture.port);
    await ui.click('连接');
    const hostApproval = '[aria-label="快速连接核对指纹"]';
    await ui.waitFor(`!!${query(hostApproval)}`);
    assert.equal(await ui.evaluate(`${query('dialog:modal .fingerprint')}.textContent`) === fixture.pin, true);
    assert.equal(await ui.evaluate(`${query(hostApproval)}.checked`), false);
    await ui.evaluate(`${query(hostApproval)}.click()`);
    await ui.click('信任并继续登录');
    await ui.waitFor(`${active('[aria-label="SSH登录密码"]')} && !document.activeElement.disabled
      && [...document.querySelectorAll('dialog:modal button')].some(button=>button.textContent==='提交本次登录信息'&&!button.disabled)`);
    await ui.command('Input.insertText', { text: fixture.password });
    await keyboard.enter();
    await ui.waitFor("!document.querySelector('dialog:modal')");

    const sessions = await ui.invoke('service_list');
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every(session => session.state === 'CONNECTED'));
    assert.ok(sessions.some(session => session.protocol === 'SSH1' && session.connection_id === ssh1.connection_id
      && session.generation === ssh1.generation));
    const { connection_id, generation } = sessions.find(session => session.protocol === 'SSH2');
    const ssh2 = { connection_id, generation };
    const currentOwner = await ui.invoke('service_status');
    assert.deepEqual([currentOwner.service_id, currentOwner.pid, currentOwner.fixture], [owner.service_id, owner.pid, false]);
    assert.equal(helperCount(), 1);
    await control({ op: 'push', text: `${marker}\r\n` });

    const info = await broker({ op: 'info' });
    assert.equal(path.resolve(info.executable), path.resolve(preview, 'terminal-mcp.exe'));
    assert.equal(info.desktop_pid, ui.app.pid);
    assert.equal(info.peer, null);
    grantId = randomUUID();
    const signed = await management({ op: 'grant', request_id: grantId, lifetime_ms: 120000,
      scopes: [{ target: { kind: 'connection', connection: ssh2 }, action: 'READ' }] });
    assert.equal(JSON.stringify(signed).includes('token'), false);
    rpc = processRpc(info.executable, ['--stdio', '--broker', info.instance, '--desktop-pid', String(info.desktop_pid)]);
    const initialized = await rpc.request('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p13-read-isolation', version: '1' },
    });
    assert.ok(initialized.result.capabilities.tools);
    rpc.notify('notifications/initialized', {});
    const catalog = (await rpc.request('tools/list', {})).result.tools;
    assert.equal(catalog.length, 29);
    assert.deepEqual({ version: 11, tools: catalog }, JSON.parse(await readFile('contracts/mcp/initial-tools.json', 'utf8')));
    const call = async (name, args = {}) => (await rpc.request('tools/call', { name, arguments: args })).result;
    const success = async (name, args) => {
      const result = await call(name, args);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.mock, false);
      return result.structuredContent.reply;
    };
    const pending = await success('agent_status');
    assert.deepEqual([pending.data.peer_pid, pending.data.paired_ticket], [rpc.child.pid, null]);
    await ui.click('Agent 授权');
    const grantInput = '[aria-label="Agent签发编号"]';
    await ui.waitFor(`!!${query(grantInput)}`);
    await ui.fill('Agent签发编号', grantId);
    await ui.click('查询原Agent编号');
    await ui.waitFor(`${query('[aria-label="Agent授权详情"]')}?.textContent.includes('ACTIVE')`);
    await ui.evaluate(`[...document.querySelectorAll('summary')].find(node=>node.textContent==='MCP 初版连接').click()`);
    await ui.click('刷新MCP连接状态');
    await ui.waitFor(`!!${query('[aria-label="MCP本次启动参数"]')}`);
    await ui.click('预览MCP绑定原授权');
    const binding = '[aria-label="MCP固定配对预览"]';
    await ui.waitFor(`!!${query(binding)}`);
    const details = await ui.evaluate(`${query(binding)}.textContent`);
    assert.ok(details.includes(String(rpc.child.pid)) && details.includes(grantId));
    const consent = '[aria-label="同意MCP绑定原授权"]';
    assert.equal(await ui.evaluate(`${query(consent)}.checked`), false);
    await ui.evaluate(`${query(consent)}.click()`);
    await ui.click('确认MCP绑定');
    await ui.waitFor(`${query('[aria-label="MCP配对状态"]')}?.textContent.includes('已绑定独立Agent身份')`);
    assert.equal((await success('agent_status')).data.paired_ticket, signed.data.summary.ticket_id);

    const visible = await success('sessions_list');
    assert.deepEqual(visible.data.map(({ connection_id, generation }) => ({ connection_id, generation })), [ssh2]);
    const readInfo = { connection: ssh2, window: null, view: { kind: 'info' } };
    const context = await success('terminal_read', readInfo);
    assert.equal(context.result, 'context');
    const page = await success('terminal_read', { ...readInfo,
      view: { kind: 'text', cursor: 1, through_cursor: context.data.context.through_cursor, max_bytes: 65536 } });
    assert.ok(page.data.page.events.map(event => event.text).join('').includes(marker));
    const denied = await call('terminal_read', { ...readInfo, connection: ssh1 });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error_code, 'PERMISSION_DENIED');
    assert.equal(denied.structuredContent.reply, undefined);
    assert.deepEqual((await control({ op: 'metrics' })).received, []);

    await management({ op: 'grant_revoke', request_id: grantId });
    grantId = undefined;
    const stdio = await rpc.close();
    rpc = undefined;
    assert.deepEqual(stdio, { code: 0, signal: null });
    for (let attempt = 0; attempt < 100 && (await broker({ op: 'info' })).peer !== null; attempt++) await delay(30);
    assert.equal((await broker({ op: 'info' })).peer, null);
    for (const target of [ssh1, ssh2]) {
      await ui.evaluate(`${query(`[aria-label="关闭标签 ${target.connection_id}"]`)}.click()`);
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await ui.invoke('service_list');
      if (current.every(session => session.state === 'DISCONNECTED')) break;
      if (attempt === 99) throw new Error('Owned connections did not disconnect');
      await delay(40);
    }
    assert.equal(helperCount(), 0);
    child.stdin.end();
    const [ssh2Exit, ssh2Signal] = await ended;
    assert.deepEqual([ssh2Exit, ssh2Signal], [0, null]);
    await ui.evaluate("document.querySelector('.tools-menu').open=true");
    await ui.click('退出桌面');
    for (let attempt = 0; attempt < 100 && ui.app.exitCode === null; attempt++) await delay(50);
    assert.equal(ui.app.exitCode, 0);
    const wsl = await ssh1Peer.done;
    assert.ok(wsl.signal === null && [0, 124].includes(wsl.code));
    await ui.close();
    assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
    return { result: 'PASS', preview, serviceId: owner.service_id, ssh1, ssh2, tools: 29, ownRead: true,
      ssh1Listed: false, ssh1Read: 'PERMISSION_DENIED', ssh2TerminalInputBytes: 0,
      helperCount: 0, brokerPeerReleased: true, stdio, desktopExit: 0, serviceExited: true, ssh2Exit, wsl };
  } finally {
    try {
      if (grantId) await management({ op: 'grant_revoke', request_id: grantId }).catch(() => {});
    } finally {
      try { await rpc?.close(); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await ended.catch(() => {});
        lines.close();
      }
    }
  }
}
