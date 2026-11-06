import test from 'node:test';
import assert from 'node:assert/strict';
import { GrantApproval, checkedGrant, checkedList, checkedLease, checkedAudit, restoreSlot, supportedActions } from '../apps/desktop/src/agent-management.ts';
const id='11111111-1111-4111-8111-111111111111', request='22222222-2222-7222-8222-222222222222', ticket='33333333-3333-4333-8333-333333333333';
const connection={connection_id:id,generation:1}, target={...connection,protocol:'SSH2',state:'CONNECTED'};
const scope=action=>({target:{kind:'connection',connection:{...connection}},action});
const view=()=>({type:'grant',data:{summary:{request_id:request,ticket_id:ticket,expires_at_ms:300000,state:'ACTIVE',effective_scope_count:1},approved_scopes:[scope('READ'),scope('WRITE')],effective_scopes:[scope('READ')]}});

test('approval freezes independent scopes and exact service/connection generation, consumes once and invalidates',()=>{
  const approval=new GrantApproval(); const actions=['READ','WRITE']; const current={...target};
  const first=approval.prepare(ticket,current,actions,30); actions.push('EXEC');current.generation=2;
  assert.equal(first.scopes.length,2);assert.equal(first.connection.generation,1);
  assert.throws(()=>first.scopes.push(scope('EXEC')));assert.throws(()=>first.connection.generation++);
  assert.throws(()=>approval.consume(ticket,current,first));assert.throws(()=>approval.consume(ticket,target,first));
  const second=approval.prepare(ticket,target,['EXEC'],1800);assert.equal(approval.consume(ticket,target,second),second);
  assert.throws(()=>approval.consume(ticket,target,second));
  for(const altered of [{...target,generation:2},{...target,protocol:'SERIAL'},{...target,state:'FAILED'},{...target,connection_id:request}]) {
    const p=approval.prepare(ticket,target,['READ'],1);assert.throws(()=>approval.consume(ticket,altered,p));
  }
  for(const actions of [[],['READ','READ'],['CONNECT'],['BROADCAST']]) assert.throws(()=>approval.prepare(ticket,target,actions,1));
  for(const time of [0,-1,1.5,1801,NaN,Infinity]) assert.throws(()=>approval.prepare(ticket,target,['READ'],time));
  const p=approval.prepare(ticket,target,['READ'],1);approval.invalidate();assert.throws(()=>approval.consume(ticket,target,p));
  assert.deepEqual(approval.prepare(ticket,target,['CONTROL'],1).scopes,[scope('CONTROL')]);
  assert.deepEqual(supportedActions({...target,protocol:'SERIAL'}),['READ','WRITE','CONTROL','DISCONNECT']);
  for(const protocol of ['SSH2','SERIAL']) {
    const current={...target,protocol};
    const p=approval.prepare(ticket,current,['DISCONNECT'],30);
    assert.deepEqual(p.scopes,[scope('DISCONNECT')]);
    assert.equal(approval.consume(ticket,current,p),p);
    assert.throws(()=>approval.consume(ticket,current,p));
  }
  for(const protocol of ['FIXTURE','SSH1']) assert.throws(()=>approval.prepare(ticket,{...target,protocol},['DISCONNECT'],30));
});
test('grant response cannot substitute target, restore removed scope, leak token, or misstate terminal validity',()=>{
  assert.equal(checkedGrant(view(),request).summary.state,'ACTIVE');
  for(const edit of [v=>v.token='secret',v=>v.data.token='secret',v=>v.data.summary.request_id=id,v=>v.data.summary.expires_at_ms=Number.MAX_SAFE_INTEGER+1,v=>v.data.effective_scopes.push(scope('EXEC')),v=>v.data.effective_scopes[0].target.connection.generation=2,v=>v.data.summary.effective_scope_count=0,v=>v.data.summary.state='REVOKED',v=>v.data.approved_scopes.push(scope('READ')),v=>v.data.effective_scopes[0].role='desktop']) {
    const v=view();edit(v);assert.throws(()=>checkedGrant(v,request));
  }
  const ended=view();ended.data.summary.state='REVOKED';ended.data.summary.effective_scope_count=0;ended.data.effective_scopes=[];
  assert.equal(checkedGrant(ended,request).effective_scopes.length,0);
  assert.throws(()=>checkedList({type:'grant_list',data:[view().data.summary,view().data.summary]}));
});
test('restore accepts only two bounded identifiers and never persisted approval, token, phase or target',()=>{
  const slot={service_id:ticket,request_id:request};assert.deepEqual(restoreSlot(JSON.stringify(slot)),slot);
  for(const raw of [null,'{',' '.repeat(201),JSON.stringify({...slot,token:'secret'}),JSON.stringify({...slot,scopes:[scope('WRITE')]}),JSON.stringify({...slot,approved:true}),JSON.stringify({...slot,phase:'ACTIVE'}),JSON.stringify({...slot,service_id:'bad'})]) assert.equal(restoreSlot(raw),undefined);
});
test('lease exact target and bounded audit cursor/gap are checked without accepting secrets or hidden history',()=>{
  const lease={type:'lease',data:{lease_id:ticket,client_id:request,connection,expires_at_ms:100}};
  assert.equal(checkedLease(lease,connection).client_id,request);assert.throws(()=>checkedLease(lease,{...connection,generation:2}));
  const page={type:'audit',data:{events:[{seq:5,timestamp_ms:9,kind:'TAKEOVER',client_id:ticket,scope:scope('WRITE'),request_id:null,denial:null}],available_from:4,next_cursor:5,gap:true}};
  assert.equal(checkedAudit(page,0).gap,true);
  for(const edit of [v=>v.data.gap=false,v=>v.data.events[0].seq=6,v=>v.data.next_cursor=6,v=>v.data.events[0].token='secret',v=>v.data.events[0].timestamp_ms=-1]) {const v=structuredClone(page);edit(v);assert.throws(()=>checkedAudit(v,0));}
});
