import { ProfileGrantApproval } from '../apps/desktop/src/profile-grant.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GrantApproval, checkedGrant, checkedTask, checkedTaskReply, grantRequest, checkedList, checkedLease, checkedAudit, restoreSlot, supportedActions, scopeText, parseReadWindow } from '../apps/desktop/src/agent-management.ts';
import { OperationApproval, emptyDraft, singleActions, hexBytes, operationFingerprint, checkedOperationReply } from '../apps/desktop/src/operation-grant.ts';
import { ruleDisplay } from '../apps/desktop/src/output-protection.ts';
const id='11111111-1111-4111-8111-111111111111', request='22222222-2222-7222-8222-222222222222', ticket='33333333-3333-4333-8333-333333333333';
const connection={connection_id:id,generation:1}, target={...connection,protocol:'SSH2',state:'CONNECTED'};
const scope=action=>({target:{kind:'connection',connection:{...connection}},action});
const view=()=>({type:'grant',data:{summary:{request_id:request,ticket_id:ticket,expires_at_ms:300000,state:'ACTIVE',effective_scope_count:1},approved_scopes:[scope('READ'),scope('WRITE')],effective_scopes:[scope('READ')]}});

test('protected consent freezes exact values and task/window forms while receipts expose metadata only',()=>{
  assert.equal(ruleDisplay('prefix\u202esecret\n<tag>'), '"prefix\\u202esecret\\n<tag>"');
  for (const code of [0x061c,0x200e,0x200f,0x202a,0x202b,0x202c,0x202d,0x202e,0x2066,0x2067,0x2068,0x2069]) assert.equal(ruleDisplay(`a${String.fromCodePoint(code)}b`), `"a\\u${code.toString(16).padStart(4,'0')}b"`);
  const policy={sensitive_fields:true,literals:['  合成🔑\r\n值  ','<script>data</script>']}, a=new GrantApproval();
  const task={task_id:request,label:'有限观察'}, window={from_ms:10,until_ms:20};
  const p=a.prepare(ticket,target,['READ','WRITE'],30,window,task,policy);
  policy.literals[0]='changed';
  assert.equal(p.redaction.literals[0],'  合成🔑\r\n值  ');
  assert.throws(()=>p.redaction.literals.push('no'));
  assert.throws(()=>a.consume(ticket,target,p,task,policy));
  const q=a.prepare(ticket,target,['READ'],30,window,task,p.redaction);
  assert.equal(a.consume(ticket,target,q,task,p.redaction),q);
  const requestBody=grantRequest(request,q);
  assert.equal(requestBody.op,'grant_protected');assert.equal(requestBody.form.kind,'timed_task');
  assert.deepEqual(requestBody.scopes[0].target.window,window);
  assert.deepEqual(requestBody.redaction,p.redaction);
  const v=view();v.data.form={kind:'timed_task',...task};v.data.protection={policy_id:ticket,sensitive_fields:true,literal_count:2};
  assert.equal(checkedTaskReply(checkedGrant(v,request),task,undefined,p.redaction).protection.policy_id,ticket);
  assert.throws(()=>checkedTaskReply(checkedGrant(v,request),task));
  for(const extra of ['literals','signature','salt','token']){ const invalid=structuredClone(v);invalid.data.protection[extra]='synthetic-private';assert.throws(()=>checkedGrant(invalid,request)); }
  for(const info of [null,{policy_id:ticket,sensitive_fields:false,literal_count:0},{policy_id:ticket,sensitive_fields:true,literal_count:33},{policy_id:'bad',sensitive_fields:true,literal_count:2}]){ const invalid=structuredClone(v);invalid.data.protection=info;assert.throws(()=>checkedGrant(invalid,request)); }
  assert.throws(()=>a.prepare(ticket,target,['WRITE'],30,undefined,undefined,p.redaction));
  for(const literals of [[],[''],['duplicate','duplicate'],['中'.repeat(86)],Array.from({length:33},(_,i)=>`${i}`),['\ud800']]) assert.throws(()=>a.prepare(ticket,target,['READ'],30,undefined,undefined,{sensitive_fields:false,literals}));
  const stateOnly=a.prepare(ticket,target,['READ'],30,undefined,undefined,{sensitive_fields:true,literals:[]});
  assert.deepEqual(grantRequest(request,stateOnly).form,{kind:'scoped'});
  assert.equal(JSON.stringify(restoreSlot(JSON.stringify({service_id:ticket,request_id:request,redaction:p.redaction}))),undefined);
});

