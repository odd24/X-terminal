import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';

const preview = JSON.parse(await readFile('artifacts/P22-audit-grant-feedback-preview.json', 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}

const prefix = 'shared-terminal-direct-ssh-keyboard-中文-';
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
const active = selector => `document.activeElement?.matches(${JSON.stringify(selector)}) && document.activeElement.getClientRects().length>0`;
const activeText = text => `document.activeElement?.textContent.trim()===${JSON.stringify(text)} && document.activeElement.getClientRects().length>0`;
const terminal = 'textarea.xterm-helper-textarea';

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
async function key(key, code, virtualKey, { modifiers = 0, text } = {}) {
  const event = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers };
  await ui.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(text ? { text, unmodifiedText: text } : {}) });
  await ui.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
async function type(text) {
  for (const character of text) {
    const code = /^[a-z]$/.test(character) ? `Key${character.toUpperCase()}`
      : /^\d$/.test(character) ? `Digit${character}` : { '.': 'Period', '-': 'Minus' }[character];
    assert.ok(code, 'synthetic keyboard input must use the supported ASCII keys');
    const virtualKey = { '.': 190, '-': 189 }[character] ?? character.toUpperCase().charCodeAt(0);
    await key(character, code, virtualKey, { text: character });
  }
}
async function tabTo(condition, label) {
  for (let count = 0; count < 32; count++) {
    if (await ui.evaluate(condition)) return;
    assert.ok(!await ui.evaluate(active(terminal)), `focus entered terminal before reaching ${label}`);
    await key('Tab', 'Tab', 9);
    const observed = await ui.evaluate(`(()=>{
      const item=document.activeElement;
      return {tag:item?.tagName,label:item?.getAttribute('aria-label')??(item?.matches('button,summary')?item.textContent.trim():null)};
    })()`);
    focusTrace.push({ step: label, ...observed });
  }
  throw new Error(`Keyboard focus did not reach ${label}`);
}
const enter = () => key('Enter', 'Enter', 13, { text: '\r' });

try {
  const server = await nextReply();
  ui = await launchDesktop(root, { executable: path.join(preview.directory, 'shared-terminal-desktop.exe') });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const page = () => ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
  assert.deepEqual((await page()).profiles, []);
  assert.deepEqual(await ui.invoke('service_list'), []);
  await tabTo(activeText('连接服务器'), '直接连接入口');
  await enter();
  await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="SSH服务器"]:not([disabled])')`);
  await key('Escape', 'Escape', 27);
  await ui.waitFor(`!document.querySelector('dialog:modal') && ${activeText('连接服务器')}`);
  await enter();
  await ui.waitFor(`!!document.querySelector('dialog:modal [aria-label="SSH服务器"]:not([disabled])')`);

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
await writeFile('artifacts/P12.1-direct-ssh-keyboard.json', JSON.stringify(evidence, null, 2) + '\n');
console.log('PASS ordinary Desktop direct SSH2 keyboard-only connection, input and disconnect');
