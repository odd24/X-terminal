import assert from 'node:assert/strict';
import test from 'node:test';
import {sameConnectionList, sameService, snapshotCursor, subscribeSessionSnapshots} from '../apps/desktop/src/session-snapshot.ts';

const service = {service_id:'one', pid:10, fixture:false, ssh1_preview:false, exit_policy:'stop'};
const a = {connection_id:'a', generation:1, protocol:'SSH2', state:'CONNECTED'};
const b = {...a, connection_id:'b'};
const snapshot = {service, sessions:[a,b], next_cursors:[20,60]};

test('cursor follows exact visible identity after removing the first row, not its former index', () => {
  const [remaining] = snapshot.sessions.filter(row => row.connection_id !== a.connection_id);
  assert.equal(snapshotCursor(snapshot,'one',{...remaining}),60);
  for(const other of [undefined,{...b,generation:2},{...b,protocol:'SERIAL'}])
    assert.equal(snapshotCursor(snapshot,'one',other),undefined);
  assert.equal(snapshotCursor(snapshot,'two',b),undefined);
  const advanced = {...snapshot,next_cursors:[21,62]};
  assert.equal(sameConnectionList(snapshot.sessions,[{...a},{...b}]),true);
  assert.equal(snapshotCursor(advanced,'one',b),62);
  for(const list of [[b,a],[a],[a,{...b,state:'FAILED'}],[a,{...b,generation:2}]])
    assert.equal(sameConnectionList(snapshot.sessions,list),false);
  assert.equal(sameService(service,{...service,previous_close:{}}),true);
  for(const change of [{service_id:'two'},{pid:11},{fixture:true},{ssh1_preview:true},{exit_policy:'other'}])
    assert.equal(sameService(service,{...service,...change}),false);
});

function harness(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const reads=[], applied=[], failures=[];
  let epoch=1;
  const start=(apply=(value,version)=>applied.push([value,version]))=>subscribeSessionSnapshots({
    read(){const next=Promise.withResolvers(); reads.push(next); return next.promise;},
    epoch:()=>epoch,
    apply,
    failed:()=>failures.push(true),
  });
  return {reads,applied,failures,start,advanceRoute(){epoch++;}};
}

test('each window serializes reads, captures the requesting route and cancels the pending timer',async t=>{
  const h=harness(t), stop=h.start();
  h.advanceRoute();
  t.mock.timers.tick(500);
  assert.equal(h.reads.length,1);
  h.reads[0].resolve(snapshot);await Promise.resolve();
  assert.deepEqual(h.applied,[[snapshot,1]]);
  t.mock.timers.tick(99);assert.equal(h.reads.length,1);
  t.mock.timers.tick(1);assert.equal(h.reads.length,2);
  h.reads[1].resolve(snapshot);await Promise.resolve();
  assert.equal(h.applied[1][1],2);
  stop();t.mock.timers.tick(500);assert.equal(h.reads.length,2);
});

test('late success and failure are ignored after remount; active failures stop polling',async t=>{
  const h=harness(t);
  const stopFirst=h.start();
  stopFirst();
  const stopSecond=h.start();
  stopSecond();
  h.start();
  h.reads[0].resolve(snapshot);
  h.reads[1].reject(Error('retired'));
  await Promise.resolve();
  assert.deepEqual(h.applied,[]);
  assert.deepEqual(h.failures,[]);
  h.reads[2].reject(Error('lost'));
  await Promise.resolve();
  t.mock.timers.tick(500);
  assert.deepEqual(h.failures,[true]);
  assert.equal(h.reads.length,3);
  h.start(()=>{throw Error('cannot apply');});
  h.reads[3].resolve(snapshot);
  await Promise.resolve();
  t.mock.timers.tick(500);
  assert.deepEqual(h.failures,[true,true]);
  assert.equal(h.reads.length,4);
});
