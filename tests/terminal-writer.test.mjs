import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalWriter } from '../apps/desktop/src/terminal-writer.ts';

test('caps queued and in-flight bytes, latches gap and preserves accepted order', async () => {
  const callbacks = [];
  const writes = [];
  const writer = new TerminalWriter({ write(bytes, done) { writes.push([...bytes]); callbacks.push(done); } }, 4, 2, 4);
  const mutable = new Uint8Array([1, 2]);
  assert.equal(writer.enqueue(mutable), true);
  mutable[0] = 99;
  assert.equal(writer.enqueue(new Uint8Array([3, 4])), true);
  assert.equal(writer.pendingBytes, 4);
  assert.equal(writer.enqueue(new Uint8Array([5])), false);
  callbacks.shift()();
  assert.equal(writer.enqueue(new Uint8Array([6])), false, 'gap requires replay/reset');
  const drained = writer.drain();
  callbacks.shift()();
  await drained;
  assert.deepEqual(writes, [[1, 2], [3, 4]]);
  assert.equal(writer.pendingBytes, 0);
  assert.equal(writer.lostBytes, 2);
});

test('bounds event count and oversized chunks; close discards unsent writes', async () => {
  const callbacks = [];
  let sent = 0;
  const writer = new TerminalWriter({ write(_bytes, done) { sent++; callbacks.push(done); } }, 100, 1, 10);
  assert.equal(writer.enqueue(new Uint8Array(1)), true);
  assert.equal(writer.enqueue(new Uint8Array(1)), true);
  assert.equal(writer.enqueue(new Uint8Array(1)), false);
  const drained = writer.drain();
  writer.close();
  await drained;
  callbacks.shift()();
  assert.equal(sent, 1);
  assert.equal(writer.enqueue(new Uint8Array(1)), false);
  const oversized = new TerminalWriter({ write() { assert.fail('must not write'); } }, 100, 1, 10);
  assert.equal(oversized.enqueue(new Uint8Array(11)), false);
});