test('protected single exec binds rules independently from its complete operation hash without granting Read',async()=>{
  const policy={sensitive_fields:false,literals:['合成敏感值']}, a=new OperationApproval();
  const draft={...emptyDraft(),action:'exec',text:'synthetic-only'};
  const p=a.prepare(baseContext,draft,30,request,policy);
  assert.deepEqual(p.scopes,[scope('EXEC')]);
  assert.throws(()=>a.consume(baseContext,draft,p,{...policy,literals:['changed']}));
  const q=a.prepare(baseContext,draft,30,request,policy),fingerprint=await operationFingerprint(q.operation);
  const receipt={...view().data,approved_scopes:q.scopes,effective_scopes:q.scopes,form:{kind:'single_operation',operation:{request_id:request,fingerprint}},protection:{policy_id:ticket,sensitive_fields:false,literal_count:1}};
  assert.equal(checkedOperationReply(checkedGrant({type:'grant',data:receipt},request),q,fingerprint).protection.literal_count,1);
  assert.throws(()=>checkedOperationReply({...receipt,protection:undefined},q,fingerprint));
  assert.throws(()=>a.prepare(baseContext,{...draft,action:'write_text'},30,request,policy));
});

test('task consent binds immutable description and UUID across connection and profile forms',()=>{
  const task={task_id:request,label:'有限诊断'}, approval=new GrantApproval();
  const p=approval.prepare(ticket,target,['WRITE'],30,undefined,task);
  task.label='changed'; assert.equal(p.task.label,'有限诊断'); assert.throws(()=>p.task.label='changed');
  assert.throws(()=>approval.consume(ticket,target,p,task));
  const q=approval.prepare(ticket,target,['READ'],30,undefined,task);
  assert.equal(approval.consume(ticket,target,q,task),q);
  assert.equal(grantRequest(request,q).op,'grant_task');
  const profile={id,name:'合成配置',settings:{protocol:'ssh2',host:'example.test',port:22,username:'tester',auth:'password',encoding:'utf8'}};
  const a=new ProfileGrantApproval(), r=a.prepare(ticket,request,profile,30,undefined,task);
  assert.equal(r.task.label,'changed');
  assert.throws(()=>a.consume(ticket,request,id,r,{...task,task_id:id}));
  for(const label of ['', ' leading', 'trailing ', 'line\nfeed', '中'.repeat(86)]) assert.throws(()=>checkedTask({task_id:request,label}));
  assert.throws(()=>checkedTask({task_id:'bad',label:'task'}));
  const v=view(); v.data.form={kind:'timed_task',...task};
  assert.equal(checkedTaskReply(checkedGrant(v,request),task).form.label,'changed');
  assert.throws(()=>checkedTaskReply(checkedGrant(v,request),{...task,label:'other'}));
  assert.throws(()=>checkedTaskReply(checkedGrant(v,request),task,[scope('WRITE')]));
  const invalid=structuredClone(v);invalid.data.form.body='secret'; assert.throws(()=>checkedGrant(invalid,request));
});

