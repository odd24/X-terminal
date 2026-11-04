import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue } from '../apps/desktop/src/input-queue.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('input FIFO includes in-flight work in its cap and rejects overflow without sending', async () => {
  let release; const first = new Promise(resolve => { release = resolve; });
  const seen = []; const failures = [];
  const queue = new InputQueue(error => failures.push(error));
  assert.equal(queue.enqueue(async () => { seen.push(0); await first; }), true);
  for (let index = 1; index < 16; index++) assert.equal(queue.enqueue(async () => { seen.push(index); }), true);
  assert.equal(queue.enqueue(async () => { seen.push('overflow'); }), false);
  release(); await tick();
  assert.deepEqual(seen, Array.from({length:16}, (_, index) => index));
  assert.deepEqual(failures, []);
});
test('unknown dispatch latches failure, discards unsent actions and cannot retry', async () => {
  let fail; const first = new Promise((_, reject) => { fail = reject; });
  const failures = []; let sent = 0;
  const queue = new InputQueue(error => failures.push(error));
  queue.enqueue(async () => { sent++; await first; });
  queue.enqueue(async () => { sent++; });
  fail(new Error('unknown')); await tick();
  assert.equal(sent,1); assert.equal(failures.length,1);
  assert.equal(queue.enqueue(async () => { sent++; }),false);
});
test('closing a generation discards pending input and suppresses late failures', async () => {
  let fail; const first = new Promise((_, reject) => { fail = reject; });
  const failures = []; let sent = 0;
  const queue = new InputQueue(error => failures.push(error));
  queue.enqueue(async () => { sent++; await first; });
  queue.enqueue(async () => { sent++; }); queue.close();
  fail(new Error('old generation')); await tick();
  assert.equal(sent,1); assert.deepEqual(failures,[]);
  assert.equal(queue.enqueue(async () => { sent++; }), false);
});
