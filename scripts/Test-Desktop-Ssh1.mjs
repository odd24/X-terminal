import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { active, desktopKeyboard, terminalInput } from './lib/DesktopKeyboard.mjs';
import { observeDesktopSsh1Sizes, verifyDesktopSsh1Resize } from './lib/DesktopSsh1Resize.mjs';

const [fixture, source, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === '--resize');
const resizeOnly = mode === '--resize';
assert.match(fixture, /^\/tmp\/P04-ssh1\.[A-Za-z0-9]{8}$/);
assert.ok(source && path.isAbsolute(source));
const manifest = JSON.parse(await readFile('artifacts/P13-ssh1-preview.json', 'utf8'));
assert.equal(manifest.result, 'PASS');
assert.equal(path.dirname(path.resolve(manifest.directory)), path.resolve('artifacts'));
assert.deepEqual(manifest.files.map(file => file.name).sort(), [
  'session-service.exe', 'shared-terminal-desktop.exe', 'ssh1-helper.exe', 'terminal-mcp.exe',
]);
for (const file of manifest.files) {
  const data = await readFile(path.join(manifest.directory, file.name));
  assert.equal(data.length, file.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256);
}
const wsl = ['-d', 'Ubuntu-24.04', '--cd', fixture, '--exec'];
if (resizeOnly) {
  const verify = execFileSync('wsl.exe', [...wsl, '/usr/bin/sha256sum', './out/uppity', './p04-pty-size'], {
    windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.deepEqual(verify.trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]), [
    '8334402b83169bf9a41c6ec93ccc17dff4c51ac7ede8c9d414f05924bc407ce3',
    '7b47b103bcd9340f4b3075af05e9882574b43f4c2cf1b88154c78767cd3d230f',
  ]);
}
const publicKey = execFileSync('wsl.exe', [...wsl, '/bin/cat', 'public-key.txt'], {
  windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
});
const key = /^2048 (\d+) (\d+) [^\r\n]+\r?\n?$/.exec(publicKey);
assert.ok(key, 'public RSA1 key required');
const fingerprint = 'SHA256:' + createHash('sha256')
  .update(`0x${BigInt(key[1]).toString(16)},0x${BigInt(key[2]).toString(16)}`)
  .digest('base64').replace(/=+$/, '');

async function typeFixturePassword(keyboard) {
  const sourceBytes = await readFile(source);
  try {
    const declaration = Buffer.from('const char *PHONY_GOOD_PASSWORD = "');
    const offset = sourceBytes.indexOf(declaration);
    assert.ok(offset >= 0 && sourceBytes.indexOf(declaration, offset + declaration.length) < 0);
    const start = offset + declaration.length;
    const end = sourceBytes.indexOf('";', start);
    assert.ok(end > start && end - start <= 63 && sourceBytes.subarray(start, end).every(byte => byte >= 97 && byte <= 122));
    await keyboard.type(sourceBytes.toString('ascii', start, end));
  } finally { sourceBytes.fill(0); }
}