const sshProfile={id,name:'合成SSH',settings:{protocol:'ssh2',host:'example.test',port:22,username:'tester',auth:'password',encoding:'utf8'}};
const serialProfile={id,name:'合成串口',settings:{protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:true,rts_on_open:false,encoding:'utf8'}};
const baseContext={service_id:ticket,target,original_profile_id:id,encoding:'utf8'};
test('single operation covers all 14 typed protocol mutations with exact minimal scopes and full visible parameters',async()=>{
  const cases=[
    ['SSH2','start','CONNECT'],['SSH2','reconnect','RECONNECT'],['SSH2','write','WRITE'],['SSH2','write_text','WRITE'],['SSH2','exec','EXEC'],['SSH2','resize','CONTROL'],['SSH2','disconnect','DISCONNECT'],['SSH2','forget_start','FORGET'],
    ['SERIAL','start','CONNECT'],['SERIAL','send','WRITE'],['SERIAL','write','WRITE'],['SERIAL','control','CONTROL'],['SERIAL','disconnect','DISCONNECT'],['SERIAL','forget_start','FORGET'],
  ];
  const hashes=new Set();
  for(const [protocol,action,permission] of cases){
    const ended=['reconnect','forget_start'].includes(action);
    const c={...baseContext,target:{...target,protocol,state:ended?'DISCONNECTED':'CONNECTED'},profile:protocol==='SSH2'?sshProfile:serialProfile,revision:request,device:{revision:ticket,device_id:request,port:'COM7'}};
    const draft={...emptyDraft(),action,text:'中\r\n  <tag>',hex:'00 ff 0d 0a',cols:91,rows:33,line:'BREAK',asserted:true,ending:'cr_lf',chunk_bytes:2,interval_ms:3};
    const a=new OperationApproval(),p=a.prepare(c,draft,30,request);
    assert.equal(p.operation.protocol,protocol);assert.equal(p.operation.request.op,action);assert.equal(p.operation.request.request_id,request);
    assert.equal(p.scopes[0].action,permission);assert.equal(p.scopes.some(s=>s.action==='READ'),false);assert.equal(p.scopes.length,action==='reconnect'?2:1);
    assert.throws(()=>p.operation.request.request_id=ticket);assert.throws(()=>p.scopes.push(scope('READ')));
    const description=JSON.stringify(p.description);assert.ok(description.includes(request));
    if(protocol==='SERIAL'&&action==='start'){assert.match(description,/初始DTR 开启/);assert.match(description,/初始RTS 关闭/);assert.ok(description.includes(ticket));}
    const fingerprint=await operationFingerprint(p.operation); hashes.add(fingerprint);
    const v=view();v.data.approved_scopes=structuredClone(p.scopes);v.data.effective_scopes=structuredClone(p.scopes);v.data.summary.effective_scope_count=p.scopes.length;
    v.data.form={kind:'single_operation',operation:{request_id:request,fingerprint}};
    assert.equal(checkedOperationReply(checkedGrant(v,request),p,fingerprint),v.data);
    assert.throws(()=>checkedOperationReply(checkedGrant(v,request),p,'0'.repeat(64)));
    assert.equal(a.consume(c,draft,p),p);assert.throws(()=>a.consume(c,draft,p));
  }
  assert.equal(hashes.size,14,'protocol and mutation kind are part of the canonical fingerprint');
});
test('single previews cannot survive any operation edit, target/state/source/version/device change',()=>{
  const contexts=[
    {c:baseContext,d:{...emptyDraft(),action:'write_text',text:'literal\r\n'}},
    {c:{...baseContext,target:{...target,state:'DISCONNECTED'},profile:sshProfile,revision:request},d:{...emptyDraft(),action:'reconnect'}},
    {c:{...baseContext,profile:serialProfile,revision:request,device:{revision:ticket,device_id:request,port:'COM7'}},d:{...emptyDraft(),action:'start'}},
  ];
  for(const {c,d} of contexts){
    const edits=[x=>x.service_id=id];
    if(d.action!=='start') edits.push(x=>x.target={...x.target,generation:2},x=>x.target={...x.target,state:'FAILED'});
    if(d.action==='write_text') edits.push(x=>x.encoding='gbk');
    if(['start','reconnect'].includes(d.action)) edits.push(x=>x.revision=id,x=>x.profile={...x.profile,name:'changed'});
    if(d.action==='start') edits.push(x=>x.device={...x.device,revision:id},x=>x.device={...x.device,device_id:id});
    for(const edit of edits){
      const a=new OperationApproval(),p=a.prepare(c,d,30,request),changed=structuredClone(c);edit(changed);
      assert.throws(()=>a.consume(changed,d,p));
    }
    const a=new OperationApproval(),p=a.prepare(c,d,30,request);assert.throws(()=>a.consume(c,{...d,text:'changed'},p));
    const q=a.prepare(c,d,30,request);a.invalidate();assert.throws(()=>a.consume(c,d,q));
  }
  const a=new OperationApproval();
  assert.throws(()=>a.prepare({...baseContext,profile:serialProfile,revision:request,device:{revision:ticket,device_id:request,port:'COM8'}},{...emptyDraft(),action:'start'},30,request));
  assert.throws(()=>a.prepare({...baseContext,target:{...target,state:'DISCONNECTED'},profile:sshProfile,original_profile_id:ticket,revision:request},{...emptyDraft(),action:'reconnect'},30,request));
});
test('single malformed payloads, legacy actions and incompatible state never produce approval',()=>{
  const a=new OperationApproval();
  assert.deepEqual(singleActions(),['start']);assert.equal(emptyDraft().action,'');
  for(const patch of [{action:'write',hex:'0'},{action:'write',hex:'GG'},{action:'exec',text:'bad\0'},{action:'exec',text:'ok',max_output_bytes:0},{action:'resize',cols:1},{action:'exec',text:'ok',timeout_ms:86400001},{action:'close'},{action:'authenticate'},{action:''}]) assert.throws(()=>a.prepare(baseContext,{...emptyDraft(),...patch},30,request));
  assert.throws(()=>a.prepare({...baseContext,encoding:undefined},{...emptyDraft(),action:'write_text',text:'ok'},30,request));
  for(const patch of [{text:'',ending:'none'},{text:'01',format:'hex',chunk_bytes:0},{text:'ff '.repeat(65536),format:'hex',ending:'cr'},{text:'x'.repeat(102),chunk_bytes:1,interval_ms:1000}]) assert.throws(()=>a.prepare({...baseContext,target:{...target,protocol:'SERIAL'}},{...emptyDraft(),action:'send',...patch},30,request));
  const p=a.prepare({...baseContext,target:{...target,protocol:'SERIAL'}},{...emptyDraft(),action:'send',format:'hex',text:'',ending:'cr'},30,request);assert.equal(p.operation.request.content,'');
  assert.deepEqual(hexBytes('00 ff\r\n0A'),[0,255,10]);
});
test('single response metadata rejects broad read, self-declared data, uppercase digest and incomplete reconnect scope',()=>{
  const v=view();v.data.approved_scopes=[scope('WRITE')];v.data.effective_scopes=[scope('WRITE')];v.data.form={kind:'single_operation',operation:{request_id:request,fingerprint:'a'.repeat(64)}};
  assert.equal(checkedGrant(v,request).form.kind,'single_operation');
  for(const edit of [x=>x.data.form.operation.fingerprint='A'.repeat(64),x=>x.data.form.operation.request_id='bad',x=>x.data.form.body='secret',x=>x.data.form.operation.token='secret',x=>x.data.form=null,x=>x.data.form={kind:'scoped'},x=>{x.data.approved_scopes=[scope('READ')];x.data.effective_scopes=[scope('READ')];},x=>{x.data.approved_scopes=[scope('RECONNECT')];x.data.effective_scopes=[scope('RECONNECT')];}]){const changed=structuredClone(v);edit(changed);assert.throws(()=>checkedGrant(changed,request));}
});

