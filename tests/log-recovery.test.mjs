import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRecoveryInfo, checkedRecoveryList, checkedRecoveryPage, sameRecoveryInfo, recoveryStopText } from '../apps/desktop/src/log-recovery.ts';
const scope = { connection: { connection_id:'11111111-1111-4111-8111-111111111111', generation:3 }, log_id:'22222222-2222-4222-8222-222222222222', read_id:'33333333-3333-7333-8333-333333333333' };
const info = () => ({ log_id:scope.log_id, connection:{...scope.connection}, protocol:'SERIAL', encoding:'utf-8', started_at_ms:1, source_cursor:1, text_cursor:1, limits:{segment_bytes:131072,segments:2}, first_segment:1, last_observed_segment:1, available_from:1, source_available_from:1, completion_present:false, partial_present:true });
const record = () => ({ raw:{seq:1,timestamp_ms:5,bytes:[0,255,13,10]}, text:{seq:1,source_seq:1,timestamp_ms:5,text:'中文\0\x1b<img>',decode_error:false,gap_bytes:null} });
const page = () => ({ result:'recovery_page',...structuredClone(scope),cursor:1,next_cursor:2,available_from:1,source_available_from:1,records:[record()],stop:{kind:'TRUNCATED_RECORD',segment:1,next_cursor:2} });

test('recovery catalogue validates exact identities, safe metadata and bounded distinct entries', () => {
  assert.equal(checkedRecoveryList({result:'recovery_list',logs:[{log_id:scope.log_id,info:info()}]}).length,1);
  assert.equal(sameRecoveryInfo(checkedRecoveryInfo(info()),info()),true);
  for(const edit of [v=>v.connection.generation=0,v=>v.source_available_from=0,v=>v.available_from=2,v=>v.limits.segments=17,v=>v.started_at_ms=Number.MAX_SAFE_INTEGER+1,v=>v.log_id='../other',v=>v.completion_present='yes']) {
    const value=info();edit(value);assert.throws(()=>checkedRecoveryInfo(value));
  }
  assert.throws(()=>checkedRecoveryList({result:'recovery_list',logs:Array(65).fill({log_id:scope.log_id,info:null})}));
  assert.throws(()=>checkedRecoveryList({result:'recovery_list',logs:Array(2).fill({log_id:scope.log_id,info:null})}));
  const changed=info();changed.partial_present=false;assert.equal(sameRecoveryInfo(changed,info()),false);
  const mismatch=info();mismatch.log_id=scope.read_id;
  assert.throws(()=>checkedRecoveryList({result:'recovery_list',logs:[{log_id:scope.log_id,info:mismatch}]}));
});
test('recovery pages freeze scope and cursor, reject fabricated completion and preserve explicit stop reasons', () => {
  const verified=checkedRecoveryPage(page(),scope,info(),1,1,false);
  assert.equal(verified.source,2);assert.equal(verified.page.records.length,1);
  assert.match(recoveryStopText(verified.page.stop),/不代表日志完整/);
  for(const edit of [v=>v.connection.generation++,v=>v.log_id=scope.read_id,v=>v.cursor=2,v=>v.available_from=2,v=>v.next_cursor=Number.MAX_SAFE_INTEGER+1,v=>v.next_cursor=3,v=>v.finished=true,v=>v.stop.kind='COMPLETED',v=>v.stop.next_cursor=3,v=>v.stop.segment=2]) {
    const value=page();edit(value);assert.throws(()=>checkedRecoveryPage(value,scope,info(),1,1,false));
  }
  const empty={...page(),cursor:2,next_cursor:2,records:[],stop:{kind:'END_OF_AVAILABLE',segment:1,next_cursor:2}};
  assert.equal(checkedRecoveryPage(empty,scope,info(),2,2,true).page.records.length,0);
  assert.throws(()=>checkedRecoveryPage({...empty,stop:null},scope,info(),2,2,true));
});
test('recovery raw and text payloads must be paired, bounded and monotonic including gaps and flush', () => {
  for(const edit of [v=>v.records[0].raw.seq++,v=>v.records[0].text.source_seq++,v=>v.records[0].raw.timestamp_ms++,v=>v.records[0].raw.bytes=[256],v=>v.records[0].raw.bytes=[],v=>v.records[0].raw.bytes=Array(4097).fill(1),v=>v.records[0].text.text='中'.repeat(5462),v=>v.records[0].text.gap_bytes=5,v=>v.records[0].text.seq++]) {
    const value=page();edit(value);assert.throws(()=>checkedRecoveryPage(value,scope,info(),1,1,false));
  }
  const gap=page();gap.records[0].raw.bytes=[];gap.records[0].raw.gap_bytes=7;
  Object.assign(gap.records[0].text,{text:'',gap_bytes:7});
  assert.equal(checkedRecoveryPage(gap,scope,info(),1,1,false).source,2);
  const flush=page();flush.records[0].raw=null;flush.records[0].text.source_seq=null;
  assert.equal(checkedRecoveryPage(flush,scope,info(),1,1,false).flushed,true);
  assert.throws(()=>checkedRecoveryPage(page(),scope,info(),1,1,true));
});
