import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { checkOwnerCrashRestart, crashDesktopOwner } from './lib/DesktopOwnerCrashChecks.mjs';

async function verifiedPreview(id, expectedHead) {
  const directory = path.resolve('artifacts', `shared-terminal-preview-${id}`);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.packagedFromHead, expectedHead);
  assert.match(manifest.smoke, /^PASS: copied desktop\/ordinary sibling service/);
  assert.deepEqual(manifest.files.map(file => file.name).sort(),
    ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(directory, file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  return { id, head: manifest.packagedFromHead, directory, files: manifest.files };
}

const ownerCrash = process.argv.includes('--owner-crash');
const newPreview = await verifiedPreview('a38cc309-3888-4aaf-8e1c-c821d347ad5a', 'adbd3d138309cd309308b07b0ad6fb1e580d68a5');
const oldPreview = ownerCrash ? newPreview
  : await verifiedPreview('2b35c396-a51c-4f1f-9472-21314b58c7bd', '0bd0c1054cad2f4d25dc1943235e440fa4adb986');
if (!ownerCrash) {
  assert.notEqual(oldPreview.head, newPreview.head);
  assert.notDeepEqual(oldPreview.files, newPreview.files);
}

const prefix = ownerCrash ? 'shared-terminal-owner-crash-中文-' : 'shared-terminal-preview-switch-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const data = path.join(root, '共同应用数据');
await mkdir(data);
const fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [root], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const ended = new Promise(resolve => fixture.once('exit', resolve));
const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
let fixtureError;
fixture.on('error', error => { fixtureError = error; });
let oldUi, newUi, evidence;
const button = label => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
const config = (ui, request) => ui.invoke('config_request', { request });
const page = ui => config(ui, { op: 'page', revision: null, offset: 0, folders: false });
const agent = (ui, request) => ui.invoke('agent_management_request', { request });
const sessions = ui => ui.invoke('service_list');
const status = ui => ui.invoke('service_status');

async function fixtureReply() {
  let timer;
  try {
    const line = await Promise.race([lines.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SSH fixture reply timed out')), 10000);
    })]);
    if (fixtureError) throw fixtureError;
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  } finally { clearTimeout(timer); }
}
async function metrics() {
  fixture.stdin.write(JSON.stringify({ op: 'metrics' }) + '\n');
  return fixtureReply();
}
async function boot(preview, webview) {
  return launchDesktop(data, {
    executable: path.join(preview.directory, 'shared-terminal-desktop.exe'),
    webviewDirectory: path.join(root, webview),
  });
}
async function close(ui, owner, active) {
  await ui.evaluate(`(()=>{
    const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click();
    setTimeout(()=>${button('退出桌面')}.click(),50);
  })()`);
  if (active) {
    await ui.waitFor(`!!document.querySelector('[aria-label="退出桌面确认"]')`);
    await ui.evaluate(`setTimeout(()=>${button('确认退出并停止服务')}.click(),50)`);
  }
  for (let i = 0; i < 160 && ui.app.exitCode === null; i++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  await ui.close();
  const receipt = JSON.parse(await readFile(path.join(data, 'desktop-close-receipts-v1', `${owner.service_id}.json`), 'utf8'));
  assert.equal(receipt.service_id, owner.service_id);
  assert.equal(receipt.owned_pid, owner.pid);
  assert.equal(receipt.shutdown_ack, 'ACKNOWLEDGED');
  assert.equal(receipt.exited, true);
  assert.equal(receipt.kill_requested, false);
  return receipt;
}
function schemaVersion() {
  const sql = new DatabaseSync(path.join(data, 'config.sqlite'), { readOnly: true });
  try { return sql.prepare('PRAGMA user_version').get().user_version; } finally { sql.close(); }
}

try {
  const server = await fixtureReply();
  oldUi = await boot(oldPreview, '旧版WebView');
  const old = await status(oldUi);
  assert.equal(old.fixture, false);
  const profile = {
    id: randomUUID(), folder_id: null, name: '版本切换合成 SSH2',
    settings: { protocol: 'ssh2', host: '127.0.0.1', port: server.port, username: 'synthetic', auth: 'password', encoding: 'utf8' },
  };
  const saved = await config(oldUi, { op: 'save_profile', profile, credential: { action: 'keep' } });
  assert.equal(saved.result, 'saved_profile');
  await oldUi.click('SSH2 连接');
  await oldUi.waitFor(`document.querySelector('[aria-label="SSH2 配置"]')?.options.length===2`);
  await oldUi.fill('SSH2 配置', profile.id);
  await oldUi.click('建立 SSH2 连接');
  await oldUi.waitFor(`!!(${button('拒绝 SSH2 主机')})`);
  assert.equal(await oldUi.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`), server.pin);
  await oldUi.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
  await oldUi.click('信任本次 SSH2 主机');
  await oldUi.waitFor(`!!document.querySelector('[aria-label="SSH2 临时密码"]')`);
  await oldUi.fill('SSH2 临时密码', server.password);
  await oldUi.click('提交本次 SSH2 密码');
  await oldUi.waitFor(`document.querySelector('[aria-label="SSH2 状态"]')?.textContent.startsWith('CONNECTED')`);
  const [session] = await sessions(oldUi);
  assert.equal(session.protocol, 'SSH2');
  const ref = { connection_id: session.connection_id, generation: session.generation };
  const oldPage = await page(oldUi);
  assert.equal(oldPage.profiles[0].credential_ref, null);
  assert.equal(schemaVersion(), 7);

  await oldUi.waitFor(`[...document.querySelectorAll('[role=\"tab\"]')].some(tab=>tab.dataset.connectionId===${JSON.stringify(ref.connection_id)})`);
  await oldUi.selectTab(ref.connection_id);
  await oldUi.click('Agent 授权');
  await oldUi.waitFor(`document.querySelector('[aria-label="Agent批准目标"]')?.textContent.includes(${JSON.stringify(ref.connection_id)})`);
  assert.equal(await oldUi.evaluate(`document.querySelector('[aria-label="授权读取终端"]').checked`), false);
  await oldUi.evaluate(`document.querySelector('[aria-label="授权读取终端"]').click()`);
  await oldUi.fill('Agent授权秒数', '300');
  await oldUi.click('预览Agent授权');
  await oldUi.waitFor(`!!(${button('确认批准Agent')})`);
  await oldUi.evaluate(`document.querySelector('[aria-label="同意本次Agent范围"]').click()`);
  await oldUi.click('确认批准Agent');
  await oldUi.waitFor(`document.querySelector('[aria-label="Agent管理状态"]')?.textContent.includes('已签发限时授权')`);
  const grant = await oldUi.evaluate(`JSON.parse(sessionStorage.getItem('shared-terminal-agent-grant'))`);
  assert.equal(grant.service_id, old.service_id);
  const originalGrant = await agent(oldUi, { op: 'grant_status', request_id: grant.request_id });
  assert.deepEqual(originalGrant.data.effective_scopes, [{ target: { kind: 'connection', connection: ref }, action: 'READ' }]);
  await oldUi.click('关闭Agent授权');

  await oldUi.click('基础撰写');
  await oldUi.waitFor(`document.querySelector('[aria-label="撰写目标"]')?.textContent.includes(${JSON.stringify(ref.connection_id)})`);
  await oldUi.fill('撰写末尾换行', 'crlf');
  let expectedWire = '';
  async function sendSentinel(text) {
    await oldUi.fill('撰写正文', text);
    await oldUi.waitFor(`${button('预览撰写发送')}?.disabled===false`);
    await oldUi.click('预览撰写发送');
    await oldUi.waitFor(`!!(${button('确认发送撰写')})`);
    await oldUi.click('确认发送撰写');
    expectedWire += text + '\r\n';
    await oldUi.waitFor(`document.querySelector('[aria-label="撰写正文"]')?.value==='' `);
    for (let i = 0; i < 100; i++) {
      const seen = await metrics();
      const bytes = Buffer.from(seen.received.flat());
      if (bytes.length >= Buffer.byteLength(expectedWire)) {
        assert.deepEqual(bytes, Buffer.from(expectedWire));
        assert.equal(seen.accepted_connections, 1);
        assert.equal(seen.attempts, 1);
        return;
      }
      await delay(30);
    }
    throw new Error('Explicit old Desktop input did not reach the loopback peer');
  }
  await sendSentinel(ownerCrash ? 'P24_OWNER_CRASH_BEFORE' : 'P24_SWITCH_BEFORE');

  if (ownerCrash) {
    const observed = await crashDesktopOwner(oldUi, old, oldPreview.directory);
    oldUi = undefined;
    newUi = await boot(newPreview, '重开WebView');
    const { current, ...peer } = await checkOwnerCrashRestart({
      ui: newUi, owner: old, grant, profiles: oldPage.profiles, data, metrics, expectedWire,
    });
    const restartedClose = await close(newUi, current, false);
    assert.equal(restartedClose.exit_code, 0);
    newUi = undefined;
    evidence = {
      result: 'PASS', preview: { id: newPreview.id, head: newPreview.head },
      originalService: old.service_id, originalSession: ref, observed,
      previousClose: current.previous_close, originalGrantAfterRestart: 'NotFound', newSessionCount: 0,
      restartedService: current.service_id, restartedClose, ...peer,
    };
  } else {
    newUi = await boot(newPreview, '新版WebView');
    const blocked = await status(newUi);
    assert.equal(blocked.fixture, false);
    assert.notEqual(blocked.service_id, old.service_id);
    assert.notEqual(blocked.pid, old.pid);
    const locked = { result: 'error', code: 'LOCKED' };
    assert.deepEqual(await page(newUi), locked);
    assert.deepEqual(await sessions(newUi), []);
    await newUi.click('连接服务器');
    await newUi.waitFor(`document.querySelector('dialog:modal [role="alert"]')?.textContent.includes('未取得配置目录的独占访问权')`);
    assert.equal(await newUi.evaluate(`${button('连接')}.disabled`), true);
    await newUi.click('重新检查配置目录');
    await newUi.waitFor(`document.querySelector('[aria-label="配置目录复查状态"]')?.textContent.includes('本次复查仍未取得')`);
    assert.deepEqual(await page(newUi), locked);
    const stillOld = await status(oldUi);
    assert.equal(stillOld.service_id, old.service_id);
    assert.equal(stillOld.pid, old.pid);
    assert.deepEqual(await sessions(oldUi), [session]);
    assert.deepEqual(await page(oldUi), oldPage);
    await sendSentinel('P24_SWITCH_WHILE_LOCKED');
    assert.deepEqual(await agent(oldUi, { op: 'grant_status', request_id: grant.request_id }), originalGrant);
    await oldUi.click('关闭撰写');
    const oldClose = await close(oldUi, old, true);
    assert.equal(oldClose.exit_code, 0);
    oldUi = undefined;

    assert.deepEqual(await page(newUi), locked);
    await newUi.click('重新检查配置目录');
    await newUi.waitFor(`Array.from(document.querySelector('[aria-label="快速连接已保存"]')?.options??[]).some(o=>o.value===${JSON.stringify(profile.id)})`);
    const ready = await status(newUi);
    assert.equal(ready.service_id, blocked.service_id);
    assert.equal(ready.pid, blocked.pid);
    assert.deepEqual((await page(newUi)).profiles, oldPage.profiles);
    assert.equal(schemaVersion(), 7);
    assert.deepEqual(await sessions(newUi), []);
    assert.deepEqual((await agent(newUi, { op: 'grant_list' })).data, []);
    assert.equal(await newUi.evaluate(`window.__TAURI_INTERNALS__.invoke('agent_management_request',{request:{op:'grant_status',request_id:${JSON.stringify(grant.request_id)}}}).then(()=>null,e=>String(e))`), 'NotFound');
    await delay(600);
    const finalPeer = await metrics();
    assert.deepEqual(Buffer.from(finalPeer.received.flat()), Buffer.from(expectedWire));
    assert.equal(finalPeer.accepted_connections, 1);
    assert.equal(finalPeer.attempts, 1);
    await newUi.click('收起连接窗口');
    const newClose = await close(newUi, blocked, false);
    newUi = undefined;
    evidence = {
      result: 'PASS', oldPreview: { id: oldPreview.id, head: oldPreview.head },
      newPreview: { id: newPreview.id, head: newPreview.head },
      schema: 7, originalSession: ref, oldClose, newClose, sameNewOwnerAfterRecheck: true,
      originalGrantAfterSwitch: 'NotFound', newSessionCount: 0,
      peerConnections: finalPeer.accepted_connections, peerAuthAttempts: finalPeer.attempts,
      peerBytes: Buffer.byteLength(expectedWire),
    };
  }
} catch (error) {
  console.error('P24 owned preview-switch root retained:', root);
  throw error;
} finally {
  try {
    await newUi?.close();
    await oldUi?.close();
  } finally {
    if (!fixtureError) {
      if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
      await ended;
    }
  }
}
const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile(ownerCrash ? 'artifacts/P24-owner-crash.json' : 'artifacts/P24-preview-switch.json',
  JSON.stringify(evidence, null, 2) + '\n');
console.log(ownerCrash ? 'PASS ordinary Desktop owner crash, active SSH2 service reaped and manual restart isolated'
  : 'PASS ordinary side-by-side previews, active SSH2 ownership and explicit configuration handoff');
