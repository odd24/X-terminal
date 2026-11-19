import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { active, desktopKeyboard, terminalInput } from './lib/DesktopKeyboard.mjs';

const program = process.argv[2];
assert.ok(['top', 'tmux'].includes(program));
const preview = JSON.parse(await readFile('artifacts/P13-keyboard-focus-normal-preview-final.json', 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}
const executable = path.join(preview.directory, 'shared-terminal-desktop.exe');
const wsl = ['-d', 'Ubuntu-24.04', '--exec'];
const linux = (args, input) => execFileSync('wsl.exe', [...wsl, ...args], {
  input, encoding: 'utf8', timeout: 6000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
}).trim();
const upstream = '/tmp/P04-ssh1.xRu4rRNo';
const uppity = `${upstream}/out/uppity`;
const puttygen = `${upstream}/out/puttygen`;
assert.deepEqual(linux(['sha256sum', uppity, puttygen]).split('\n').map(line => line.split(' ')[0]), [
  'd06d2afda1e09bc322ba6d4eaa8c1ea5aa61fa28662e6283b80db48147a04bbe',
  '29b0530ce41685b0d3d02db73ff4840acefe4d6a32361afd29f60ae0e0060e1e',
]);
const version = linux([`/usr/bin/${program}`, '-V']);
assert.match(version, program === 'top' ? /^top from procps-ng [\d.]+$/ : /^tmux [\d.]+[a-z]?$/);
const fixture = linux(['/usr/bin/mktemp', '-d', '/tmp/T06-pty.XXXXXXXX']);
assert.match(fixture, /^\/tmp\/T06-pty\.[A-Za-z0-9]{8}$/);
const ns = ['/usr/bin/unshare', '--user', '--map-current-user', '--net', '--pid', '--fork', '--kill-child', '--mount-proc'];
const evidence = { result: 'FAIL', program: version, preview: preview.directory, protocol: 'SSH2' };
const artifact = `P11-T06-wsl-${program}-${randomUUID()}.json`;
const root = await mkdtemp(path.join(tmpdir(), `shared-terminal-t06-${program}-中文-`));
let ui, server, child, done, socket, servicePid;
let verified = false;

async function run() {
  const wrapper = (await readFile('scripts/lib/T06-LinuxPtyFixture.sh', 'utf8')).replaceAll('\r\n', '\n');
  linux(['/usr/bin/tee', `${fixture}/shell`], wrapper);
  linux(['/bin/sh', '-c', `set -eu; umask 077; cd "$1";
    chmod 700 shell; mkdir home; ln -s /usr/bin/sleep home/t06-own-process;
    mkdir -p home/.config/procps;
    printf '%s\\n' 'set -g status off' 'set -g default-shell /bin/sh' > home/tmux.conf;
    printf '\\n' > passphrase;
    "$2" -q -t ed25519 -O private --new-passphrase passphrase -o host.ppk;
    "$2" -L host.ppk > host.pub; rm passphrase`, 'setup', fixture, puttygen]);
  const pin = /^256 (SHA256:[A-Za-z0-9+/]{43}) .+ \(ED25519\)$/.exec(linux(['/usr/bin/ssh-keygen', '-lf', `${fixture}/host.pub`]))?.[1];
  assert.ok(pin, 'fixture must have one ED25519 host key');
  const source = linux(['/bin/cat', `${upstream}/putty-0.85/unix/uppity.c`]);
  const password = /const char \*PHONY_GOOD_PASSWORD = "([a-z]{1,63})";/.exec(source)?.[1];
  assert.ok(password, 'synthetic upstream password declaration required');

  let connections = 0;
  let advertised = '';
  server = createServer(client => {
    if (socket || client.localAddress !== '127.0.0.1' || client.remoteAddress !== '127.0.0.1') return client.destroy();
    socket = client;
    connections++;
    server.close();
    child = spawn('wsl.exe', [...wsl, '/usr/bin/timeout', '--kill-after=1s', '25s', ...ns,
      '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${fixture}/home`, `SHELL=${fixture}/shell`,
      `T06_PROGRAM=${program}`, '/bin/sh', '-c', 'test "$$" = 1 && test -r /proc/1/comm && exec "$@"', 'private-init',
      '/usr/bin/timeout', '--kill-after=1s', '20s', uppity,
      '--hostkey', `${fixture}/host.ppk`, '--sessiondir', fixture, '--allow-auth', 'password',
      ...['none', 'publickey', 'kbdint', 'tis', 'cryptocard'].flatMap(method => ['--deny-auth', method])],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    done.catch(() => socket.destroy());
    child.stdout.once('data', data => { advertised = /^SSH-(\d+\.\d+)-/.exec(data.subarray(0, 32).toString('ascii'))?.[1]; });
    child.stdin.on('error', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  ui = await launchDesktop(root, { executable });
  const status = await ui.invoke('service_status');
  servicePid = status.pid;
  assert.equal(status.fixture, false);
  assert.equal(status.ssh1_preview, false);
  assert.deepEqual(await ui.invoke('service_list'), []);
  await ui.command('Page.bringToFront');
  const keyboard = desktopKeyboard(ui, []);
  await ui.click('连接服务器');
  await ui.waitFor('!!document.querySelector(\'[aria-label="SSH服务器"]:not([disabled])\')');
  await ui.fill('SSH服务器', '127.0.0.1');
  await ui.fill('SSH用户名', 'synthetic');
  await ui.evaluate(`[...document.querySelectorAll('summary')].find(node=>node.textContent==='高级连接设置').parentElement.open=true`);
  await ui.fill('SSH端口', port);
  await ui.click('连接');
  const approval = '[aria-label="快速连接核对指纹"]';
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(approval)})`);
  assert.equal(advertised, '2.0');
  evidence.advertised = advertised;
  assert.equal(await ui.evaluate("document.querySelector('dialog:modal .fingerprint').textContent"), pin);
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(approval)}).checked`), false);
  await ui.evaluate(`document.querySelector(${JSON.stringify(approval)}).click()`);
  await ui.click('信任并继续登录');
  await ui.waitFor(`${active('[aria-label="SSH登录密码"]')} && !document.activeElement.disabled
    && [...document.querySelectorAll('dialog:modal button')].some(button=>button.textContent==='提交本次登录信息'&&!button.disabled)`);
  await keyboard.type(password);
  await keyboard.enter();
  await ui.waitFor("!document.querySelector('dialog:modal')");
  const [connection, ...others] = await ui.invoke('service_list');
  assert.deepEqual(others, []);
  assert.equal(connection.protocol, 'SSH2');
  assert.equal(connection.state, 'CONNECTED');
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  const pane = `.terminal-pane[data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
  const hasRow = marker => `Array.from(document.querySelectorAll(${JSON.stringify(pane + ' .xterm-rows > div')}))
    .some(row=>row.textContent.includes(${JSON.stringify(marker)}))`;
  const screen = async () => {
    const result = await ui.invoke('service_screen', { connection: ref });
    assert.deepEqual(result.connection, ref);
    assert.equal(result.gap_bytes, 0);
    assert.equal(result.decode_error_events, 0);
    return { cols: result.cols, rows: result.rows, alternate: result.alternate };
  };
  const window = (width, height, measureOnly = false) => JSON.parse(execFileSync('pwsh', [
    '-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1', '-TargetProcessId', String(ui.app.pid),
    '-ExpectedExecutable', executable, '-Width', String(width), '-Height', String(height), '-PhysicalSize',
    ...(measureOnly ? ['-MeasureOnly'] : []),
  ], { windowsHide: true, encoding: 'utf8', timeout: 6000 }));
  await ui.waitFor(hasRow('T06_PRIMARY'));
  assert.equal((await screen()).alternate, false);
  await ui.evaluate(`document.querySelector(${JSON.stringify(`${pane} ${terminalInput}`)}).focus()`);
  await keyboard.enter();
  const marker = program === 'top' ? 't06-own-process' : 'T06_TMUX_INNER';
  await ui.waitFor(hasRow(marker));
  assert.equal(await ui.evaluate(hasRow('T06_PRIMARY')), false);
  const before = evidence.before = await screen();
  assert.equal(before.alternate, true, 'full-screen programme must use the alternate screen');
  const read = async cursor => {
    const page = await ui.invoke('service_read', { connection: ref, cursor });
    assert.deepEqual(page.connection, ref);
    assert.ok(!page.truncated && page.events.every(event => !event.gap_bytes));
    return page;
  };
  const prior = await read(1);
  const initialWindow = window(640, 480, true);
  const resized = window(initialWindow.width - 160, initialWindow.height - 110);
  assert.equal(resized.hwnd, initialWindow.hwnd);
  assert.equal(resized.dpi, initialWindow.dpi);
  assert.deepEqual([resized.width, resized.height], [initialWindow.width - 160, initialWindow.height - 110]);
  evidence.window = { before: [initialWindow.width, initialWindow.height], after: [resized.width, resized.height], dpi: resized.dpi };
  for (let attempt = 0; attempt < 100; attempt++) {
    const after = await screen();
    if (after.cols < before.cols && after.rows < before.rows && after.alternate && await ui.evaluate(hasRow(marker))) {
      const fresh = await read(prior.next_cursor);
      if (fresh.events.some(event => event.bytes?.length)) {
        evidence.after = after;
        evidence.freshRemoteOutput = true;
        break;
      }
    }
    await delay(40);
  }
  assert.ok(evidence.after, 'resized alternate screen must show the owned marker');
  if (program === 'top') await keyboard.key('q', 'KeyQ', 81, { text: 'q' });
  else await keyboard.enter();
  await ui.waitFor(`${hasRow('T06_PRIMARY')} && ${hasRow('T06_AFTER exit=0')}`);
  assert.equal((await screen()).alternate, false);
  const [same] = await ui.invoke('service_list');
  assert.deepEqual(same, connection);
  assert.equal(connections, 1);
  evidence.primaryRestored = true;
  await keyboard.enter();
  for (let attempt = 0; attempt < 100; attempt++) {
    const [current] = await ui.invoke('service_list');
    if (current?.state === 'DISCONNECTED') break;
    if (attempt === 99) throw new Error('owned remote shell did not disconnect');
    await delay(40);
  }
  evidence.fixtureExit = await done;
  assert.ok(evidence.fixtureExit.signal === null && [0, 124].includes(evidence.fixtureExit.code));
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('退出桌面');
  for (let attempt = 0; attempt < 100 && ui.app.exitCode === null; attempt++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  evidence.desktopExit = ui.app.exitCode;
}

try {
  await run();
  verified = true;
} catch (error) {
  // Only fixed stage/assertion messages are recorded. Never capture the terminal or raw peer output.
  evidence.error = error.message.split('\n')[0];
  throw new Error(`T06 ${program} failed; see ${artifact}`);
} finally {
  try {
    try { await ui?.close(); } finally {
      if (servicePid) {
        assert.throws(() => process.kill(servicePid, 0), { code: 'ESRCH' });
        evidence.serviceExited = true;
      }
    }
  } finally {
    try {
      if (server?.listening) server.close();
      socket?.destroy();
      if (done) await done.catch(() => {});
      assert.equal(path.dirname(root), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith(`shared-terminal-t06-${program}-中文-`));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      linux(['/bin/sh', '-c', 'rm -f -- "$1/shell" "$1/host.ppk" "$1/host.pub" "$1/passphrase" "$1/home/t06-own-process" "$1/home/t06.sock" "$1/home/tmux.conf"; rmdir -- "$1/home/.config/procps" "$1/home/.config" "$1/home" "$1"',
        'cleanup', fixture]);
      evidence.released = true;
      if (verified && evidence.serviceExited) evidence.result = 'PASS';
    } finally {
      await writeFile(`artifacts/${artifact}`, JSON.stringify(evidence, null, 2) + '\n');
      console.log(`${evidence.result} ${artifact}`);
    }
  }
}
