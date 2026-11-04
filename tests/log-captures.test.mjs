import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedCaptures, checkedCapture } from '../apps/desktop/src/log-captures.ts';
const info=()=>({log_id:'11111111-1111-4111-8111-111111111111',connection:{connection_id:'22222222-2222-4222-8222-222222222222',generation:3},protocol:'FIXTURE',encoding:'utf-8',phase:'FAILED',failure:'STORAGE',active:false,durable:false,worker_finished:true,natural_end:false,limits:{segment_bytes:131072,segments:2},...Object.fromEntries(['started_at_ms','source_cursor','text_cursor','accepted_records','written_records','accepted_raw_bytes','written_raw_bytes','rejected_records','rejected_raw_bytes','source_gap_bytes','first_retained_segment','last_segment','retired_segments'].map(key=>[key,1]))});
test('capture inventory bounds targets and rejects unsafe scopes or display counts before maintenance',()=>{
  assert.equal(checkedCaptures({result:'list',logs:[info()]}).length,1);
  const changed=info();changed.connection.generation++;
  assert.throws(()=>checkedCaptures({result:'list',logs:[changed]},[info()]));
  for(const logs of [[info(),info()],Array(65).fill(info())])assert.throws(()=>checkedCaptures({result:'list',logs}));
  for(const change of [v=>v.log_id='../bad',v=>v.connection.generation=0,v=>v.connection.generation=Number.MAX_SAFE_INTEGER+1,v=>v.phase='UNKNOWN',v=>v.failure=null,v=>v.written_raw_bytes=Number.MAX_SAFE_INTEGER+1,v=>v.worker_finished='yes',v=>v.limits.segments=17,v=>v.protocol='<img>']){const v=info();change(v);assert.throws(()=>checkedCaptures({result:'list',logs:[v]}));}
});
test('maintenance replies cannot follow active connection changes or invent a completed release',()=>{
  const target=info();const released={...target,result:'info',phase:'RELEASED'};
  assert.equal(checkedCapture(released,target.connection,target.log_id).phase,'RELEASED');
  for(const patch of [{active:true},{durable:true},{worker_finished:false},{failure:null}])assert.throws(()=>checkedCapture({...released,...patch},target.connection,target.log_id));
  assert.throws(()=>checkedCapture(released,{...target.connection,generation:4},target.log_id));
  assert.throws(()=>checkedCapture(released,target.connection,target.connection.connection_id));
  assert.throws(()=>checkedCapture({...released,result:'list'},target.connection,target.log_id));
  assert.equal(checkedCapture({...released,phase:'REMOVED'},target.connection,target.log_id).phase,'REMOVED');
});