const peers = [];
async function listen() {
  const peer = { accepted: 0, wire: '' };
  const server = createServer(socket => {
    if (peer.accepted || socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1') {
      socket.destroy();
      return;
    }
    peer.socket = socket;
    peer.accepted++;
    server.close();
    const child = spawn('wsl.exe', [...wsl, '/usr/bin/timeout', '--kill-after=1s', '12s',
      '/usr/bin/unshare', '--user', '--map-current-user', '--net', '/usr/bin/env', '-i',
      `HOME=${fixture}/home`, `XDG_CONFIG_HOME=${fixture}/home`, 'PATH=/usr/bin:/bin', 'SHELL=/bin/sh',
      ...(resizeOnly ? ['/bin/bash', '-c',
        'exec "$@" 2> >(/usr/bin/grep -aE --line-buffered "^conn#[0-9]+: (P04 SSH1_CMSG_WINDOW_SIZE [0-9]{1,10} [0-9]{1,10} [0-9]{1,10} [0-9]{1,10}|Client sent exit confirmation)$" >&2)',
        'filtered-fixture'] : []),
      './out/uppity', ...(resizeOnly ? ['--verbose'] : []),
      '--hostkey', 'fixture.rsa1', '--sessiondir', fixture, '--allow-auth', 'password',
      ...['none', 'publickey', 'kbdint', 'tis', 'cryptocard'].flatMap(method => ['--deny-auth', method]),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', resizeOnly ? 'pipe' : 'ignore'] });
    child.stderr?.on('data', chunk => {
      if (peer.wire.length < 4096) peer.wire += chunk.toString('utf8').replaceAll('\0', '');
    });
    peer.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    peer.done.catch(() => socket.destroy());
    child.stdin.on('error', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  peer.server = server;
  peer.port = server.address().port;
  peers.push(peer);
  return peer;
}

const prefix = 'shared-terminal-ssh1-preview-中文-';
const data = await mkdtemp(path.join(tmpdir(), prefix));
let ui;
let observation;
const exists = selector => `!!document.querySelector(${JSON.stringify(selector)})`;
const el = selector => `document.querySelector(${JSON.stringify(selector)})`;
const dialog = 'dialog[aria-label="连接 SSH1 保存配置"]';
const consent = '[aria-label="本次允许使用 SSH1"]';
const hostConsent = '[aria-label="已核对 SSH1 主机指纹"]';
const password = '[aria-label="SSH1 登录密码"]';
const rendered = ref => `.terminal-pane[data-active="true"][data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
const createRef = ({ connection_id, generation }) => ({ connection_id, generation });

async function run() {
  const positive = await listen(), negative = resizeOnly ? undefined : await listen();
  const executable = path.join(manifest.directory, 'shared-terminal-desktop.exe');
  ui = await launchDesktop(data, { executable });
  const status = await ui.invoke('service_status');
  assert.equal(status.fixture, false);
  assert.equal(status.ssh1_preview, true);
  await ui.command('Page.bringToFront');
  const keyboard = desktopKeyboard(ui, []);
  const list = () => ui.invoke('service_list');
  const configuration = request => ui.invoke('config_request', { request });
  const log = request => ui.invoke('logging_request', { request });
  const click = selector => ui.evaluate(`${el(selector)}?.click()`);
  const findProfile = name => configuration({ op: 'page', revision: null, folders: false, offset: 0 })
    .then(reply => reply.profiles.find(profile => profile.name === name));
  await click('.tools-menu summary');
  await ui.click('连接配置');
  await ui.waitFor(`${el('[aria-label="配置状态"]')}?.textContent==='配置已加载'`);
  const name = '旧协议本机预览';
  await ui.fill('配置名称', name);
  await ui.fill('协议', 'ssh1');
  await ui.fill('主机', '127.0.0.1');
  await ui.fill('端口', positive.port);
  await ui.fill('用户名', 'p13-fixture');
  assert.equal(await ui.evaluate(`${el('[aria-label="显式开启SSH1"]')}.checked`), false);
  assert.equal(await ui.evaluate(`${el('[aria-label="凭据操作"] option[value="replace"]')}.disabled`), true);
  await click('[aria-label="显式开启SSH1"]');
  await ui.click('保存配置');
  await ui.waitFor(`${el('[aria-label="配置状态"]')}?.textContent.includes('配置已保存')`);
  const saved = await findProfile(name);
  assert.equal(saved.settings.explicitly_enabled, true);
  assert.equal(saved.credential_ref, null);
  await ui.click('关闭配置');
  let rejectedProfile;
  if (negative) {
    rejectedProfile = { id: randomUUID(), folder_id: null, name: 'SSH1 拒绝夹具',
      settings: { ...saved.settings, port: negative.port } };
    const savedRejection = await configuration({
      op: 'save_profile', profile: rejectedProfile, credential: { action: 'clear' },
    });
    assert.equal(savedRejection.result, 'saved_profile');
  }
  assert.deepEqual(await list(), []);
  assert.equal(positive.accepted + (negative?.accepted ?? 0), 0);
  if (await ui.evaluate(`${el('.app-bar button')}.getAttribute('aria-expanded')==='false'`)) await ui.click('会话导航');
  await ui.click('刷新会话树');

  async function chooseSaved(profile, peer) {
    const row = `.session-tree-list button[data-profile-id="${profile.id}"]`;
    await ui.waitFor(exists(row));
    assert.match(await ui.evaluate(`${el(row)}.textContent`), /SSH1/);
    await click(row);
    await ui.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='连接选中配置'&&!b.disabled)`);
    await ui.click('连接选中配置');
    await ui.waitFor(exists(dialog));
    assert.match(await ui.evaluate(`${el(dialog)}.textContent`), /可能不安全的旧协议/);
    assert.equal(await ui.evaluate(`${el(consent)}.checked`), false);
    assert.equal(await ui.evaluate(`[...${el(dialog)}.querySelectorAll('button')].find(b=>b.textContent==='连接此 SSH1 配置').disabled`), true);
    assert.equal(peer.accepted, 0);
    await click(consent);
  }

  async function openSaved(profile, peer, loseStartReply = false) {
    await chooseSaved(profile, peer);
    const before = await list();
    const hook = loseStartReply ? await ui.interceptIpc({ command: 'ssh_request', op: 'start_fixed', mode: 'error' }) : undefined;
    try {
      await ui.click('连接此 SSH1 配置');
      if (hook) {
        await ui.waitFor(`[...${el(dialog)}.querySelectorAll('button')].some(b=>b.textContent==='仅查询原 SSH1 编号')`);
        assert.equal(await hook.count(), 1);
        await ui.click('仅查询原 SSH1 编号');
      }
    } finally { await hook?.restore(); }
    await ui.waitFor(exists(hostConsent));
    assert.equal(peer.accepted, 1);
    assert.equal(await ui.evaluate(`${el(dialog + ' .fingerprint')}.textContent`), fingerprint);
    assert.equal(await ui.evaluate(`${el(hostConsent)}.checked`), false);
    const matches = (await list()).filter(connection => !before.some(old => old.connection_id === connection.connection_id));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].protocol, 'SSH1');
    const ref = createRef(matches[0]);
    assert.match(await ui.evaluate(`${el('[aria-label="SSH1 连接身份"]')}.textContent`), new RegExp(`代次 ${ref.generation}`));
    const current = await ui.invoke('ssh_request', { request: { op: 'status', connection: ref } });
    assert.equal(current.profile_id, profile.id);
    return ref;
  }

  if (resizeOnly) observation = await observeDesktopSsh1Sizes(ui);
  const ref = await openSaved(saved, positive, !resizeOnly);
  await click(hostConsent);
  await ui.click('信任 SSH1 主机并继续');
  await ui.waitFor(`${active(password)} && !document.activeElement.disabled`);
  await typeFixturePassword(keyboard);
  await keyboard.enter();
  await ui.waitFor(`!(${exists(dialog)}) && ${active(`${rendered(ref)} ${terminalInput}`)}`);
  const tab = `[role="tab"][data-connection-id="${ref.connection_id}"]`;
  assert.match(await ui.evaluate(`${el(tab)}.textContent`), /SSH1.*127\.0\.0\.1/);
  if (resizeOnly) {
    await verifyDesktopSsh1Resize({ ui, keyboard, ref, executable, peer: positive, servicePid: status.pid,
      preview: manifest.directory, terminal: `${rendered(ref)} ${terminalInput}`, observation });
    return;
  }
  await ui.click('终端日志');
  await ui.waitFor(`${el('[aria-label="日志目标"]')}?.textContent.includes('SSH1')`);
  await ui.click('开始记录终端');
  for (let i = 0; i < 100 && !(await log({ op: 'list', connection: ref })).logs.some(entry => entry.phase === 'RECORDING'); i++) await delay(40);
  const recording = (await log({ op: 'list', connection: ref })).logs[0];
  assert.equal(recording?.protocol, 'SSH1');
  assert.equal(recording.phase, 'RECORDING');
  await ui.click('关闭日志面板');
  await ui.evaluate(`${el(`${rendered(ref)} ${terminalInput}`)}.focus()`);
  await ui.command('Input.insertText', { text: "test -t 0 && test -t 1 && printf '\\nP13_DESKTOP_OK\\n'" });
  await keyboard.enter();
  const marker = '\r\nP13_DESKTOP_OK\r\n';
  let received = false;
  for (let i = 0; i < 100 && !received; i++) {
    const page = await ui.invoke('service_read', { connection: ref, cursor: 1 });
    received = Buffer.from(page.events.flatMap(event => event.bytes)).includes(marker);
    if (!received) await delay(35);
  }
  assert.ok(received, 'real SSH1 application output');
  let painted = false;
  for (let i = 0; i < 30 && !painted; i++) {
    if (await ui.evaluate(`!${el('.diagnostic-menu')}.open`)) await click('.diagnostic-menu summary');
    await ui.click('屏幕快照');
    painted = await ui.evaluate(`${el('[aria-label="屏幕快照"]')}?.textContent.split('\\n').some(line=>line.trim()==='P13_DESKTOP_OK')`);
    if (!painted) await delay(40);
  }
  assert.ok(painted, 'actual Desktop terminal snapshot contains received marker');
  await ui.click('关闭屏幕快照');
  await ui.click('终端日志');
  await ui.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='停止记录终端'&&!b.disabled)`);
  await ui.click('停止记录终端');
  let stopped;
  for (let i = 0; i < 100; i++) {
    stopped = (await log({ op: 'list', connection: ref })).logs.find(entry => entry.log_id === recording.log_id);
    if (stopped?.durable && stopped.worker_finished) break;
    await delay(35);
  }
  assert.ok(stopped?.durable && stopped.worker_finished && stopped.written_raw_bytes > 0);
  await ui.click('关闭日志面板');
  await click(`[aria-label="关闭标签 ${ref.connection_id}"]`);
  await ui.waitFor(`!(${exists(tab)})`);

  // The accepted trust update also advances the shared configuration revision.
  const beforeStale = await list();
  await chooseSaved(rejectedProfile, negative);
  await ui.click('连接此 SSH1 配置');
  await ui.waitFor(`${el(dialog + ' [role="alert"]')}?.textContent.includes('刷新会话树')`);
  assert.equal(negative.accepted, 0);
  assert.deepEqual(await list(), beforeStale);
  await ui.click('关闭 SSH1 连接窗口');
  await ui.click('刷新会话树');
  const refused = await openSaved(rejectedProfile, negative);
  await ui.click('拒绝 SSH1 主机');
  await ui.waitFor(`${el(dialog + ' [role="alert"]')}?.textContent.includes('本次未提交密码')`);
  assert.equal(await ui.evaluate(exists(password)), false);
  const refusal = await ui.invoke('ssh_request', { request: { op: 'status', connection: refused } });
  assert.equal(refusal.failure, 'HOST_KEY_REJECTED');
  await ui.click('关闭 SSH1 连接窗口');
  const exits = await Promise.all(peers.map(peer => peer.done));
  assert.ok(exits.every(exit => exit.signal === null && [0, 124].includes(exit.code)));
  assert.equal(execFileSync('pwsh', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${status.pid} AND Name='ssh1-helper.exe'").Count`],
    { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim(), '0');
  const evidence = { result: 'PASS', preview: manifest.directory, approvedThenPty: true, staleRevisionRejected: true, rejectedBeforePassword: true,
    logProtocol: stopped.protocol, logDurable: stopped.durable, fixtureExit: exits.map(exit => exit.code) };
  await writeFile('artifacts/P13-desktop-ssh1.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS SSH1 saved-profile Desktop preview, native UI approval and PTY, log and close');
}

try { await run(); }
finally {
  try {
    try { await observation?.restore(); }
    finally { await ui?.close(); }
  }
  finally {
    for (const peer of peers) {
      peer.socket?.destroy();
      if (peer.server.listening) peer.server.close();
      await peer.done?.catch(() => {});
    }
    assert.equal(path.dirname(data), path.resolve(tmpdir()));
    assert.ok(path.basename(data).startsWith(prefix));
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
