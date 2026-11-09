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

test('keyboard merges only unsent same-epoch printable or same erase tails across no explicit barrier',async()=>{
  let release;const first=new Promise(r=>release=r),seen=[];const q=new InputQueue(()=>assert.fail());
  q.enqueue(async()=>{await first;});const send=async text=>{seen.push(text);};
  q.enqueueKeyboard('a','one/1',send);q.enqueueKeyboard('中','one/1',send);
  q.enqueueKeyboard('\x7f','one/1',send);q.enqueueKeyboard('\x7f','one/1',send);
  q.enqueueKeyboard('\x1b[3~','one/1',send);q.enqueueKeyboard('\x1b[3~','one/1',send);
  q.enqueueKeyboard('b','one/2',send);q.enqueueKeyboard('c','two/1',send);
  q.enqueue(async()=>{seen.push('compose/paste/resize');});q.enqueueKeyboard('d','two/1',send);
  q.enqueueKeyboard('\r','two/1',send);q.enqueueKeyboard('e','two/1',send);q.enqueueKeyboard('\u009b','two/1',send);q.enqueueKeyboard('f','two/1',send);
  release();await tick();assert.deepEqual(seen,['a中','\x7f\x7f','\x1b[3~\x1b[3~','b','c','compose/paste/resize','d','\r','e','\u009b','f']);
});

test('keyboard pending bytes and entries stay bounded, active material never changes',async()=>{
  let release;const first=new Promise(r=>release=r),seen=[];const q=new InputQueue(()=>assert.fail());
  q.enqueueKeyboard('first','one',async text=>{seen.push(text);await first;});
  for(let i=0;i<15;i++)assert.equal(q.enqueueKeyboard('a'.repeat(4096),'one',async text=>{seen.push(text);}),true);
  assert.equal(q.enqueueKeyboard('x','one',async()=>assert.fail()),false);
  release();await tick();assert.equal(seen[0],'first');assert.equal(seen.length,16);assert.equal(seen.slice(1).every(s=>s.length===4096),true);
});

test('unknown and close discard merged unsent keyboard without replay',async()=>{
  let fail;const first=new Promise((_,r)=>fail=r),seen=[],errors=[];const q=new InputQueue(e=>errors.push(e));
  q.enqueueKeyboard('sent','one',async text=>{seen.push(text);await first;});q.enqueueKeyboard('a','one',async text=>seen.push(text));q.enqueueKeyboard('b','one',async text=>seen.push(text));
  fail(new Error('unknown'));await tick();assert.deepEqual(seen,['sent']);assert.equal(errors.length,1);assert.equal(q.enqueueKeyboard('retry','one',async()=>assert.fail()),false);
  const closed=new InputQueue(()=>assert.fail());closed.close();assert.equal(closed.enqueueKeyboard('x','one',async()=>assert.fail()),false);
});
