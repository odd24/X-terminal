import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sameLogTarget,checkedMenu,restoreLogTask} from '../apps/desktop/src/log-menu.ts';
import {restoreSave,checkedSave} from '../apps/desktop/src/log-save.ts';
const target={service_id:randomUUID(),protocol:'SSH2',connection:{connection_id:randomUUID(),generation:1}},id=randomUUID();
test('menu receipts freeze service, protocol, generation and original operation; completed artifacts need a fingerprint',()=>{
 const info={target,request_id:id,kind:'VIEWPORT',phase:'COMPLETED',bytes:9,sha256:'a'.repeat(64),retained_records:0,retained_gap_bytes:0,failure:null,ranges:[]};assert.equal(checkedMenu(info,target,id,'VIEWPORT'),info);
 for(const changed of [{...target,service_id:randomUUID()},{...target,protocol:'SERIAL'},{...target,connection:{...target.connection,generation:2}}]){assert.equal(sameLogTarget(target,changed),false);assert.throws(()=>checkedMenu({...info,target:changed},target,id,'VIEWPORT'));}
 assert.throws(()=>checkedMenu({...info,request_id:randomUUID()},target,id,'VIEWPORT'));assert.throws(()=>checkedMenu({...info,sha256:null},target,id,'VIEWPORT'));assert.throws(()=>checkedMenu({...info,kind:'BUFFER'},target,id,'VIEWPORT'));
});
test('only original query identifiers survive reload; text, paths, auto continuation and agreement do not',()=>{
 const value={target,request_id:id,kind:'prepare',title:'服务器',pane:'second',epoch:2,subkind:'VIEWPORT',saveVisible:true,text:'never restore',path:'C:\\untrusted',auto:true,confirmation:true};const restored=restoreLogTask(JSON.stringify(value));assert.ok(restored);assert.equal(restored.request_id,id);for(const key of ['text','path','auto','confirmation'])assert.equal(key in restored,false);
 for(const changed of [{...value,target:{...target,connection:{...target.connection,generation:0}}},{...value,subkind:undefined},{...value,kind:'file',subkind:'FILE',log_id:undefined}])assert.equal(restoreLogTask(JSON.stringify(changed)),undefined);
});
test('MENU save metadata remains source and original save-ID bound without accepting caller destinations',()=>{
 const saved={scope:{mode:'MENU',connection:target.connection,log_id:id,request_id:id},save_id:randomUUID()};assert.deepEqual(restoreSave(JSON.stringify({...saved,path:'ignored'}),'MENU'),saved);
 const info={...saved,phase:'CHOOSING',cancel_requested:false,path:null,existing_bytes:null,confirmation:null,expires_at_ms:null,backup:null,staging:null,failure:null,os_code:null};assert.equal(checkedSave(info,saved),info);assert.throws(()=>checkedSave({...info,scope:{...saved.scope,connection:{...target.connection,generation:2}}},saved));
});
