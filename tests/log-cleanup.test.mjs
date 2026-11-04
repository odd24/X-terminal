import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedCleanup, checkedCleanupList, restoreCleanup, canCommitCleanup } from '../apps/desktop/src/log-cleanup.ts';
const scope={kind:'LOG',id:'11111111-1111-4111-8111-111111111111',preview_id:'22222222-2222-7222-8222-222222222222'};
const preview=()=>({result:'cleanup',...scope,phase:'PREVIEW',expires_at_ms:10000,confirmation:'33333333-3333-4333-8333-333333333333',files:[{name:'0000000000000001.rawlog',bytes:4},{name:'completion.json',bytes:10}],logical_bytes:14,report:null});
const applied=(report)=>({...preview(),phase:'APPLIED',confirmation:null,report});
test('cleanup approval requires exact scope, safe file metadata and fresh explicit consent',()=>{
  const info=checkedCleanup(preview(),scope);
  assert.equal(canCommitCleanup(info,false,9000),false);
  assert.equal(canCommitCleanup(info,true,9999),true);
  assert.equal(canCommitCleanup(info,true,10000),false);
  for(const change of [v=>v.kind='EXPORT',v=>v.id=scope.preview_id,v=>v.preview_id=scope.id,v=>v.confirmation=null,v=>v.report={},v=>v.logical_bytes++,v=>v.files[0].bytes=Number.MAX_SAFE_INTEGER+1,v=>v.files.push(v.files[0]),v=>v.phase='COMPLETED']) {const v=preview();change(v);assert.throws(()=>checkedCleanup(v,scope));}
  for(const name of ['../completion.json','completion.json:ads','<img>','0000000000000000.rawlog','00000000000000001.rawlog','18446744073709551616.rawlog','0000000000000001.text.jsonl\\bad']) {const v=preview();v.files[0].name=name;assert.throws(()=>checkedCleanup(v,scope));}
  const max=preview();max.files[0].name='18446744073709551615.text.jsonl';assert.equal(checkedCleanup(max,scope).files.length,2);
});
test('cleanup receipts preserve exact irreversible prefix rather than equating APPLIED with success',()=>{
  for(const report of [
    {removed_files:2,removed_logical_bytes:14,directory_removed:true,failure:null,os_code:null},
    {removed_files:0,removed_logical_bytes:0,directory_removed:false,failure:'CHANGED',os_code:null},
    {removed_files:1,removed_logical_bytes:4,directory_removed:false,failure:'STORAGE',os_code:5},
    {removed_files:2,removed_logical_bytes:14,directory_removed:false,failure:'STORAGE',os_code:145},
  ]) assert.deepEqual(checkedCleanup(applied(report),scope,preview()).report,report);
  const r={removed_files:1,removed_logical_bytes:4,directory_removed:false,failure:'STORAGE',os_code:5};
  for(const patch of [{removed_files:3},{removed_logical_bytes:3},{failure:null},{failure:'CHANGED'},{directory_removed:true},{os_code:2147483648}]) assert.throws(()=>checkedCleanup(applied({...r,...patch}),scope));
  for(const phase of ['EXPIRED','CANCELLED']) {const v={...preview(),phase,confirmation:null};assert.equal(canCommitCleanup(checkedCleanup(v,scope),true,1),false);}
  const changed=preview();changed.files[0].bytes++;changed.logical_bytes++;assert.throws(()=>checkedCleanup(changed,scope,preview()));
  assert.throws(()=>checkedCleanup(preview(),scope,{...preview(),phase:'EXPIRED',confirmation:null}));
});
test('cleanup recovery restores identifiers only, and directory lists cannot retarget kinds or contain unsafe IDs',()=>{
  assert.deepEqual(restoreCleanup(JSON.stringify({...preview(),reviewed:true})),scope);
  for(const v of [null,'{','x'.repeat(2049),JSON.stringify({...scope,id:'..'}),JSON.stringify({...scope,kind:'ALL'})]) assert.equal(restoreCleanup(v),undefined);
  assert.deepEqual(checkedCleanupList({result:'cleanup_list',kind:'LOG',ids:[scope.id]},'LOG'),[scope.id]);
  for(const patch of [{kind:'EXPORT'},{ids:[scope.id,scope.id]},{ids:['../bad']},{ids:Array(65).fill(scope.id)}]) assert.throws(()=>checkedCleanupList({result:'cleanup_list',kind:'LOG',ids:[],...patch},'LOG'));
  const exp={...preview(),kind:'EXPORT',files:[{name:'export.partial',bytes:14}]};assert.equal(checkedCleanup(exp,{...scope,kind:'EXPORT'}).logical_bytes,14);
  assert.throws(()=>checkedCleanup({...exp,files:preview().files},{...scope,kind:'EXPORT'}));
});
