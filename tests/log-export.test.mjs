import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedExport, restoreExport, terminalExport } from '../apps/desktop/src/log-export.ts';
const scope = { connection: { connection_id:'11111111-1111-4111-8111-111111111111', generation:3 }, log_id:'22222222-2222-4222-8222-222222222222', request_id:'33333333-3333-7333-8333-333333333333' };
const pending = () => ({ result:'export', ...structuredClone(scope), phase:'RUNNING', failure:null, bytes:null, retained_records:null, retained_raw_bytes:null, retained_gap_bytes:null, next_cursor:null });
const done = () => ({ ...pending(), phase:'COMPLETED', bytes:3000, retained_records:4, retained_raw_bytes:9, retained_gap_bytes:13, next_cursor:57 });

test('export replies must match the exact frozen scope and completion before revealing paths or counters', () => {
  assert.equal(terminalExport(checkedExport(pending(),scope)),false);
  assert.equal(terminalExport(checkedExport(done(),scope)),true);
  for (const edit of [v=>v.log_id=scope.request_id, v=>v.request_id=scope.log_id, v=>v.connection.generation++, v=>v.connection.connection_id=scope.log_id, v=>v.result='info', v=>v.phase='UNKNOWN']) {
    const value=done();edit(value);assert.throws(()=>checkedExport(value,scope));
  }
  for (const phase of ['QUEUED','RUNNING','CANCELLING','CANCELLED','FAILED']) {
    const value={...done(),phase, failure:phase==='FAILED'?'STORAGE':null};
    assert.throws(()=>checkedExport(value,scope),'noncompleted jobs cannot claim retained/saved totals');
  }
});
test('export safety rejects unsafe integer totals, incomplete terminal shapes and impossible size claims', () => {
  for (const key of ['bytes','retained_records','retained_raw_bytes','retained_gap_bytes','next_cursor']) {
    for (const bad of [null,undefined,-1,1.5,Number.MAX_SAFE_INTEGER+1,'13',NaN]) {
      assert.throws(()=>checkedExport({...done(),[key]:bad},scope));
    }
  }
  for(const bytes of [0,256*1024*1024+1]) assert.throws(()=>checkedExport({...done(),bytes},scope));
  assert.throws(()=>checkedExport({...done(),next_cursor:0},scope));
  assert.throws(()=>checkedExport({...done(),failure:'STORAGE'},scope));
  assert.throws(()=>checkedExport({...pending(),phase:'FAILED'},scope));
  assert.equal(checkedExport({...pending(),phase:'FAILED',failure:'INVALID_SOURCE'},scope).bytes,null);
  assert.equal(checkedExport({...pending(),phase:'CANCELLED'},scope).failure,null);
});
test('restored task slots contain only bounded identifiers and never restore paths, phases or unsafe scope', () => {
  assert.deepEqual(restoreExport(JSON.stringify({...scope,path:'forbidden',phase:'COMPLETED'})),scope);
  for (const value of [null,'','{','x'.repeat(2049),JSON.stringify({...scope,log_id:'..\\other'}),JSON.stringify({...scope,request_id:'00000000-0000-0000-0000-000000000000'}),JSON.stringify({...scope,connection:{...scope.connection,generation:0}}),JSON.stringify({...scope,connection:{...scope.connection,generation:Number.MAX_SAFE_INTEGER+1}})]) assert.equal(restoreExport(value),undefined);
});
