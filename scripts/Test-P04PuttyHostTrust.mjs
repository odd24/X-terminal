import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const [directory, root] = process.argv.slice(2);
assert.ok(directory && /^\/tmp\/P04-ssh1\.[A-Za-z0-9]+$/.test(root));
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

let serverChild, client, peer, stdout = '', stderr = '', serverClosed;
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
  bridge.close(); // Claim one connection only.
  serverChild = spawn('wsl.exe', [...wsl, '/usr/bin/timeout', '--kill-after=1s', '8s', '/usr/bin/unshare',
    '--user', '--map-current-user', '--net', '/usr/bin/env', '-i',
    `HOME=${root}/home`, `XDG_CONFIG_HOME=${root}/home`, 'PATH=/usr/bin:/bin',
    './out/uppity', '--hostkey', 'fixture.rsa1', '--sessiondir', root,
    ...['none', 'password', 'publickey', 'kbdint', 'tis', 'cryptocard'].flatMap(method => ['--deny-auth', method]),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  serverClosed = closeResult(serverChild);
  serverClosed.catch(() => socket.destroy());
  serverChild.stderr.resume();
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
let deadline;
try {
  client = spawn(path.join(path.resolve(directory), 'P04-PuttyStorageProbe.exe'),
    ['trust', String(port), fingerprint],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = closeResult(client);
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
  assert.deepEqual(lines.filter(line => line !== 'P04_OWNER_RESIZE 137x41'),
    ['P04_HOST_CHALLENGE_MATCHED', 'P04_HOST_REJECTED', 'P04_OWNER_FREE']);
  const fixtureExit = await serverClosed;
  assert.ok(fixtureExit.signal === null && [0, 124].includes(fixtureExit.code), JSON.stringify(fixtureExit));
  console.log(JSON.stringify({
    result: 'PASS', hostChallenge: 'matched and rejected', clientExit: 0,
    fixtureExit: fixtureExit.code, fixtureDeadline: fixtureExit.code === 124,
    windowsLoopbackOwner: process.pid, wslNetworkNamespace: 'private', authPromptCount: 0,
  }));
} finally {
  clearTimeout(deadline);
  peer?.destroy();
  serverChild?.stdin.end();
  if (bridge.listening) bridge.close();
  if (serverClosed) await serverClosed.catch(() => {});
}
