import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

// This is banner negotiation only. It does not implement an SSH1 server or auth.
const executable = path.resolve('.tools/putty/plink.exe');
const expectedSha256 = '969f36879d5716aa1a9811f43a6a6510e8f08372dbeb9695b810b9c776f39c75';
assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'), expectedSha256);
const version = execFileSync(executable, ['-V'], { encoding: 'utf8', windowsHide: true });
assert.match(version, /Release 0\.85/);

async function probe(protocol, remoteBanner) {
  const sockets = new Set();
  let banner = '';
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.write(remoteBanner + '\r\n');
    socket.on('data', bytes => { banner += bytes.toString('ascii'); if (banner.length > 4096) socket.destroy(); });
    const timer = setTimeout(() => socket.end(), 200);
    socket.on('close', () => { clearTimeout(timer); sockets.delete(socket); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(executable, ['-ssh', protocol, '-batch', '-noagent', '-noshare', '-T', '-P', String(server.address().port), '-l', 'fixture', '127.0.0.1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdin.end();
  child.stdout.resume();
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); if (stderr.length > 8192) child.kill(); });
  let deadline;
  try {
    const exitCode = await Promise.race([
      new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Plink probe timeout')), 5000); }),
    ]);
    assert.notEqual(exitCode, 0, 'incomplete handshake must not look successful');
    return { protocol, remoteBanner, clientBanner: banner.split('\n')[0].trim(), exitCode, stderr: stderr.trim(), handshake: 'NOT_IMPLEMENTED', authentication: 'NOT_TESTED' };
  } finally {
    clearTimeout(deadline);
    child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

const ssh1 = await probe('-1', 'SSH-1.5-P04-synthetic-fixture');
assert.match(ssh1.clientBanner, /^SSH-1\.5-PuTTY_Release_0\.85/);
const ssh2 = await probe('-2', 'SSH-1.5-P04-synthetic-fixture');
assert.ok(!ssh2.clientBanner.startsWith('SSH-1.'), 'SSH2 must never fall back to SSH1');
const explicit1 = await probe('-1', 'SSH-2.0-P04-synthetic-fixture');
assert.ok(!explicit1.clientBanner.startsWith('SSH-2.'), 'explicit SSH1 must not switch protocol');
const report = { version: version.trim(), sha256: expectedSha256, scope: 'banner and no-downgrade only; not SSH1 interaction acceptance', probes: [ssh1, ssh2, explicit1] };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/P04-banner-probe.json', JSON.stringify(report, null, 2) + '\n');
console.log('PASS: verified Plink 0.85 startup, explicit SSH1 banner and no protocol fallback; full handshake/auth/PTY NOT TESTED.');
