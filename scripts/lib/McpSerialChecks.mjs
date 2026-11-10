import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requestId} from '../../apps/desktop/src/request-id.ts';
import {delay} from './DesktopHarness.mjs';
export async function checkMcpSerial({directory,ui,call,success,ref,other,management,grantId,signed,lease,rebind,getRpc,evidence}){
 const checks={};
 const snapshot=async()=>{for(let i=0;i<100;i++){try{const v=JSON.parse(await readFile(path.join(directory,'serial-mcp-controller.json'),'utf8'));assert.equal(v.version,1);assert.ok(Number.isInteger(v.write_calls)&&v.write_calls<=128);assert.ok(Number.isInteger(v.control_calls)&&v.control_calls<=128);assert.ok(v.controls.length<=64);assert.deepEqual(Object.keys(v).sort(),['version','opened','write_calls','write_bytes','control_calls','controls','dtr','rts','break_asserted'].sort());return v;}catch(e){if(!(e instanceof SyntaxError)&&e.code!=='ENOENT')throw e;await delay(5);}}throw new Error('bounded controller snapshot observation failed');};
 const raw=async()=>{const p=await ui.invoke('service_read',{connection:ref,cursor:1});assert.equal(p.truncated,false);assert.ok(p.events.every(e=>e.gap_bytes==null));return Buffer.from(p.events.flatMap(e=>e.bytes));};
 const wr=(bytes=[0,255,3,4,13,10,27,127],request_id=requestId())=>({connection:ref,request_id,bytes});
 const ctl=(line='DTR',asserted=true,request_id=requestId())=>({connection:ref,request_id,line,asserted});
 const query=async(id,connection=ref)=>success('terminal_input_status',{transport:'SERIAL',connection,request_id:id});
 const done=async(id,state)=>{for(let i=0;i<100;i++){const r=(await query(id)).data;if(r.state!=='PENDING'){assert.equal(r.state,state);assert.equal(r.request_id,id);return r;}await delay(10);}throw new Error('serial receipt did not complete');};
 const deny=async(name,args,code='INVALID_ARGUMENT')=>{const r=await call(name,args);assert.equal(r.isError,true);assert.equal(r.structuredContent.error_code,code);};
 const baseline=await snapshot();assert.equal(baseline.opened,1);assert.equal(baseline.control_calls,0);assert.equal(baseline.controls.length,0);
 await success('input_release',{connection:ref,lease_id:lease.lease_id});
 await deny('serial_write',wr(),'INPUT_BUSY');await deny('serial_control',ctl(),'INPUT_BUSY');
 for(const bytes of [[],[-1],[256],[1.5],Array(16385).fill(0),'00ff'])await deny('serial_write',wr(bytes));
 for(const fields of [{line:'PULSE'},{line:'dtr'},{asserted:1},{asserted:null},{duration_ms:10},{port:'COM89'},{protected:false}])await deny('serial_control',{...ctl(),...fields});
 const missing=ctl();delete missing.asserted;await deny('serial_control',missing);
 await deny('serial_write',{...wr(),encoding:'utf8'});await deny('serial_write',{...wr(),ending:'crlf'});
 for(const connection of [other,{...ref,generation:ref.generation+1}]){
   await deny('serial_write',{...wr(),connection},'PERMISSION_DENIED');await deny('serial_control',{...ctl(),connection},'PERMISSION_DENIED');
 }
 assert.deepEqual(await snapshot(),baseline);checks.strict_bytes_fields_no_default_or_no_lease_dispatch=true;
 let activeLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;
 const validateBound=(r,args)=>{assert.equal(r.result,'serial_operation');assert.deepEqual(r.data.connection,args.connection);assert.equal(r.data.receipt.request_id,args.request_id);};
 const lost=async(name,args)=>{const rpc=getRpc(),p=rpc.begin('tools/call',{name,arguments:args},500);rpc.discardResponse(p.id);const before=rpc.discardedResponses;await assert.rejects(p.promise,/RPC timeout/);assert.equal(rpc.discardedResponses,before+1);};
 const firstWrite=wr(),beforeRaw=await raw();await lost('serial_write',firstWrite);const written=await done(firstWrite.request_id,'DRIVER_ACCEPTED');assert.equal(written.driver_accepted,firstWrite.bytes.length);
 assert.deepEqual((await raw()).subarray(beforeRaw.length),Buffer.from(firstWrite.bytes));
 const afterWrite=await snapshot();assert.equal(afterWrite.write_calls,baseline.write_calls+1);assert.equal(afterWrite.write_bytes,baseline.write_bytes+firstWrite.bytes.length);
 const firstControl=ctl();await lost('serial_control',firstControl);await done(firstControl.request_id,'CONTROL_APPLIED');const afterControl=await snapshot();assert.deepEqual(afterControl.controls,[{line:'DTR',asserted:true}]);assert.equal(afterControl.control_calls,1);assert.equal(afterControl.dtr,true);
 for(let i=0;i<3;i++){await query(firstControl.request_id);await query(firstWrite.request_id);}assert.deepEqual(await snapshot(),afterControl);
 for(const connection of [other,{...ref,generation:ref.generation+1}])await deny('terminal_input_status',{transport:'SERIAL',connection,request_id:firstWrite.request_id},'PERMISSION_DENIED');
 await deny('serial_control',ctl('DTR',false,firstWrite.request_id));await deny('serial_write',wr([1],firstControl.request_id));await deny('serial_control',ctl('RTS',true,firstControl.request_id));await deny('serial_control',ctl('DTR',false,firstControl.request_id));assert.deepEqual(await snapshot(),afterControl);
 checks.real_write_and_control_reply_loss_query_only=true;checks.exact_zero_ff_control_bytes=true;checks.original_id_cannot_change_action=true;
 for(const args of [ctl('RTS',true),ctl('BREAK',true),ctl('BREAK',false)]){validateBound(await success('serial_control',args),args);await done(args.request_id,'CONTROL_APPLIED');}
 const stable=await snapshot();assert.deepEqual(stable.controls,[{line:'DTR',asserted:true},{line:'RTS',asserted:true},{line:'BREAK',asserted:true},{line:'BREAK',asserted:false}]);assert.equal(stable.control_calls,4);assert.equal(stable.break_asserted,false);
 await success('input_release',{connection:ref,lease_id:activeLease.lease_id});
 const grant=async(action,operation)=>{const id=randomUUID(),scopes=[{target:{kind:'connection',connection:ref},action}];await management(operation?{op:'grant_operation',request_id:id,scopes,lifetime_ms:120000,operation:{protocol:'SERIAL',request:operation}}:{op:'grant',request_id:id,scopes,lifetime_ms:120000});const before=await snapshot();await rebind(id);assert.deepEqual(await snapshot(),before);return id;};
 await grant('WRITE');activeLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;
 await deny('serial_control',ctl(),'PERMISSION_DENIED');await deny('terminal_input_status',{transport:'SERIAL',connection:ref,request_id:firstWrite.request_id},'PERMISSION_DENIED');
 const writeOnly=wr([7,0,255]);validateBound(await success('serial_write',writeOnly),writeOnly);await done(writeOnly.request_id,'DRIVER_ACCEPTED');await success('input_release',{connection:ref,lease_id:activeLease.lease_id});
 await grant('CONTROL');activeLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;await deny('serial_write',wr(),'PERMISSION_DENIED');const controlOnly=ctl('DTR',false);validateBound(await success('serial_control',controlOnly),controlOnly);await done(controlOnly.request_id,'CONTROL_APPLIED');await success('input_release',{connection:ref,lease_id:activeLease.lease_id});checks.write_control_independent_and_cross_owner_denied=true;
 const singleControl=ctl();await grant('CONTROL',{op:'control',...singleControl});await deny('serial_control',singleControl,'INPUT_BUSY');activeLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;
 for(const fields of [{request_id:requestId()},{line:'RTS'},{asserted:false}])await deny('serial_control',{...singleControl,...fields},'PERMISSION_DENIED');
 validateBound(await success('serial_control',singleControl),singleControl);await done(singleControl.request_id,'CONTROL_APPLIED');const one=await snapshot();await success('serial_control',singleControl);assert.deepEqual(await snapshot(),one);await success('input_release',{connection:ref,lease_id:activeLease.lease_id});
 const singleWrite=wr([0,255,17,19]);await grant('WRITE',{op:'write',...singleWrite});activeLease=(await success('input_acquire',{connection:ref,lifetime_ms:30000})).data;
 for(const fields of [{request_id:requestId()},{bytes:[1]}])await deny('serial_write',{...singleWrite,...fields},'PERMISSION_DENIED');const pre=await raw();validateBound(await success('serial_write',singleWrite),singleWrite);await done(singleWrite.request_id,'DRIVER_ACCEPTED');assert.deepEqual((await raw()).subarray(pre.length),Buffer.from(singleWrite.bytes));await success('input_release',{connection:ref,lease_id:activeLease.lease_id});checks.single_complete_parameters_and_bound_receipts=true;
 await rebind(grantId);assert.equal((await success('agent_status')).data.paired_ticket,signed.data.summary.ticket_id);await success('input_acquire',{connection:ref,lifetime_ms:30000});
 const protectedInfo=await success('terminal_read',{connection:ref,window:null,view:{kind:'info'}});assert.equal(protectedInfo.result,'protected_context');await deny('terminal_read',{connection:ref,window:null,view:{kind:'raw'}});checks.protected_read_keeps_original_route=true;
 // An entered write may finish; takeover must cancel the queued control before Port.
 const beforeGate=await snapshot();await writeFile(path.join(directory,'serial-mcp-hold'),'hold');const heldWrite=wr([0,255]);validateBound(await success('serial_write',heldWrite),heldWrite);
 let entered=false;for(let i=0;i<100;i++){try{await access(path.join(directory,'serial-mcp-entered'));entered=true;break;}catch{await delay(5);}}assert.ok(entered);
 const heldControl=ctl('RTS',false);validateBound(await success('serial_control',heldControl),heldControl);
 return {
  async afterTakeover(){await writeFile(path.join(directory,'serial-mcp-release'),'release');await done(heldWrite.request_id,'DRIVER_ACCEPTED');await done(heldControl.request_id,'CANCELLED_BEFORE_DISPATCH');const now=await snapshot();assert.equal(now.control_calls,beforeGate.control_calls);assert.deepEqual(now.controls,beforeGate.controls);assert.equal(now.rts,true);await deny('serial_write',wr(),'PERMISSION_DENIED');await deny('serial_control',ctl(),'PERMISSION_DENIED');checks.takeover_keeps_entered_write_cancels_late_control=true;},
  async afterRevoke(){await deny('terminal_input_status',{transport:'SERIAL',connection:ref,request_id:firstControl.request_id},'PERMISSION_DENIED');checks.revoked_receipt_denied=true;},
  async afterServiceLoss(){const before=await snapshot();await deny('serial_control',ctl(),'UNKNOWN_DELIVERY');await deny('serial_write',wr(),'UNKNOWN_DELIVERY');assert.deepEqual(await snapshot(),before);checks.service_loss_no_write_or_control_replay=true;assert.equal(before.control_calls,6);assert.equal(before.write_calls,baseline.write_calls+4);await writeFile(`artifacts/${evidence}-result.json`,JSON.stringify({result:'PASS',checks,controller:before,baseline,model_run:false,scope:'Port-call/state counters and echo on explicit owned memory fixture only'},null,2)+'\n');}
 };
}