test('time-window metadata is strict, preserves exact approved limits and names the reconstructed view',()=>{
  const windowScope={target:{kind:'output_window',connection,window:{from_ms:1000,until_ms:2000}},action:'READ'};
  const value=view();value.data.approved_scopes=[windowScope];value.data.effective_scopes=[structuredClone(windowScope)];
  assert.equal(checkedGrant(value,request).effective_scopes[0].target.window.until_ms,2000);
  assert.match(scopeText(windowScope),/北京时间.*时间窗重建/);
  for(const edit of [v=>v.data.effective_scopes[0].target.window.until_ms++,v=>v.data.approved_scopes[0].action='WRITE',v=>v.data.approved_scopes[0].target.window.until_ms=1000,v=>v.data.approved_scopes[0].target.window.from_ms=-1,v=>v.data.approved_scopes[0].target.window.until_ms=Number.MAX_SAFE_INTEGER,v=>v.data.approved_scopes[0].target.window.extra=true]) {
    const v=structuredClone(value);edit(v);assert.throws(()=>checkedGrant(v,request));
  }
});

test('time-window consent freezes explicit Beijing times without granting full Read or changing write scope',()=>{
  const window=parseReadWindow('2026-11-07T00:00:00.123','2026-11-07T00:01:00.456');
  assert.equal(window.from_ms,Date.parse('2026-11-06T16:00:00.123Z'));
  const approval=new GrantApproval();
  const p=approval.prepare(ticket,target,['READ','WRITE'],30,window);
  window.until_ms++;
  assert.equal(p.scopes[0].target.kind,'output_window');
  assert.equal(p.scopes[0].target.window.until_ms,Date.parse('2026-11-06T16:01:00.456Z'));
  assert.deepEqual(p.scopes[1],scope('WRITE'));
  assert.throws(()=>p.scopes[0].target.window.from_ms++);
  assert.equal(approval.consume(ticket,target,p),p);
  assert.throws(()=>approval.consume(ticket,target,p));
  assert.throws(()=>approval.prepare(ticket,target,['WRITE'],30,window));
  for(const protocol of ['SSH2','SERIAL']) {
    const ended={...target,protocol,state:'DISCONNECTED'};
    const q=approval.prepare(ticket,ended,['READ'],30,window);
    assert.equal(q.scopes[0].target.kind,'output_window');
    assert.equal(approval.consume(ticket,ended,q),q);
    const pending=approval.prepare(ticket,ended,['READ'],30,window);
    assert.throws(()=>approval.consume(ticket,{...ended,state:'FAILED'},pending));
  }
  for(const [from,until] of [['',''],['2026-02-30T00:00','2026-03-03T00:00'],['2026-11-07T00:00','2026-11-07T00:00'],['2026-11-07T00:01','2026-11-07T00:00'],['2026-11-07T24:00','2026-11-08T01:00'],['2026-11-07T00:00Z','2026-11-07T00:01']]) assert.throws(()=>parseReadWindow(from,until));
});

