import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { samplerClient, startSoakSampler } from './lib/SoakSamplerClient.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'shared-terminal-soak-sampler-中文-'));
try {
  const sampler = startSoakSampler(root);
  try {
    for (let i = 0; i < 3; i++) {
      const sample = await sampler.request('preflight');
      assert.ok(sample.memory > sample.available && sample.available > 0);
      assert.equal(sample.free.length, 2);
      assert.equal(sample.acTimers.length, 2);
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
