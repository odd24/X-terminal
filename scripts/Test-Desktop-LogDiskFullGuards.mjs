import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';

const flag = '--log-disk-full-fixture';
const ordinary = process.argv[2] === '--ordinary';
const bin = path.resolve(ordinary ? 'target/debug' : process.argv[2]);
const prefix = 'shared-terminal-log-disk-full-中文-';
const root = path.join(tmpdir(), prefix + crypto.randomUUID());
const rejected = await mkdtemp(path.join(tmpdir(), 'shared-terminal-disk-full-reject-中文-'));
await mkdir(root);
const desktop = path.join(bin, 'shared-terminal-desktop.exe');
const service = path.join(bin, 'session-service.exe');
const cases = [];
function refuse(name, executable, args, code) {
  const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(code), `${name} must refuse with ${code}`);
  cases.push(name);
}

try {
  if (ordinary) {
    refuse('ordinary Desktop', desktop, [flag, '--data-dir', root], 'LOG_DISK_FULL_FIXTURE_DISABLED');
    refuse('ordinary service', service, [flag, '--data-dir', root], 'LOG_DISK_FULL_FIXTURE_DISABLED');
  } else {
    refuse('missing explicit root', desktop, [flag], 'LOG_DISK_FULL_TEST_ROOT_REQUIRED');
    refuse('invalid root', desktop, [flag, '--data-dir', rejected], 'LOG_DISK_FULL_TEST_ROOT_REJECTED');
    refuse('fixture session combination', desktop, [flag, '--test-fixture', '--data-dir', root], 'LOG_DISK_FULL_TEST_REQUIRES_ORDINARY_SESSION');
  }
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await readdir(rejected), []);
  if (ordinary) {
    const ui = await launchDesktop(root, { executable: desktop });
    try {
      assert.equal((await ui.invoke('service_status')).fixture, false);
      assert.deepEqual(await ui.invoke('service_list'), []);
    } finally { await ui.close(); }
  }
} finally {
  for (const [directory, expected] of [[root, prefix], [rejected, 'shared-terminal-disk-full-reject-中文-']]) {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), await realpath(tmpdir()));
    assert.ok(path.basename(resolved).startsWith(expected));
    await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
await writeFile(`artifacts/P24-desktop-log-disk-full-${ordinary ? 'ordinary' : 'fixture'}-guards.json`,
  JSON.stringify({ result: 'PASS', cases, ordinaryStartup: ordinary }, null, 2) + '\n');
console.log(`PASS DiskFull ${ordinary ? 'ordinary Desktop and service refusals and startup' : 'Desktop fixture root and session guards'}`);
