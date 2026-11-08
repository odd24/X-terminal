import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSave, restoreSave, terminalSave } from '../apps/desktop/src/log-save.ts';
const target={scope:{mode:'NORMAL',connection:{connection_id:'11111111-1111-4111-8111-111111111111',generation:3},log_id:'22222222-2222-4222-8222-222222222222',request_id:'33333333-3333-7333-8333-333333333333'},save_id:'44444444-4444-7444-8444-444444444444'};
const pending=()=>({...structuredClone(target),phase:'CHOOSING',cancel_requested:false,path:null,existing_bytes:null,confirmation:null,expires_at_ms:null,backup:null,staging:null,failure:null,os_code:null});
const prepared=()=>({...pending(),phase:'AWAITING_CONFIRMATION',path:'C:\\synthetic\\chosen.jsonl',existing_bytes:'18446744073709551615',confirmation:'55555555-5555-4555-8555-555555555555',expires_at_ms:10000});
test('save replies remain bound to the original source generation and native task identifier',()=>{
  assert.equal(terminalSave(checkedSave(pending(),target)),false);assert.equal(terminalSave(checkedSave(prepared(),target)),false);
  for(const change of [v=>v.scope.connection.generation++,v=>v.scope.request_id=target.save_id,v=>v.save_id=target.scope.log_id,v=>v.phase='UNKNOWN',v=>v.cancel_requested='yes',v=>v.path='C:\\bad\0name']){const v=prepared();change(v);assert.throws(()=>checkedSave(v,target));}
});
test('overwrite approval is ephemeral and recovery is distinct from successful publication',()=>{
  for(const patch of [{confirmation:null},{expires_at_ms:null},{existing_bytes:null},{existing_bytes:'18446744073709551616'},{existing_bytes:'1.5'},{existing_bytes:'01'},{expires_at_ms:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>checkedSave({...prepared(),...patch},target));
  const complete={...pending(),phase:'COMPLETED',path:'C:\\synthetic\\chosen.jsonl',backup:'C:\\synthetic\\backup'};
  assert.equal(terminalSave(checkedSave(complete,target)),true);
  for(const patch of [{failure:'PUBLISH'},{os_code:5},{staging:'C:\\synthetic\\partial'},{confirmation:prepared().confirmation},{path:null}])assert.throws(()=>checkedSave({...complete,...patch},target));
  const recovery={...complete,phase:'RECOVERY_REQUIRED',failure:'PUBLISH',os_code:183};assert.equal(checkedSave(recovery,target).phase,'RECOVERY_REQUIRED');assert.throws(()=>checkedSave({...recovery,backup:null},target));
  assert.throws(()=>checkedSave({...prepared(),path:'C:\\other.jsonl'},target,prepared()));
  assert.throws(()=>checkedSave({...prepared(),expires_at_ms:11000},target,prepared()));
  assert.throws(()=>checkedSave({...complete,phase:'COPYING'},target,complete));
});
test('reload restores identifiers only, never a destination, confirmation nonce or permission',()=>{
  assert.deepEqual(restoreSave(JSON.stringify({...prepared(),reviewed:true})),target);
  for(const raw of [null,'{','x'.repeat(4097),JSON.stringify({...target,save_id:'..'}),JSON.stringify({...target,scope:{...target.scope,connection:{...target.scope.connection,generation:0}}})])assert.equal(restoreSave(raw),undefined);
});

 test('save source modes are mandatory, immutable and restored without permission',()=>{
   const recovery=structuredClone(target); recovery.scope.mode='RECOVERY';
   const reply={...prepared(),scope:recovery.scope};
   assert.equal(checkedSave(reply,recovery).scope.mode,'RECOVERY');
   assert.throws(()=>checkedSave(reply,target));
   assert.throws(()=>checkedSave(prepared(),recovery));
   assert.deepEqual(restoreSave(JSON.stringify({...reply,reviewed:true})),recovery);
   for(const mode of [undefined,'NORMALIZED',null]){
     const bad=structuredClone(target);bad.scope.mode=mode;
     assert.equal(restoreSave(JSON.stringify(bad)),undefined);
     assert.throws(()=>checkedSave({...prepared(),scope:bad.scope},target));
   }
 });

test('ordinary and recovery save slots cannot restore each other, including fabricated approval',()=>{
  const recovery={...prepared(),scope:{...target.scope,mode:'RECOVERY'},reviewed:true};
  assert.equal(restoreSave(JSON.stringify(recovery),'NORMAL'),undefined);
  assert.equal(restoreSave(JSON.stringify(prepared()),'RECOVERY'),undefined);
  assert.deepEqual(restoreSave(JSON.stringify(recovery),'RECOVERY'),{...target,scope:recovery.scope});
});

test('text save retains only IDs and rejects JSONL or recovery sources with identical IDs',()=>{
  const text={...target,scope:{...target.scope,mode:'TEXT'}};
  const info={...prepared(),scope:text.scope};
  assert.deepEqual(restoreSave(JSON.stringify({...info,reviewed:true}),'TEXT'),text);
  assert.equal(checkedSave(info,text).scope.mode,'TEXT');
  for(const mode of ['NORMAL','RECOVERY']) {
    assert.equal(restoreSave(JSON.stringify(info),mode),undefined);
    assert.throws(()=>checkedSave({...info,scope:{...text.scope,mode}},text));
    assert.equal(restoreSave(JSON.stringify({...info,scope:{...text.scope,mode}}),'TEXT'),undefined);
  }
});