test('reconnect receipts remain readable without exposing an incomplete combined approval UI',()=>{
  const v=view();v.data.approved_scopes=[scope('RECONNECT')];v.data.effective_scopes=[scope('RECONNECT')];
  assert.equal(checkedGrant(v,request).effective_scopes[0].action,'RECONNECT');
  assert.equal(supportedActions(target).includes('RECONNECT'),false);
  assert.equal(supportedActions({...target,state:'DISCONNECTED'}).includes('RECONNECT'),false);
});

test('forget approval is confined to ended SSH2 and SERIAL generations and consumes once',()=>{
  const v=view();v.data.approved_scopes=[scope('FORGET')];v.data.effective_scopes=[scope('FORGET')];
  assert.equal(checkedGrant(v,request).effective_scopes[0].action,'FORGET');
  for(const protocol of ['SSH2','SERIAL']) for(const state of ['DISCONNECTED','FAILED']) {
    const current={...target,protocol,state}; const approval=new GrantApproval();
    assert.deepEqual(supportedActions(current),['READ','FORGET']);
    const p=approval.prepare(ticket,current,['FORGET'],30);
    assert.deepEqual(p.scopes,[scope('FORGET')]);
    assert.equal(approval.consume(ticket,current,p),p);
    assert.throws(()=>approval.consume(ticket,current,p));
    for(const changed of [{...current,generation:2},{...current,state:'CONNECTED'},{...current,connection_id:request}]) {
      const q=approval.prepare(ticket,current,['FORGET'],1);assert.throws(()=>approval.consume(ticket,changed,q));
    }
    assert.throws(()=>approval.prepare(ticket,current,['FORGET','DISCONNECT'],1));
  }
  for(const current of [target,{...target,state:'CLOSING'},{...target,protocol:'SSH1',state:'FAILED'},{...target,protocol:'FIXTURE',state:'DISCONNECTED'}]) assert.throws(()=>new GrantApproval().prepare(ticket,current,['FORGET'],1));
});

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

