import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard, terminalInput } from './lib/DesktopKeyboard.mjs';

const preview = JSON.parse(await readFile('artifacts/P12-compact-config-dpi-preview.json', 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(sha256(bytes), file.sha256);
}

const prefix = 'shared-terminal-basic-log-keyboard-中文-';
const artifact = 'P11.4-basic-log-keyboard';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const peer = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [root], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => {
  peer.once('exit', resolve);
  peer.once('error', resolve);
});
const lines = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
const focusTrace = [];
let ui, evidence;

async function nextReply() {
  let timer;
  try {
    const item = await Promise.race([lines.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SSH fixture reply timed out')), 10000);
    })]);
    assert.equal(item.done, false);
    return JSON.parse(item.value);
  } finally { clearTimeout(timer); }
}
async function peerControl(request) {
  peer.stdin.write(JSON.stringify(request) + '\n');
  return nextReply();
}
async function poll(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const server = await nextReply();
  ui = await launchDesktop(root, { executable: path.join(preview.directory, 'shared-terminal-desktop.exe') });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const { key, type, enter, tabTo, recordFocus } = desktopKeyboard(ui, focusTrace);

  // Prepare one loopback SSH session via the established keyboard path.
  await tabTo(activeText('连接服务器'), '夹具准备：打开连接');
  await enter();
  await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="SSH服务器"]:not([disabled])')`);
  await tabTo(active('[aria-label="SSH服务器"]'), '夹具地址');
  await type('127.0.0.1');
  await tabTo(active('[aria-label="SSH用户名"]'), '夹具用户名');
  await type('synthetic');
  await tabTo(activeText('高级连接设置'), '夹具高级设置');
  await enter();
  await tabTo(active('[aria-label="SSH端口"]'), '夹具端口');
  await key('a', 'KeyA', 65, { modifiers: 2 });
  await type(String(server.port));
  await tabTo(activeText('连接'), '连接夹具');
  await enter();
  await ui.waitFor(`!!document.querySelector('[aria-label="快速连接核对指纹"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('dialog:modal .fingerprint').textContent`), server.pin);
  await tabTo(active('[aria-label="快速连接核对指纹"]'), '核对夹具指纹');
  await key(' ', 'Space', 32, { text: ' ' });
  await tabTo(activeText('信任并继续登录'), '信任夹具');
  await enter();
  await ui.waitFor(`${active('[aria-label="SSH登录密码"]')} && !document.activeElement.disabled`);
  await type(server.password);
  await enter();
  await ui.waitFor(`!document.querySelector('dialog:modal') && ${active(terminalInput)}`);
  const [connection, ...others] = await ui.invoke('service_list');
  assert.deepEqual(others, []);
  assert.equal(connection?.protocol, 'SSH2');
  assert.equal(connection.state, 'CONNECTED');
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  const pane = `.terminal-pane[data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
  await ui.waitFor(`${active(`${pane} ${terminalInput}`)} && document.querySelector(${JSON.stringify(`${pane} .xterm-rows`)})?.textContent.includes('service-shared-shell')`);
  const logging = request => ui.invoke('logging_request', { request: { ...request, connection: ref } });
  assert.deepEqual((await logging({ op: 'list' })).logs, []);

  // The acceptance path starts here. Fixture output is injected from the peer,
  // while user actions use keys and test IPC only reads receipts.
  await recordFocus('原连接终端已聚焦');
  await key('F', 'KeyF', 70, { modifiers: 10 });
  await ui.waitFor(active('[aria-label="终端查找文字"]'));
  await recordFocus('查找快捷键移出终端');
  async function focusButton(label, options) {
    await tabTo(`(${activeText(label)}) && !document.activeElement.matches(':disabled')`, label, options);
    assert.ok(await ui.evaluate(`(() => {
      const b=document.activeElement, r=b.getBoundingClientRect(), s=getComputedStyle(b);
      return b.matches(':focus-visible') && s.outlineStyle==='solid' && parseFloat(s.outlineWidth)>0
        && b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
    })()`), `Visible keyboard focus on ${label}`);
    await recordFocus(`已聚焦 ${label}`);
  }
  await focusButton('终端日志');
  await enter();
  const target = `目标 SSH2 · ${ref.connection_id} / ${ref.generation}`;
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="日志目标"]').textContent`), target);
  // The auxiliary panel follows xterm in DOM order. Walk backward around the
  // workspace instead of pressing another Tab while the terminal owns focus.
  await focusButton('开始记录终端', { backward: true });
  await enter();
  const log = await poll(async () => {
    const { logs } = await logging({ op: 'list' });
    assert.ok(logs.length <= 1);
    return logs[0]?.phase === 'RECORDING' && logs[0];
  }, 'original recording');
  assert.deepEqual(log.connection, ref);
  const marker = 'T22 键盘日志标记\n精确第二行\n';
  await peerControl({ op: 'push', text: marker });
  const status = () => logging({ op: 'status', log_id: log.log_id });
  await poll(async () => (await status()).written_raw_bytes === Buffer.byteLength(marker), 'marker written');

  await focusButton('停止记录终端');
  await enter();
  const stopped = await poll(async () => {
    const state = await status();
    return state.phase === 'STOPPED' && state.durable && state.worker_finished && state;
  }, 'stopped, durable recording');
  assert.deepEqual(stopped.connection, ref);
  assert.equal(stopped.log_id, log.log_id);
  assert.equal(stopped.failure, null);
  assert.equal(stopped.source_gap_bytes, 0);
  assert.equal(stopped.rejected_records, 0);
  assert.equal(stopped.written_raw_bytes, Buffer.byteLength(marker));
  assert.equal(stopped.readable.synced_records, stopped.written_records);
  assert.equal(stopped.readable.synced_bytes, stopped.readable.written_bytes);

  const view = '[aria-label="本次日志文本"]';
  await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='查看日志'&&!b.disabled)`);
  await focusButton('查看日志');
  await enter();
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(view)})`);
  const viewed = await ui.evaluate(`document.querySelector(${JSON.stringify(view)}).textContent`);
  assert.equal(viewed, marker);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="日志目标"]').textContent`), target);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="日志记录"]').value`), log.log_id);
  assert.match(await ui.evaluate(`document.querySelector('[aria-label="基础日志状态"]').textContent`), /保留窗口同步完成/);

  const { filename } = stopped.readable;
  assert.match(filename, /^127\.0\.0\.1_[\d_\-]+\.log$/);
  const logs = await realpath(path.join(root, 'logs'));
  assert.equal(path.dirname(logs), await realpath(root));
  const file = await realpath(path.join(logs, filename));
  assert.equal(path.dirname(file), logs);
  const managed = await readFile(file);
  const header = `# 终端通信日志 UTF-8\r\n# 日志 ${log.log_id}；连接 ${ref.connection_id} / ${ref.generation}\r\n`
    + '# 仅起录后的接收输出/终端回显；不含认证表单，未独立记录发送；起录前内容未记录。\r\n';
  assert.deepEqual(managed, Buffer.from(header + marker));
  assert.equal(managed.length, stopped.readable.synced_bytes);
  assert.ok(!viewed.includes(server.password) && !managed.includes(Buffer.from(server.password)));
  const metrics = await peerControl({ op: 'metrics' });
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.accepted_connections, 1);
  assert.deepEqual(metrics.received, []);
  evidence = { result: 'PASS', preview: preview.directory, connection: ref, logId: log.log_id, filename,
    phase: stopped.phase, durable: stopped.durable, markerBytes: Buffer.byteLength(marker), fileBytes: managed.length,
    sha256: sha256(managed), focusTrace };
} catch (error) {
  await ui?.screenshot(`${artifact}-failure.png`).catch(() => {});
  await writeFile(`artifacts/${artifact}-failure.json`, JSON.stringify({ result: 'FAIL', error: error.message, focusTrace }, null, 2) + '\n');
  console.error('Owned logging test root retained:', root);
  throw error;
} finally {
  try { await ui?.close(); } finally {
    if (peer.pid && peer.exitCode === null && peer.signalCode === null) peer.kill();
    await exited;
  }
}

const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log('PASS basic log keyboard start, synchronized stop and exact view on an ordinary SSH preview');
