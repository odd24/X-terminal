import {invoke} from '@tauri-apps/api/core';
import {inspectBroadcastTargets,inspectContinuousTargets,continuousTargetReady,sendBroadcastTarget,queryBroadcastTarget} from './broadcast-api';
import type {BroadcastTarget} from './broadcast';
import {requestId} from './request-id';
import type {TriggerEvent,TriggerPage,TriggerHit} from './triggers';
async function matcher(request:Record<string,unknown>){try{return await invoke<{result:string;span?:number;hits?:TriggerHit[]}>('trigger_match_request',{request});}catch{throw new Error('原生匹配器拒绝或结果不明：请检查有限正则/跨度/资源预算，未自动重试；不会使用JS回溯匹配。');}}
export const triggerDependencies={
 id:requestId,now:()=>performance.now(),
 inspect:(owner:string,targets:Pick<BroadcastTarget,'connection_id'|'generation'|'protocol'>[],sending:boolean)=>sending?inspectContinuousTargets(owner,targets):inspectBroadcastTargets(owner,targets),
 compile:async(id:string,kind:string,pattern:string)=>{const r=await matcher({op:'compile',id,kind,pattern});if(r.result!=='compiled'||!Number.isSafeInteger(r.span)||!r.span||r.span>1024)throw new Error('匹配器编译回执无效');return r.span;},
 reset:async(id:string,next_seq:number)=>{const r=await matcher({op:'reset',id,next_seq});if(r.result!=='reset')throw new Error('匹配器起点回执无效');},
 feed:async(id:string,event:TriggerEvent)=>{const r=await matcher({op:'feed',id,seq:event.seq,text:event.text,broken:false,finished:false});if(r.result!=='hits'||!Array.isArray(r.hits))throw new Error('匹配器回执无效');return r.hits;},
 close:async(id:string)=>{await matcher({op:'close',id});},
 read:(source:BroadcastTarget,cursor:number)=>invoke<TriggerPage>('service_read_text',{connection:{connection_id:source.connection_id,generation:source.generation},cursor}),
 ready:continuousTargetReady,send:sendBroadcastTarget,query:queryBroadcastTarget,
 later:(fn:()=>void)=>{const timer=window.setTimeout(fn,100);return()=>window.clearTimeout(timer);},
};
