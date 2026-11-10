import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard, terminalInput } from './lib/DesktopKeyboard.mjs';

const preview = JSON.parse(await readFile('artifacts/P12-compact-config-dpi-preview.json', 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(digest(bytes), file.sha256);
}

const prefix = 'shared-terminal-passive-uart-keyboard-中文-';
const artifact = 'P10.1-passive-uart-keyboard';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const bin = path.join(root, '隔离副本');
const executable = path.join(bin, 'shared-terminal-desktop.exe');
const service = path.join(bin, 'session-service.exe');
const builtService = path.resolve('target/debug/session-service.exe');
const focusTrace = [];
const port = '[aria-label="UART端口"]';
const baud = '[aria-label="UART波特率"]';
const line = sequence => `UART synthetic Android启动 log ${sequence}\r\n`;
const prefixBytes = Buffer.from(line(1) + line(2));
let ui, fixtureHash, evidence;

function build(fixture) {
  const result = spawnSync('cargo', ['build', '-p', 'session-service', '--locked',
    ...(fixture ? ['--features', 'serial-ui-fixture'] : [])], { windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, fixture ? 'memory service build failed' : 'ordinary service restoration failed');
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await mkdir(bin);
  for (const name of ['shared-terminal-desktop.exe', 'terminal-mcp.exe']) {
    await copyFile(path.join(preview.directory, name), path.join(bin, name));
  }
  build(true);
  await copyFile(builtService, service);
  fixtureHash = digest(await readFile(service));
  assert.notEqual(fixtureHash, preview.files.find(file => file.name === 'session-service.exe').sha256);
  const fixtureRoot = path.join(root, '内存夹具');
  await mkdir(fixtureRoot);
  ui = await launchDesktop(fixtureRoot, { executable, fixture: true });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, true);
  const list = () => ui.invoke('service_list');
  const config = () => ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
  assert.deepEqual(await list(), []);
  assert.deepEqual((await config()).profiles, []);

  // The memory service has been explicitly selected. From here, all user
  // actions use keyboard events and the service IPC calls only read state.
  const { key, type, enter, tabTo, recordFocus } = desktopKeyboard(ui, focusTrace);
  await tabTo(activeText('串口连接'), '工作区串口入口');
  await enter();
  await ui.waitFor(`document.querySelector('${port}')?.options.length===2 && !document.querySelector('${port}').disabled`);
  assert.deepEqual(await ui.evaluate(`Array.from(document.querySelector('${port}').options, option => option.text)`),
    ['请选择端口', 'COM7 · SYNTHETIC-TEST-INSTANCE']);
  assert.equal(await ui.evaluate(`document.querySelector('${port}').value`), '');
  await tabTo(active(port), '选择唯一内存端口');
  await key('ArrowDown', 'ArrowDown', 40);
  assert.equal(await ui.evaluate('document.activeElement.selectedIndex'), 1);
  await tabTo(active(baud), '被动夹具波特率');
  await key('a', 'KeyA', 65, { modifiers: 2 });
  await type('57600');
  assert.equal(await ui.evaluate('document.activeElement.value'), '57600');
  await tabTo(activeText('通信参数与控制线'), '查看通信参数与初始控制线');
  await enter();
  const settings = await ui.evaluate(`Object.fromEntries(['数据位','停止位','校验','流控','编码','初始DTR','初始RTS'].map(name=>[
    name,document.querySelector('[aria-label="UART'+name+'"]').value]))`);
  assert.deepEqual(settings, { 数据位: '8', 停止位: '1', 校验: 'none', 流控: 'none', 编码: 'utf8', 初始DTR: 'false', 初始RTS: 'false' });
  const summary = await ui.evaluate(`document.querySelector('[aria-label="UART初始控制线"]').textContent`);
  assert.match(summary, /DTR 低电平.*RTS 低电平/);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="保存UART连接"]').checked`), false);
  await tabTo(activeText('连接串口'), '连接唯一内存端口');
  await enter();
  await ui.waitFor(`!document.querySelector('dialog:modal') && ${active(terminalInput)}`);
  const [connection, ...others] = await list();
  assert.deepEqual(others, []);
  assert.equal(connection?.protocol, 'SERIAL');
  assert.equal(connection.state, 'CONNECTED');
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  const status = () => ui.invoke('serial_request', { request: { op: 'status', connection: ref } });
  const read = () => ui.invoke('service_read', { connection: ref, cursor: 1 });
  const bytes = page => Buffer.from(page.events.flatMap(event => event.bytes));
  const connected = await status();
  assert.deepEqual(connected.connection, connection);
  assert.equal(connected.port, 'COM7');
  assert.equal(connected.encoding, 'utf8');
  assert.equal(connected.hardware_rts, false);

  const received = await waitFor(async () => {
    const page = await read();
    return bytes(page).length >= prefixBytes.length && page;
  }, 'two deterministic passive records');
  assert.deepEqual(received.connection, ref);
  assert.deepEqual(bytes(received).subarray(0, prefixBytes.length), prefixBytes);
  const rendered = `.terminal-pane[data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
  await ui.waitFor(`${active(`${rendered} ${terminalInput}`)} && document.querySelector(${JSON.stringify(`${rendered} .xterm-rows`)})?.textContent.includes('Android启动 log')`);
  await recordFocus('已呈现原连接的被动输出');
  assert.match(await ui.evaluate(`document.querySelector('[aria-label="UART连接状态"]').textContent`), /COM7.*已连接.*接收/);
  assert.equal(await ui.evaluate(`document.querySelector('.input-status output').textContent`), '尚无输入');

  // This is the terminal's built-in search shortcut. Do not send Tab to xterm.
  await key('F', 'KeyF', 70, { modifiers: 10 });
  await ui.waitFor(active('[aria-label="终端查找文字"]'));
  await recordFocus('查找快捷键移出终端');
  await tabTo(active(`[aria-label="关闭标签 ${ref.connection_id}"]`), '关闭原代次标签');
  await enter();
  const ended = await waitFor(async () => {
    const current = await status();
    return current.connection.state === 'DISCONNECTED' && !current.cleanup_pending && current;
  }, 'original UART connection to disconnect and release');
  assert.deepEqual(ended.connection, { ...connection, state: 'DISCONNECTED' });
  assert.equal(ended.port, 'COM7');
  assert.equal(ended.failure, null);
  assert.equal(ended.dropped_bytes, 0);
  await ui.waitFor(`!document.querySelector('[role="tab"][data-connection-id="${ref.connection_id}"]')`);
  assert.deepEqual(await list(), [ended.connection]);
  assert.deepEqual((await config()).profiles, []);

  const final = await read();
  const finalBytes = bytes(final);
  assert.deepEqual(final.connection, ref);
  assert.equal(final.disconnected, true);
  assert.equal(final.truncated, false);
  assert.equal(final.available_from, 1);
  assert.equal(finalBytes.length, ended.read_bytes);
  assert.deepEqual(finalBytes.subarray(0, bytes(received).length), bytes(received));
  assert.ok(final.events.length >= 2);
  for (const [index, event] of final.events.entries()) {
    assert.equal(event.seq, index + 1);
    assert.equal(event.gap_bytes, undefined);
  }
  const records = finalBytes.toString('utf8').split('\r\n').length - 1;
  const expected = Array.from({ length: records }, (_, index) => line(index + 1)).join('');
  assert.deepEqual(finalBytes, Buffer.from(expected));
  evidence = { result: 'PASS', preview: preview.directory, fixtureHash, connection: ref, port: ended.port,
    baud: 57600, settings, disconnected: true, droppedBytes: ended.dropped_bytes, records, bytes: finalBytes.length,
    sha256: digest(finalBytes), firstTwoBytes: prefixBytes.length, focusTrace };
} catch (error) {
  await ui?.screenshot(`${artifact}-failure.png`).catch(() => {});
  await writeFile(`artifacts/${artifact}-failure.json`, JSON.stringify({ result: 'FAIL', error: error.message, focusTrace }, null, 2) + '\n');
  console.error('Owned UART test root retained:', root);
  throw error;
} finally {
  try { await ui?.close(); } finally {
    build(false);
    await copyFile(builtService, service);
    const ordinaryHash = digest(await readFile(service));
    assert.notEqual(ordinaryHash, fixtureHash);
    const ordinaryRoot = path.join(root, '普通服务');
    await mkdir(ordinaryRoot);
    const ordinary = await launchDesktop(ordinaryRoot, { executable });
    try {
      assert.equal((await ordinary.invoke('service_status')).fixture, false);
      assert.deepEqual(await ordinary.invoke('service_list'), []);
    } finally { await ordinary.close(); }
    await writeFile(`artifacts/${artifact}-ordinary-restore.json`, JSON.stringify({ result: 'PASS', sha256: ordinaryHash, fixture: false }, null, 2) + '\n');
    console.log('PASS ordinary service rebuilt and independently started without a fixture or port inventory');
  }
}

const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log('PASS keyboard-only passive memory UART connection, exact receive and original-generation close');
