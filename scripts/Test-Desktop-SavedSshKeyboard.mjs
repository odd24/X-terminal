import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard, terminalInput } from './lib/DesktopKeyboard.mjs';

const previewOverride = process.argv[2];
const manifest = previewOverride ?? 'artifacts/P22-audit-grant-feedback-preview.json';
const report = previewOverride ? `P12.1-saved-ssh-keyboard-${path.parse(manifest).name}.json` : 'P12.1-saved-ssh-keyboard.json';
const preview = JSON.parse(await readFile(manifest, 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}

const prefix = 'shared-terminal-saved-ssh-keyboard-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const peers = [];
const focusTrace = [];
let ui, evidence;

async function startPeer(label) {
  const directory = path.join(root, label);
  await mkdir(directory);
  const process = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [directory], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => {
    process.once('exit', resolve);
    process.once('error', resolve);
  });
  peers.push({ process, exited });
  const lines = createInterface({ input: process.stdout })[Symbol.asyncIterator]();
  async function next() {
    let timer;
    try {
      const reply = await Promise.race([lines.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SSH fixture ${label} reply timed out`)), 10000);
      })]);
      assert.equal(reply.done, false, `SSH fixture ${label} exited before its reply`);
      return JSON.parse(reply.value);
    } finally { clearTimeout(timer); }
  }
  const server = await next();
  return { ...server, async metrics() { process.stdin.write('{"op":"metrics"}\n'); return next(); } };
}

const pinCheck = '[aria-label="快速连接核对指纹"]';
const password = '[aria-label="SSH登录密码"]';
const find = '[aria-label="终端查找文字"]';
const toolsClosed = 'document.querySelector(".tools-menu").open === false';
const tab = ref => `[role="tab"][data-connection-id="${ref.connection_id}"]`;
const selectedTab = ref => `${tab(ref)}[aria-selected="true"]`;
const closeButton = ref => `[aria-label="关闭标签 ${ref.connection_id}"]`;
const rendered = ref => `.terminal-pane[data-active="true"][data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
const exists = selector => `!!document.querySelector(${JSON.stringify(selector)})`;
const connectionRef = ({ connection_id, generation }) => ({ connection_id, generation });

try {
  const a = await startPeer('a');
  const b = await startPeer('b');
  assert.notEqual(a.port, b.port);
  assert.notEqual(a.pin, b.pin);
  ui = await launchDesktop(root, { executable: path.join(preview.directory, 'shared-terminal-desktop.exe') });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const config = request => ui.invoke('config_request', { request });
  const page = () => config({ op: 'page', revision: null, offset: 0, folders: false });
  const list = () => ui.invoke('service_list');
  assert.deepEqual((await page()).profiles, []);
  assert.deepEqual(await list(), []);

  // Setup only. From the first workspace key onward all service IPC is read-only.
  for (const [peer, name, host] of [[a, '键盘配置 A', '127.0.0.1'], [b, '键盘配置 B', 'localhost']]) {
    const profile = { id: crypto.randomUUID(), folder_id: null, name, settings: {
      protocol: 'ssh2', host, port: peer.port, username: 'synthetic', auth: 'password', encoding: 'utf8',
    } };
    const saved = await config({ op: 'save_profile', profile, credential: { action: 'clear' } });
    assert.equal(saved.result, 'saved_profile');
    assert.equal(saved.profile.credential_ref, null);
    peer.profile = profile;
  }

  const { key, type, enter, tabTo, recordFocus } = desktopKeyboard(ui, focusTrace);
  async function leaveTerminal(firstTab) {
    assert.ok(await ui.evaluate(active(terminalInput)));
    assert.ok(await ui.evaluate(toolsClosed), 'search shortcut starts with the tools menu closed');
    await key('F', 'KeyF', 70, { modifiers: 10 });
    await ui.waitFor(active(find));
    await recordFocus('查找快捷键移出终端');
    await key('Escape', 'Escape', 27);
    await ui.waitFor(`!(${exists(find)})`);
    await recordFocus('关闭查找后焦点');
    assert.ok(await ui.evaluate(active('.tools-menu > summary')), 'Escape restores focus to the visible tools summary');
    assert.ok(await ui.evaluate(toolsClosed), 'Escape leaves the tools menu closed');
    await tabTo(active(closeButton(firstTab)), '从查找返回标签区');
  }

  async function connect(peer) {
    const leaf = `.session-tree-list button[data-profile-id="${peer.profile.id}"]`;
    const before = await list();
    await ui.waitFor(exists(leaf));
    await tabTo(active(leaf), peer.profile.name, { backward: before.length > 0 });
    await enter();
    await ui.waitFor(exists(`${leaf}[aria-pressed="true"]`));
    assert.deepEqual((await list()).map(connectionRef), before.map(connectionRef));
    await tabTo(activeText('连接选中配置'), `连接 ${peer.profile.name}`);
    await enter();
    await ui.waitFor(exists(pinCheck));
    assert.equal(await ui.evaluate(`document.querySelector('dialog:modal .fingerprint').textContent`), peer.pin);
    assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(pinCheck)}).checked`), false);
    assert.equal((await peer.metrics()).attempts, 0);
    await tabTo(active(pinCheck), `指纹 ${peer.profile.name}`);
    await key(' ', 'Space', 32, { text: ' ' });
    await tabTo(activeText('信任并继续登录'), `信任 ${peer.profile.name}`);
    await enter();
    await ui.waitFor(`${active(password)} && !document.activeElement.disabled`);
    await recordFocus(`临时密码 ${peer.profile.name}`);
    await type(peer.password);
    await enter();
    await ui.waitFor(`!document.querySelector('dialog:modal') && ${active(terminalInput)}`);
    const all = await list();
    assert.equal(all.length, before.length + 1);
    const connection = all.find(item => !before.some(old => old.connection_id === item.connection_id));
    assert.equal(connection?.protocol, 'SSH2');
    assert.equal(connection.state, 'CONNECTED');
    const status = await ui.invoke('ssh_request', { request: { op: 'status', connection: connectionRef(connection) } });
    assert.equal(status.profile_id, peer.profile.id);
    await ui.waitFor(`${exists(selectedTab(connection))} && ${active(`${rendered(connection)} ${terminalInput}`)}`);
    assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(selectedTab(connection))}).textContent.trim()`), peer.profile.settings.host);
    await recordFocus(`连接后终端 ${peer.profile.name}`);
    return connection;
  }

  async function comesBefore(selector) {
    return ui.evaluate(`Boolean(document.activeElement.compareDocumentPosition(document.querySelector(${JSON.stringify(selector)})) & Node.DOCUMENT_POSITION_PRECEDING)`);
  }

  async function switchTo(from, to, anchor) {
    await leaveTerminal(anchor);
    await tabTo(active(selectedTab(from)), `切换前标签 ${from.connection_id}`, { backward: await comesBefore(selectedTab(from)) });
    const direction = await comesBefore(tab(to)) ? 'Left' : 'Right';
    await key(`Arrow${direction}`, `Arrow${direction}`, direction === 'Left' ? 37 : 39);
    await ui.waitFor(active(selectedTab(to)));
    assert.ok(await ui.evaluate(`document.activeElement.matches(':focus-visible')`));
    await recordFocus(`切换后标签 ${to.connection_id}`);
    await ui.waitFor(exists(rendered(to)));
    await tabTo(active(terminalInput), `切换后终端 ${to.connection_id}`);
    assert.ok(await ui.evaluate(`${exists(selectedTab(to))} && ${active(`${rendered(to)} ${terminalInput}`)}`));
  }

  async function exactWire(peer, sentinel) {
    const expected = Buffer.from(sentinel + '\r');
    let wire;
    for (let attempt = 0; attempt < 100; attempt++) {
      wire = await peer.metrics();
      if (wire.received.flat().length >= expected.length) break;
      await delay(30);
    }
    assert.deepEqual(Buffer.from(wire.received.flat()), expected);
    assert.equal(wire.accepted_connections, 1);
    assert.equal(wire.attempts, 1);
    return expected.length;
  }

  async function closeTarget(target, remaining) {
    await tabTo(active(closeButton(target)), `关闭标签 ${target.connection_id}`, { backward: await comesBefore(closeButton(target)) });
    await enter();
    await ui.waitFor(`!(${exists(tab(target))})`);
    let all, ended;
    for (let attempt = 0; attempt < 100; attempt++) {
      all = await list();
      ended = all.find(item => item.connection_id === target.connection_id);
      if (ended?.state === 'DISCONNECTED') break;
      await delay(30);
    }
    assert.deepEqual(connectionRef(ended), connectionRef(target));
    assert.equal(ended.state, 'DISCONNECTED');
    if (remaining) {
      const survivor = all.find(item => item.connection_id === remaining.connection_id);
      assert.deepEqual(connectionRef(survivor), connectionRef(remaining));
      assert.equal(survivor.state, 'CONNECTED');
      await ui.waitFor(exists(selectedTab(remaining)));
    }
  }

  await tabTo(activeText('会话导航'), '工作区会话导航');
  await enter();
  await tabTo(active('[aria-label="刷新会话树"]'), '加载预置的配置');
  await enter();
  const first = await connect(a);
  await leaveTerminal(first);
  const second = await connect(b);
  assert.equal((await a.metrics()).received.length, 0);
  assert.equal((await b.metrics()).received.length, 0);

  await switchTo(second, first, first);
  await type('t22-saved-a');
  await enter();
  await exactWire(a, 't22-saved-a');
  assert.equal((await b.metrics()).received.length, 0);

  await switchTo(first, second, first);
  await type('t22-saved-b');
  await enter();
  await exactWire(b, 't22-saved-b');

  await leaveTerminal(first);
  await closeTarget(second, first);
  await tabTo(active(terminalInput), '关闭首条后回到剩余终端');
  await leaveTerminal(first);
  await closeTarget(first);
  assert.deepEqual((await page()).profiles.map(profile => [profile.id, profile.credential_ref]).sort(),
    [[a.profile.id, null], [b.profile.id, null]].sort());
  const bytesA = await exactWire(a, 't22-saved-a');
  const bytesB = await exactWire(b, 't22-saved-b');
  evidence = { result: 'PASS', preview: preview.directory, setup: 'two credential-free synthetic profiles',
    connections: [[a, first, bytesA], [b, second, bytesB]].map(([peer, connection, bytes]) => ({
      ...connectionRef(connection), profileId: peer.profile.id, port: peer.port, peerBytes: bytes,
      peerConnections: 1, authenticationAttempts: 1, disconnected: true,
    })), focusTrace };
} catch (error) {
  console.error('P12.1 owned saved keyboard root retained:', root);
  console.error(JSON.stringify({ focusTrace }));
  throw error;
} finally {
  try { await ui?.close(); } finally {
    for (const { process, exited } of peers) {
      if (process.pid && process.exitCode === null && process.signalCode === null) process.kill();
      await exited;
    }
  }
}

const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile(path.join('artifacts', report), JSON.stringify(evidence, null, 2) + '\n');
console.log('PASS ordinary Desktop saved SSH2 keyboard selection, switching, isolated input and disconnect');
