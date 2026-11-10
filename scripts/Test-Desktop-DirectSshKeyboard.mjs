import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard, terminalInput as terminal } from './lib/DesktopKeyboard.mjs';

const authRecovery = process.argv.includes('--auth-recovery');
const artifact = authRecovery ? 'P12.1-auth-recovery-keyboard' : 'P12.1-direct-ssh-keyboard';
const manifest = authRecovery ? 'P12-compact-config-dpi-preview' : 'P22-audit-grant-feedback-preview';
const preview = JSON.parse(await readFile(`artifacts/${manifest}.json`, 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}

const prefix = authRecovery ? 'shared-terminal-auth-recovery-keyboard-中文-' : 'shared-terminal-direct-ssh-keyboard-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const peer = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [root], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const ended = new Promise(resolve => peer.once('exit', resolve));
let peerError;
peer.on('error', error => { peerError = error; });
const lines = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
let ui, evidence;
const focusTrace = [];
async function nextReply() {
  let timer;
  try {
    const line = await Promise.race([lines.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SSH fixture reply timed out')), 10000);
    })]);
    if (peerError) throw peerError;
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  } finally { clearTimeout(timer); }
}
async function metrics() {
  peer.stdin.write('{"op":"metrics"}\n');
  return nextReply();
}

async function verifyRecovery(server, keyboard, page) {
  const { type, enter, recordFocus } = keyboard;
  const list = () => ui.invoke('service_list');
  const [original, ...others] = await list();
  assert.deepEqual(others, []);
  assert.equal(original?.protocol, 'SSH2');
  assert.equal(original.state, 'AUTHENTICATING');
  const ref = { connection_id: original.connection_id, generation: original.generation };
  const status = () => ui.invoke('ssh_request', { request: { op: 'status', connection: ref } });
  const initial = await status();
  assert.equal(initial.challenge?.kind, 'credentials');
  assert.equal((await metrics()).attempts, 0);

  const wrong = 't22-incorrect-temporary';
  assert.ok(wrong !== server.password);
  const password = '[aria-label="SSH登录密码"]';
  const alert = 'dialog:modal [role="alert"]';
  const prompt = '[aria-label="SSH快速状态"]';
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const noSecret = () => ui.evaluate(`!document.body.textContent.includes(${JSON.stringify(wrong)})
    && !document.body.textContent.includes(${JSON.stringify(server.password)})`);
  await type(wrong);
  await enter();
  await ui.waitFor(`${query(alert)}?.textContent.includes('未被服务器接受')
    && ${query(prompt)}?.textContent.includes('可直接输入并按回车提交，无需取消连接')
    && ${active(password)} && !document.activeElement.disabled`);
  assert.ok(await ui.evaluate(`(() => {
    const visible=node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));};
    const field=document.activeElement, style=getComputedStyle(field);
    return visible(${query(alert)}) && visible(field) && field.matches(':focus-visible')
      && style.outlineStyle==='solid' && parseFloat(style.outlineWidth)>0;
  })()`), 'Visible rejection and keyboard focus on the retry field');
  assert.ok(await ui.evaluate('document.activeElement.value === ""'), 'Rejected password must be cleared');
  assert.ok(await noSecret(), 'Authentication material must not appear in DOM text');
  await recordFocus('拒绝后可见密码补录焦点');
  const rejected = await status();
  assert.deepEqual(rejected.connection, original);
  assert.equal(rejected.failure, 'AUTHENTICATION_REJECTED');
  assert.equal(rejected.challenge?.kind, 'credentials');
  assert.notEqual(rejected.challenge.id, initial.challenge.id);
  await ui.screenshot(`${artifact}-retry.png`);
  await delay(650); // More than two status poll intervals without another key.
  const waiting = await metrics();
  assert.equal(waiting.accepted_connections, 1);
  assert.equal(waiting.attempts, 1);
  assert.deepEqual(await list(), [original]);

  await type(server.password);
  await enter();
  const pane = `.terminal-pane[data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
  await ui.waitFor(`!document.querySelector('dialog:modal') && ${active(`${pane} ${terminal}`)}`);
  await recordFocus('更正后原连接终端');
  assert.deepEqual(await list(), [{ ...original, state: 'CONNECTED' }]);
  assert.ok(await noSecret());
  const finished = await metrics();
  assert.equal(finished.accepted_connections, 1);
  assert.equal(finished.attempts, 2);
  assert.deepEqual(finished.received, []);
  assert.deepEqual((await page()).profiles, []);
  const credentials = await ui.invoke('config_request', { request: { op: 'credentials_page', revision: null, offset: 0 } });
  assert.deepEqual(credentials.entries, []);
  return { result: 'PASS', preview: preview.directory, connection: ref,
    rejected: rejected.failure, retryChallengeChanged: true, sameConnection: true,
    waitingAttempts: waiting.attempts, authenticationAttempts: finished.attempts,
    peerConnections: finished.accepted_connections, passwordCleared: true, secretsAbsentFromDomText: true, focusTrace };
}

try {
  const server = await nextReply();
  ui = await launchDesktop(root, { executable: path.join(preview.directory, 'shared-terminal-desktop.exe') });
  const keyboard = desktopKeyboard(ui, focusTrace);
  const { key, type, enter, tabTo } = keyboard;
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const page = () => ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
  assert.deepEqual((await page()).profiles, []);
  assert.deepEqual(await ui.invoke('service_list'), []);
  await tabTo(activeText('连接服务器'), '直接连接入口');
  await enter();
  await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="SSH服务器"]:not([disabled])')`);
  if (!authRecovery) {
    await key('Escape', 'Escape', 27);
    await ui.waitFor(`!document.querySelector('dialog:modal') && ${activeText('连接服务器')}`);
    await enter();
    await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="SSH服务器"]:not([disabled])')`);
  }

  await tabTo(active('[aria-label="SSH服务器"]'), '服务器');
  await type('127.0.0.1');
  await tabTo(active('[aria-label="SSH用户名"]'), '用户名');
  await type('synthetic');
  await tabTo(activeText('高级连接设置'), '高级设置');
  await enter();
  await tabTo(active('[aria-label="SSH端口"]'), '端口');
  await key('a', 'KeyA', 65, { modifiers: 2 });
  await type(String(server.port));
  await tabTo(activeText('连接'), '连接按钮');
  await enter();
  await ui.waitFor(`!!document.querySelector('[aria-label="快速连接核对指纹"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('dialog:modal .fingerprint').textContent`), server.pin);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').checked`), false);
  assert.equal((await metrics()).attempts, 0);
  await tabTo(active('[aria-label="快速连接核对指纹"]'), '核对指纹');
  await key(' ', 'Space', 32, { text: ' ' });
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="快速连接核对指纹"]').checked`), true);
  await tabTo(activeText('信任并继续登录'), '信任按钮');
  await enter();
  await ui.waitFor(`${active('[aria-label="SSH登录密码"]')} && !document.activeElement.disabled`);
  if (authRecovery) evidence = await verifyRecovery(server, keyboard, page);
  else {
    await type(server.password);
    await enter();
    await ui.waitFor(`!document.querySelector('dialog:modal') && ${active(terminal)}`);
    const [connection, ...others] = await ui.invoke('service_list');
    assert.deepEqual(others, []);
    assert.equal(connection.protocol, 'SSH2');
    assert.equal(connection.state, 'CONNECTED');

    const sentinel = 't22-keyboard';
    await type(sentinel);
    await enter();
    const expected = Buffer.from(sentinel + '\r');
    let wire;
    for (let attempt = 0; attempt < 100; attempt++) {
      wire = await metrics();
      if (wire.received.flat().length >= expected.length) break;
      await delay(30);
    }
    assert.deepEqual(Buffer.from(wire.received.flat()), expected);
    assert.equal(wire.accepted_connections, 1);
    assert.equal(wire.attempts, 1);

    // The existing terminal search shortcut takes focus out without sending a Tab to SSH.
    await key('F', 'KeyF', 70, { modifiers: 10 });
    await ui.waitFor(active('[aria-label="终端查找文字"]'));
    await tabTo(active(`[aria-label="关闭标签 ${connection.connection_id}"]`), '关闭原连接标签');
    await enter();
    for (let attempt = 0; attempt < 100; attempt++) {
      const list = await ui.invoke('service_list');
      if (list.some(item => item.connection_id === connection.connection_id
        && item.generation === connection.generation && item.state === 'DISCONNECTED')) break;
      if (attempt === 99) throw new Error('Original SSH2 connection did not disconnect');
      await delay(30);
    }
    const connectionTab = `[role="tab"][data-connection-id="${connection.connection_id}"]`;
    await ui.waitFor(`!document.querySelector(${JSON.stringify(connectionTab)})`);
    assert.deepEqual((await page()).profiles, []);
    const final = await metrics();
    assert.deepEqual(Buffer.from(final.received.flat()), expected);
    assert.equal(final.attempts, 1);
    assert.equal(final.accepted_connections, 1);
    evidence = {
      result: 'PASS', preview: preview.directory, connection: { id: connection.connection_id, generation: connection.generation },
      restoredFocusOnEscape: true, disconnected: true, peerBytes: expected.length,
      peerConnections: final.accepted_connections, authenticationAttempts: final.attempts, focusTrace,
    };
  }
} catch (error) {
  console.error('P12.1 owned keyboard root retained:', root);
  console.error(JSON.stringify({ focusTrace }));
  throw error;
} finally {
  try { await ui?.close(); } finally {
    if (!peerError) {
      if (peer.exitCode === null && peer.signalCode === null) peer.kill();
      await ended;
    }
  }
}
const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(authRecovery ? 'PASS ordinary Desktop SSH2 keyboard-only temporary password rejection and recovery'
  : 'PASS ordinary Desktop direct SSH2 keyboard-only connection, input and disconnect');
