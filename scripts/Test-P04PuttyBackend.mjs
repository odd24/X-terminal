import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';

const [directory] = process.argv.slice(2);
assert.ok(directory && process.argv.length === 3);
const exe = path.join(path.resolve(directory), 'P04-PuttyStorageProbe.exe');
const map = readFileSync(path.join(directory, 'storage-probe.map'), 'utf8');
assert.doesNotMatch(map, /\bsettings:storage\.c\.obj\b/i);
for (const [symbol, object] of [
  ['open_settings_r', 'no-storage.obj'],
  ['read_random_seed', 'no-storage.obj'],
  ['write_random_seed', 'no-storage.obj'],
  ['check_stored_host_key', 'P04-PuttyStorageGuard.obj'],
  ['store_host_key', 'P04-PuttyStorageGuard.obj'],
]) {
  assert.ok(map.split('\n').some(line => line.trim().split(/\s+/)[1] === symbol && line.trim().endsWith(object)), symbol);
}
const run = args => execFileSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 6000, maxBuffer: 4096 });
assert.equal(run([]).trim(), 'PASS backend linked with empty profile and nonpersistent seed hooks');
for (const [mode, status, reason] of [['lookup', 23, 'lookup'], ['write', 24, 'write']]) {
  assert.throws(() => run([mode]), error =>
    error.status === status && error.stderr.trim() === `P04_STORAGE_GUARD: host-key ${reason} refused`);
}

let peer, wire = '', stdout = '', stderr = '', connections = 0, closedByFixture = false;
function finishBanner() {
  if (!closedByFixture && wire.includes('\n') && stdout.includes('P04_OWNER_RESIZE 137x41')) {
    closedByFixture = true;
    peer.end();
  }
}
const server = createServer(socket => {
  connections++;
  if (connections !== 1) { socket.destroy(); return; }
  peer = socket;
  socket.on('error', () => {});
  socket.on('data', chunk => {
    wire += chunk.toString('latin1');
    if (wire.length > 1024) socket.destroy();
    else finishBanner();
  });
  // The fixture provides only the SSH1 version line, with no key packet.
  socket.write('SSH-1.5-P04-isolated-banner\r\n');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let child, deadline;
try {
  child = spawn(exe, ['loopback', String(server.address().port)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (stdout.length > 4096) child.kill();
    else finishBanner();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 4096) child.kill();
  });
  deadline = setTimeout(() => child.kill(), 6500);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(connections, 1);
  assert.ok(closedByFixture);
  assert.match(wire, /^SSH-1\.5-PuTTY_Release_0\.85\r?\n$/);
  assert.equal(stdout.trim().replaceAll('\r', ''), 'P04_OWNER_RESIZE 137x41\nP04_OWNER_FREE');
  assert.equal(stderr, '');
  console.log(JSON.stringify({
    result: 'PASS', banner: wire.trim(), size: [137, 41], ownerFreed: true,
    hostKeyLookupDenied: 23, hostKeyWriteDenied: 24,
    sha256: createHash('sha256').update(readFileSync(exe)).digest('hex'),
  }));
} finally {
  clearTimeout(deadline);
  peer?.destroy();
  await new Promise(resolve => server.close(resolve));
}
