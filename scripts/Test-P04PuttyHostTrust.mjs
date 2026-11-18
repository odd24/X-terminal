import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';

const [directory, root, mode = 'trust', source] = process.argv.slice(2);
assert.ok(directory && /^\/tmp\/P04-ssh1\.[A-Za-z0-9]+$/.test(root));
assert.ok(mode === 'trust' || (source && ['approve-fixture', 'resize-fixture'].includes(mode)));
const approve = mode !== 'trust';
const resize = mode === 'resize-fixture';
const map = readFileSync(path.join(directory, 'storage-probe.map'), 'utf8');
assert.doesNotMatch(map, /\bsettings:storage\.c\.obj\b/i);
for (const symbol of ['check_stored_host_key', 'store_host_key']) {
  assert.ok(map.split('\n').some(line =>
    line.trim().split(/\s+/)[1] === symbol && line.trim().endsWith('P04-PuttyStorageGuard.obj')));
}
const wsl = ['-d', 'Ubuntu-24.04', '--cd', root, '--exec'];
const fingerprint = execFileSync('wsl.exe', [...wsl, '/bin/cat', 'fingerprint.txt'], {
  windowsHide: true, encoding: 'utf8', timeout: 5000,
}).trim();
assert.match(fingerprint, /^2048 (?:[\da-f]{2}:){15}[\da-f]{2}$/);

function readFixturePassword() {
  const bytes = readFileSync(source);
  try {
    const declaration = Buffer.from('const char *PHONY_GOOD_PASSWORD = "');
    const start = bytes.indexOf(declaration);
    assert.ok(start >= 0 && bytes.indexOf(declaration, start + declaration.length) < 0);
    const valueStart = start + declaration.length;
    const end = bytes.indexOf('";', valueStart);
    const value = bytes.subarray(valueStart, end);
    assert.ok(end > valueStart && value.length < 63 &&
      value.every(byte => byte >= 0x61 && byte <= 0x7a));
    const line = Buffer.alloc(value.length + 1, 0x0a);
    value.copy(line);
    return line;
  } finally {
    bytes.fill(0);
  }
}

