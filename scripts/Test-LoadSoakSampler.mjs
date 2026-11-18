import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { samplerClient, startSoakSampler } from './lib/SoakSamplerClient.mjs';
import { checkSoakResourceFloor } from './lib/LoadSoak.mjs';

const GiB = 1024 ** 3;
for (const [stage, availableFloorBytes, volumeFloorBytes] of [
  ['preflight', 2 * GiB, 8 * GiB],
  ['sampling', GiB, 4 * GiB],
]) {
  const report = {};
  checkSoakResourceFloor({ available: availableFloorBytes, free: [volumeFloorBytes, volumeFloorBytes] }, stage, report);
  assert.deepEqual(report, {});
  for (const [available, data, reports] of [
    [availableFloorBytes - 1, volumeFloorBytes, volumeFloorBytes],
    [availableFloorBytes, volumeFloorBytes - 1, volumeFloorBytes],
    [availableFloorBytes, volumeFloorBytes, volumeFloorBytes - 1],
  ]) {
    assert.throws(() => checkSoakResourceFloor({ available, free: [data, reports] }, stage, report), /Soak resource low water/);
    assert.deepEqual(report.resourceLowWater, {
      stage, availableBytes: available, availableFloorBytes, freeBytes: { data, reports }, volumeFloorBytes,
      systemCommitBytes: null, ownedMemoryBytes: null,
    });
  }
}
{
  const report = {};
  const systemCommitBytes = { used: 10 * GiB, limit: 20 * GiB };
  const measured = {
    available: GiB - 1, free: [4 * GiB, 4 * GiB], systemCommitBytes,
    processes: { desktop: { private: 100, working: 200 }, service: { private: 300, working: 400 } },
  };
  assert.throws(() => checkSoakResourceFloor(measured, 'sampling', report, 500), /Soak resource low water/);
  assert.deepEqual(report.resourceLowWater.systemCommitBytes, systemCommitBytes);
  assert.deepEqual(report.resourceLowWater.ownedMemoryBytes, {
    privateExcludingNode: 400, workingSetExcludingNode: 600, nodeRss: 500,
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), 'shared-terminal-soak-sampler-中文-'));
try {
  const sampler = startSoakSampler(root);
  try {
    for (let i = 0; i < 3; i++) {
      const sample = await sampler.request('preflight');
      assert.ok(sample.memory > sample.available && sample.available > 0);
      assert.equal(sample.free.length, 2);
      assert.equal(sample.acTimers.length, 2);
      assert.ok(Number.isSafeInteger(sample.systemCommitBytes.used) && sample.systemCommitBytes.used > 0);
      assert.ok(Number.isSafeInteger(sample.systemCommitBytes.limit) && sample.systemCommitBytes.limit >= sample.systemCommitBytes.used);
    }
  } finally {
    const stopped = await sampler.close();
    assert.equal(stopped.code, 0);
    assert.equal(stopped.requests, 4);
    assert.equal(stopped.exited, true);
    assert.equal(stopped.killed, false);
  }

  const invalidTree = startSoakSampler(root);
  let problem;
  try {
    await assert.rejects(invalidTree.request('sample', { desktop: process.pid, service: process.pid, fixture: process.pid }), error => {
      problem = error.samplerFailure;
      return problem?.stage === 'process_snapshot';
    });
  } finally {
    const stopped = await invalidTree.close();
    assert.equal(stopped.code, 1);
    assert.equal(stopped.exited, true);
    assert.equal(problem.exitCode, 1);
    assert.equal(problem.killed, false);
  }

  for (const [mode, expected] of [['wrongId', 'response_id'], ['hang', 'deadline']]) {
    const child = samplerClient(process.execPath, ['-e', `
      process.stdout.write('{"id":0,"ready":true}\\n');
      process.stdin.on('data', () => {
        if ('${mode}' === 'wrongId') process.stdout.write('{"id":2,"result":{}}\\n');
      });
    `], 1500);
    try {
      await assert.rejects(child.request('sample'), error => error.samplerFailure?.stage === expected);
    } finally {
      const stopped = await child.close();
      assert.equal(stopped.exited, true);
      assert.equal(stopped.killed, true);
      assert.equal(stopped.failure.timeout, mode === 'hang');
    }
  }
} finally {
  await rmdir(root);
}
console.log('PASS resident sampler: repeated native preflight, invalid PID tree, wrong response ID, bounded timeout and child exits');
