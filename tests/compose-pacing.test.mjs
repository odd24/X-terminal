import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ComposePacing,composeParts} from '../apps/desktop/src/compose-pacing.ts';
import {ComposeDrafts} from '../apps/desktop/src/compose-drafts.ts';
import {InputQueue} from '../apps/desktop/src/input-queue.ts';
const tick=()=>new Promise(r=>setImmediate(r));

test('line boundaries preserve CRLF, CR, LF, empty lines, controls and Unicode without an extra suffix',()=>{
 const text='中😀\r\n\r\n$HOME\r`literal`\n\x00tail';
 assert.deepEqual(composeParts(text,50),['中😀\r\n','\r\n','$HOME\r','`literal`\n','\x00tail']);
 assert.equal(composeParts(text,50).join(''),text);
 assert.deepEqual(composeParts('a\r\n',50),['a\r\n']);
 assert.equal(Object.isFrozen(composeParts(text,50)),true);
 for(const interval of [0,49,1001,NaN,Infinity,50.5])assert.throws(()=>composeParts(text,interval));
 for(const text of ['', '\ud800','a'.repeat(196609),'\n'.repeat(257)])assert.throws(()=>composeParts(text,50));
 assert.throws(()=>composeParts('\n'.repeat(62),1000),/60秒/);
 assert.equal(composeParts('\n'.repeat(61),1000).length,61);
});

test('preview binds interval to exact selection/revision and rejects invalid budgets before enqueue',()=>{
 const drafts=new ComposeDrafts(),t={connection_id:'synthetic',generation:1,protocol:'SSH2'};
 drafts.edit(t,'keep-A\n中😀\r\nkeep-B');const p=drafts.prepare(t,'cr',{start:7,end:12},100);
 assert.equal(p.interval,100);assert.equal(drafts.consume(t,p),'中😀\r\n\r');assert.throws(()=>drafts.consume(t,p));
 assert.throws(()=>{p.interval=50;},TypeError);assert.equal(drafts.get(t),'keep-A\n中😀\r\nkeep-B');
 for(const interval of [NaN,-1,49,1001])assert.throws(()=>drafts.prepare(t,'none',undefined,interval));
 drafts.edit(t,'\n'.repeat(257));assert.throws(()=>drafts.prepare(t,'none',undefined,50));
});

test('each line waits for its receipt, then the minimum interval; one FIFO slot blocks later input',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let release;const receipt=new Promise(r=>release=r),seen=[],errors=[];
 const job=new ComposePacing('A\r\nB',100),q=new InputQueue(e=>errors.push(e));
 q.enqueue(()=>job.run(async part=>{seen.push(part);if(seen.length===1)await receipt;return true;},()=>true));
 q.enqueue(async()=>{seen.push('keyboard-after');});
 t.mock.timers.tick(1000);await tick();assert.deepEqual(seen,['A\r\n']);assert.equal(job.accepted,0);
 release();await tick();assert.equal(job.state,'waiting');t.mock.timers.tick(99);await tick();assert.deepEqual(seen,['A\r\n']);
 t.mock.timers.tick(1);await tick();assert.deepEqual(seen,['A\r\n','B','keyboard-after']);assert.equal(job.state,'completed');assert.equal(job.accepted,2);assert.deepEqual(errors,[]);
 await assert.rejects(job.run(async()=>true,()=>true),/重复/);
});

test('cancel wakes an interval and never starts the unsent tail; already started receipt is retained',async()=>{
 let release;const receipt=new Promise(r=>release=r),seen=[];const job=new ComposePacing('A\nB\nC',1000);
 const running=job.run(async part=>{seen.push(part);await receipt;return true;},()=>true);
 job.cancel();assert.equal(job.state,'sending');release();await running;assert.equal(job.accepted,1);assert.equal(job.state,'cancelled');assert.deepEqual(seen,['A\n']);
 const waiting=new ComposePacing('A\nB',1000);const done=waiting.run(async()=>true,()=>true);await tick();assert.equal(waiting.state,'waiting');waiting.cancel();await done;assert.equal(waiting.state,'cancelled');assert.equal(waiting.accepted,1);
});

test('queued cancellation, route epoch change and disposed targets cannot dispatch or retarget',async()=>{
 const stopped=new ComposePacing('A\nB',50);stopped.cancel();await stopped.run(async()=>assert.fail(),()=>true);assert.equal(stopped.accepted,0);assert.equal(stopped.state,'cancelled');
 let epoch=1;const seen=[],job=new ComposePacing('A\nB',50);await job.run(async part=>{seen.push(part);epoch++;return true;},()=>epoch===1);assert.deepEqual(seen,['A\n']);assert.equal(job.state,'cancelled');
 const gone=new ComposePacing('A',50);await gone.run(async()=>assert.fail(),()=>false);assert.equal(gone.state,'cancelled');
});

test('unknown receipt stops the job and original FIFO; no tail, later keyboard or retry is dispatched',async()=>{
 let fail;const receipt=new Promise((_,r)=>fail=r),seen=[],errors=[],q=new InputQueue(e=>errors.push(e));const job=new ComposePacing('A\nB',50);
 q.enqueue(()=>job.run(async part=>{seen.push(part);await receipt;return true;},()=>true));q.enqueue(async()=>{seen.push('later');});
 fail(new Error('unknown'));await tick();assert.equal(job.state,'unknown');assert.equal(job.accepted,0);assert.deepEqual(seen,['A\n']);assert.equal(errors.length,1);assert.equal(q.enqueue(async()=>assert.fail()),false);
});
