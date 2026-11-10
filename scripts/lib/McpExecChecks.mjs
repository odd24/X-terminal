import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {requestId} from '../../apps/desktop/src/request-id.ts';
import {delay} from './DesktopHarness.mjs';
export async function checkMcpExec({ui,call,success,ref,other,management,grantId,signed,lease,metrics,rebind,getRpc}){
  const checks={},count=async()=>(await metrics()).exec_calls.length;
  const start=(command='utf8',id=requestId())=>({connection:ref,request_id:id,command,timeout_ms:3000,max_output_bytes:65536});
  const get=(id,view={kind:'status'},connection=ref)=>({connection,task_id:id,view});
  const status=async id=>(await success('tasks_get',get(id))).data;
  const done=async id=>{for(let i=0;i<120;i++){const s=await status(id);if(s.phase==='FINISHED')return s;await delay(25);}throw new Error('exec did not finish within fixture deadline');};
  const deny=async(name,args,expected='INVALID_ARGUMENT')=>{const r=await call(name,args);assert.equal(r.isError,true);assert.equal(r.structuredContent.error_code,expected);};
  const before=await count();
  for(const fields of [{request_id:randomUUID()},{request_id:'019a5c00-0001-7000-c000-000000000001'},{command:''},{command:'x'.repeat(16385)},{timeout_ms:0},{timeout_ms:120001},{timeout_ms:1.5},{max_output_bytes:1048577},{path:'synthetic-file'},{role:'desktop'}])await deny('ssh_exec',{...start(),...fields});
  for(const name of ['tasks_get','tasks_cancel'])await deny(name,{...get(requestId()),...(name==='tasks_cancel'?{view:undefined}:{}),path:'synthetic-file'});
  await deny('tasks_get',get(requestId(),{kind:'raw',cursor:1,max_bytes:65536}));
  await deny('tasks_get',get(requestId(),{kind:'output',cursor:1,max_bytes:16383,through_cursor:null}));
  for(const connection of [other,{...ref,generation:ref.generation+1}])await deny('ssh_exec',{...start(),connection},'PERMISSION_DENIED');
  await deny('tasks_get',get(requestId()),'NOT_FOUND');
  assert.equal(await count(),before);checks.strict_v7_budget_fields_no_dispatch=true;
  // Drop a real MCP reply at the caller boundary after execution; never replay Start.
  const lost=start('protected-exec'),rpc=getRpc();
  const pending=rpc.begin('tools/call',{name:'ssh_exec',arguments:lost},500);rpc.discardResponse(pending.id);
  await assert.rejects(pending.promise,/RPC timeout/);assert.equal(rpc.discardedResponses,1);
  assert.equal(await count(),before+1);
  const first=await done(lost.request_id);assert.equal(first.task_id,lost.request_id);assert.equal(first.summary.exit_status,0);
  const output={kind:'output',cursor:1,max_bytes:65536,through_cursor:null};
  const info=await success('tasks_get',get(lost.request_id,output));assert.equal(info.result,'task_protected_output');
  const through=info.data.output.context.through_cursor;
  const page=await success('tasks_get',get(lost.request_id,{...output,through_cursor:through}));
  for(const stderr of [false,true]){const text=page.data.output.events.filter(e=>e.stderr===stderr).map(e=>e.text).join('');assert.ok(text.includes(stderr?'ERR_END':'OUT_END'));assert.ok(!text.includes('synthetic-secret'));}
  assert.equal(await count(),before+1);checks.lost_start_reply_only_known_task_query=true;checks.protected_both_streams=true;
  await success('input_release',{connection:ref,lease_id:lease.lease_id});
  const scopes=[{target:{kind:'connection',connection:ref},action:'EXEC'}];
  const timedId=randomUUID();await management({op:'grant_task',request_id:timedId,scopes,lifetime_ms:120000,task_id:randomUUID(),label:'synthetic exec task'});await rebind(timedId);
  await deny('tasks_get',get(lost.request_id),'PERMISSION_DENIED');await deny('tasks_cancel',{connection:ref,task_id:lost.request_id},'PERMISSION_DENIED');await deny('ssh_exec',lost,'PERMISSION_DENIED');
  assert.equal(await count(),before+1);checks.cross_owner_same_task_id_denied=true;
  const timedLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;
  const timed=start();assert.equal((await success('ssh_exec',timed)).data.task_id,timed.request_id);await done(timed.request_id);
  const raw=await success('tasks_get',get(timed.request_id,output));assert.equal(raw.result,'task_output');
  for(const stderr of [false,true])assert.ok(Buffer.from(raw.data.output.events.filter(e=>e.stderr===stderr).flatMap(e=>e.bytes)).toString('utf8').includes(stderr?'测':'中'));
  await deny('terminal_read',{connection:ref,window:null,view:{kind:'info'}},'PERMISSION_DENIED');checks.timed_exec_owner_output_without_terminal_read=true;
  await success('input_release',{connection:ref,lease_id:timedLease.lease_id});
  const single=start('protected-signal'),singleId=randomUUID();
  await management({op:'grant_protected',request_id:singleId,scopes,lifetime_ms:120000,form:{kind:'single_operation',operation:{protocol:'SSH2',request:{op:'exec',...single}}},redaction:{sensitive_fields:false,literals:['synthetic-secret']}});await rebind(singleId);
  await deny('ssh_exec',single,'INPUT_BUSY');const oneLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;
  for(const fields of [{request_id:requestId()},{command:'utf8'},{timeout_ms:3001},{max_output_bytes:65535}])await deny('ssh_exec',{...single,...fields},'PERMISSION_DENIED');
  await success('ssh_exec',single);const signal=await done(single.request_id);assert.equal(signal.summary.end,'REMOTE_SIGNAL');assert.ok(!JSON.stringify(signal).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(await success('tasks_cancel',{connection:ref,task_id:single.request_id})).includes('synthetic-secret'));
  await success('input_release',{connection:ref,lease_id:oneLease.lease_id});await success('ssh_exec',single);assert.equal(await count(),before+3);checks.single_exact_parameters_signal_and_retained_dedup=true;
  await rebind(grantId);assert.equal((await success('agent_status')).data.paired_ticket,signed.data.summary.ticket_id);
  await success('input_acquire',{connection:ref,lifetime_ms:30000});
  const stalled=start('stall');await success('ssh_exec',stalled);await rebind(grantId);
  const resumed=await status(stalled.request_id);assert.equal(resumed.task_id,stalled.request_id);
  const cancelled=await success('tasks_cancel',{connection:ref,task_id:stalled.request_id});assert.ok(['CANCELLING','FINISHED'].includes(cancelled.data.phase));await done(stalled.request_id);
  assert.equal(await count(),before+4);checks.original_ticket_after_stdio_eof_cancel_late_task=true;
  await ui.evaluate(`document.querySelector('[aria-label="MCP配对状态"]').scrollIntoView({block:'center'})`);await ui.screenshot('P15-exec-pairing-v2.png');
  return {
    async afterTakeover(){await deny('ssh_exec',start(),'PERMISSION_DENIED');assert.equal((await status(lost.request_id)).task_id,lost.request_id);checks.takeover_blocks_new_exec_keeps_owned_result=true;},
    async afterRevoke(){await deny('tasks_get',get(lost.request_id),'PERMISSION_DENIED');await deny('tasks_cancel',{connection:ref,task_id:stalled.request_id},'PERMISSION_DENIED');checks.revoked_queries_denied=true;},
    async afterServiceLoss(){await deny('tasks_get',get(lost.request_id),'UNKNOWN_DELIVERY');await deny('tasks_cancel',{connection:ref,task_id:stalled.request_id},'UNKNOWN_DELIVERY');assert.equal(await count(),before+4);checks.service_loss_no_replay=true;await writeFile('artifacts/P15-mcp-exec-result.json',JSON.stringify({result:'PASS',checks,actual_exec_calls:await count(),expected_new_exec_calls:4,model_run:false,scope:'synthetic SSH/real stdio only'},null,2)+'\n');}
  };
}