const deniedMethods = ['none', 'publickey', 'kbdint', 'tis', 'cryptocard'];
if (!approve) deniedMethods.push('password');
let serverChild, client, peer, stdout = '', stderr = '', serverClosed, peerEnded = false;
let exitConfirmations = 0, fixtureStdoutEnded = false;
let sizeEvents = 0, sizeBeforeExit;
const closeResult = child => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
const bridge = createServer(socket => {
  if (peer || socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1') {
    socket.destroy();
    return;
  }
  peer = socket;
  socket.once('end', () => { peerEnded = true; });
  bridge.close(); // Claim one connection only.
  const serverArgs = [
    './out/uppity', '--hostkey', 'fixture.rsa1', '--sessiondir', root,
    ...deniedMethods.flatMap(method => ['--deny-auth', method]),
    ...(approve ? ['--allow-auth', 'password', '--verbose'] : []),
  ];
  // In resize mode only these two fixed-format lines can leave WSL on stderr.
  const eventFilter = String.raw`exec "$@" 2> >(/usr/bin/grep -aE --line-buffered '^conn#[0-9]+: (P04 SSH1_CMSG_WINDOW_SIZE [0-9]{1,10} [0-9]{1,10} [0-9]{1,10} [0-9]{1,10}|Client sent exit confirmation)$' >&2)`;
  serverChild = spawn('wsl.exe', [...wsl, '/usr/bin/timeout', '--kill-after=1s', '8s', '/usr/bin/unshare',
    '--user', '--map-current-user', '--net', '/usr/bin/env', '-i',
    `HOME=${root}/home`, `XDG_CONFIG_HOME=${root}/home`, 'PATH=/usr/bin:/bin', 'SHELL=/bin/sh',
    ...(resize ? ['/bin/bash', '-c', eventFilter, 'p04-event-filter'] : []),
    ...serverArgs,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  serverClosed = closeResult(serverChild);
  serverClosed.catch(() => socket.destroy());
  const events = createInterface({ input: serverChild.stderr });
  events.on('line', line => {
    // A UTF-16 WSL launcher notice can leave a NUL after its final newline.
    const event = line.replace(/^\0+/, '');
    const size = /^conn#\d+: P04 SSH1_CMSG_WINDOW_SIZE ((?:\d{1,10} ){3}\d{1,10})$/.exec(event);
    if (resize && size) {
      sizeEvents++;
      if (!exitConfirmations) sizeBeforeExit = size[1].split(' ').map(Number);
    }
    if (/^conn#\d+: Client sent exit confirmation$/.test(event)) exitConfirmations++;
  });
  serverChild.stdout.once('end', () => { fixtureStdoutEnded = true; });
  serverChild.stdin.on('error', () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.pipe(serverChild.stdin);
  serverChild.stdout.pipe(socket);
  socket.once('close', () => serverChild.stdin.end());
});

await new Promise((resolve, reject) => {
  bridge.once('error', reject);
  bridge.listen(0, '127.0.0.1', resolve);
});
const { address, port } = bridge.address();
assert.equal(address, '127.0.0.1');
let deadline, password;
try {
  if (approve) password = readFixturePassword();
  client = spawn(path.join(path.resolve(directory), 'P04-PuttyStorageProbe.exe'),
    [mode, String(port), fingerprint],
    { windowsHide: true, stdio: [approve ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const done = closeResult(client);
  if (password) {
    client.stdin.on('error', () => client.kill());
    client.stdin.end(password, () => password.fill(0));
  }
  client.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (stdout.length > 4096) client.kill();
  });
  client.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 4096) client.kill();
  });
  deadline = setTimeout(() => { peer?.destroy(); client.kill(); }, 9000);
  assert.deepEqual(await done, { code: 0, signal: null }, JSON.stringify({ stdout, stderr }));
  assert.ok(peer && serverClosed);
  assert.equal(stderr, '');
  const lines = stdout.trim().replaceAll('\r', '').split('\n');
  assert.deepEqual(approve ? lines : lines.filter(line => line !== 'P04_OWNER_RESIZE 137x41'),
    approve ? [
      'P04_HOST_CHALLENGE_MATCHED', 'P04_HOST_APPROVED_ONCE',
      'P04_PASSWORD_SUBMITTED_ONCE', 'P04_SESSION_STARTED',
      ...(resize ? ['P04_OWNER_RESIZE_AFTER_PTY 137x41'] : []),
      'P04_PTY_OUTPUT_MATCHED_AND_REMOTE_EXIT_0', 'P04_OWNER_FREE',
    ] : ['P04_HOST_CHALLENGE_MATCHED', 'P04_HOST_REJECTED', 'P04_OWNER_FREE']);
  const fixtureExit = await serverClosed;
  assert.ok(fixtureExit.signal === null && [0, 124].includes(fixtureExit.code), JSON.stringify(fixtureExit));
  if (approve)
    assert.equal(exitConfirmations, 1, JSON.stringify({ peerEnded, fixtureStdoutEnded, fixtureExit }));
  if (resize) {
    assert.equal(sizeEvents, 1);
    assert.deepEqual(sizeBeforeExit, [41, 137, 0, 0]);
    assert.equal(peerEnded, true);
  }
  console.log(JSON.stringify({
    result: 'PASS', hostChallenge: approve ? 'matched and approved once' : 'matched and rejected',
    clientExit: 0, peerEnded,
    fixtureExit: fixtureExit.code, fixtureDeadline: fixtureExit.code === 124, fixtureStdoutEnded,
    windowsLoopbackOwner: process.pid, wslNetworkNamespace: 'private', authPromptCount: approve ? 1 : 0,
    ...(approve ? { ptyOutput: 'matched', remoteExitStatus: 0, exitConfirmations } : {}),
    ...(resize ? { sizeEvents, wireRowsColsPixels: sizeBeforeExit } : {}),
  }));
} finally {
  clearTimeout(deadline);
  password?.fill(0);
  peer?.destroy();
  serverChild?.stdin.end();
  if (bridge.listening) bridge.close();
  if (serverClosed) await serverClosed.catch(() => {});
}