test('profile approval freezes version and opening policy, never authorizes connection actions, consumes once',()=>{
  const approval=new ProfileGrantApproval();
  const profile={id,name:'合成串口',settings:{protocol:'serial',port:'COM7',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:true,rts_on_open:false,encoding:'utf8'}};
  const p=approval.prepare(ticket,request,profile,30);
  profile.settings.dtr_on_open=false;profile.name='changed';
  assert.equal(p.name,'合成串口');assert.ok(p.description.includes('初始DTR 开启'));assert.ok(p.description.includes('初始RTS 关闭'));
  assert.deepEqual(p.scopes,[{target:{kind:'profile_revision',profile_id:id,revision:request},action:'CONNECT'}]);
  assert.throws(()=>p.scopes[0].target.revision=id);
  assert.equal(approval.consume(ticket,request,id,p),p);assert.throws(()=>approval.consume(ticket,request,id,p));
  for(const [service,rev,selected] of [[id,request,id],[ticket,id,id],[ticket,request,ticket]]) {const q=approval.prepare(ticket,request,profile,1);assert.throws(()=>approval.consume(service,rev,selected,q));}
  assert.throws(()=>approval.prepare(ticket,request,{...profile,settings:{protocol:'ssh1'}},1));
  const q=approval.prepare(ticket,request,profile,1);approval.invalidate();assert.throws(()=>approval.consume(ticket,request,id,q));
  const v=view();v.data.approved_scopes=p.scopes;v.data.effective_scopes=structuredClone(p.scopes);
  assert.equal(checkedGrant(v,request).effective_scopes[0].target.revision,request);
  v.data.effective_scopes[0].target.revision=id;assert.throws(()=>checkedGrant(v,request));
});

test('SSH reconnect approval freezes both exact old generation and fixed profile revision as one consent',()=>{
  const approval=new ProfileGrantApproval();
  const profile={id,name:'合成SSH',settings:{protocol:'ssh2',host:'example.test',port:22,username:'tester',auth:'agent',encoding:'utf8'}};
  const old={...target,state:'DISCONNECTED',profile_id:id};
  const p=approval.prepare(ticket,request,profile,45,old);
  old.generation=2; profile.name='changed';
  assert.equal(p.name,'合成SSH'); assert.equal(p.lifetime_ms,45000);
  assert.deepEqual(p.scopes,[
    {target:{kind:'connection',connection:{connection_id:id,generation:1}},action:'RECONNECT'},
    {target:{kind:'profile_revision',profile_id:id,revision:request},action:'CONNECT'},
  ]);
  assert.equal(approval.consume(ticket,request,id,p),p);
  const v=view();v.data.approved_scopes=p.scopes;v.data.effective_scopes=structuredClone(p.scopes);v.data.summary.effective_scope_count=2;
  assert.equal(checkedGrant(v,request).effective_scopes.length,2);
  assert.throws(()=>approval.prepare(ticket,request,profile,45,{...target,profile_id:id}));
  assert.throws(()=>approval.prepare(ticket,request,profile,45,{...old,protocol:'SERIAL',state:'FAILED'}));
  assert.throws(()=>approval.prepare(ticket,request,profile,45,{...old,profile_id:ticket}));
  assert.throws(()=>approval.prepare(ticket,request,profile,45,{...old,connection_id:'bad'}));
  assert.throws(()=>approval.prepare(ticket,request,profile,45,{...old,generation:0}));
});
