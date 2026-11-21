import {useEffect,useRef,useState} from 'react';
import {logging,LogRequestError,type LogInfo} from './logging-api';
import {summarizeLogging,type LoggingSummary} from './logging-panel';
import {requestId} from './request-id';
import type {LogTarget} from './log-menu';

type Connection=LoggingSummary['connection']&{protocol:string;state:string};
type Operation={kind:'start'|'stop';id:string};
type Entry={log?:LogInfo;summary?:LoggingSummary;pending?:'start'|'stop'|'query';uncertain?:boolean;error?:string};
export type TabRecording={state:'idle'|'recording'|'pending'|'unknown'|'failed';label:string;detail:string;disabled:boolean};
const same=(a:LoggingSummary['connection'],b:LoggingSummary['connection'])=>
  a.connection_id===b.connection_id&&a.generation===b.generation;
const key=(target:LogTarget)=>`${target.service_id}/${target.protocol}/${target.connection.connection_id}/${target.connection.generation}`;
const supported=(c:Connection)=>c.protocol==='SSH2'||c.protocol==='SERIAL';
const stored='terminal-tab-recording-v1';

export function logBadge(summary?:LoggingSummary) {
  if(summary?.unknown)return '状态未知';
  if(summary?.phase==='RECORDING')return '● 记录中';
  if(summary?.phase==='OPENING')return '正在起录…';
  if(summary?.phase==='STOPPING')return '● 正在同步…';
  if(summary?.phase==='FAILED')return '记录失败';
}

async function read(target:LogTarget):Promise<Entry> {
  const result=await logging({op:'list',connection:target.connection});
  if(result.result!=='list'||result.logs.some(log=>log.protocol!==target.protocol||!same(log.connection,target.connection)))throw Error();
  return {log:result.logs.find(log=>log.active)??result.logs[0],summary:{connection:target.connection,...summarizeLogging(result.logs)}};
}

function savedOperations(owner:string) {
  const result=new Map<string,Operation>();
  try {
    const entries=JSON.parse(sessionStorage.getItem(stored)??'[]');
    if(Array.isArray(entries)&&entries.length<=64)for(const [id,value] of entries){
      if(typeof id==='string'&&id.startsWith(owner+'/')&&['start','stop'].includes(value?.kind)&&
        typeof value.id==='string'&&/^[0-9a-f-]{36}$/.test(value.id))result.set(id,value);
    }
  }catch{/* unavailable */}
  return result;
}

export function useTabLogging(owner:string,tabs:Connection[],active:Connection|undefined,valid:(target:LogTarget)=>boolean) {
  const latest=useRef({tabs,active,owner,valid});latest.current={tabs,active,owner,valid};
  const [visible,setVisible]=useState<Record<string,Entry>>({});
  const entries=useRef<Record<string,Entry>>({});
  const running=useRef(new Set<string>());
  const operations=useRef(new Map<string,Operation>());
  const revision=useRef(new Map<string,object>());
  const scope=useRef('');
  const target=(c:Connection):LogTarget=>({service_id:owner,protocol:c.protocol,connection:{connection_id:c.connection_id,generation:c.generation}});
  function remember(id:string,operation?:Operation) {
    if(operation)operations.current.set(id,operation);else operations.current.delete(id);
    try{sessionStorage.setItem(stored,JSON.stringify([...operations.current]));}catch{/* original operation stays in memory */}
  }
  function update(id:string,next:Entry) {
    const prior=entries.current[id];
    entries.current[id]=next;
    if(prior?.summary?.text===next.summary?.text&&prior?.log?.log_id===next.log?.log_id&&
      prior?.log?.active===next.log?.active&&prior?.log?.worker_finished===next.log?.worker_finished&&
      prior?.pending===next.pending&&prior?.uncertain===next.uncertain&&prior?.error===next.error)return;
    setVisible(old=>({...old,[id]:next}));
  }
  function alive(t:LogTarget){return latest.current.owner===t.service_id&&latest.current.valid(t);}
  useEffect(()=>{
    scope.current=owner;
    entries.current={};running.current=new Set();revision.current=new Map();
    if(!owner)return;
    operations.current=savedOperations(owner);
    setVisible(Object.fromEntries(Array.from(operations.current.keys(),id=>[id,{uncertain:true}])));
    let live=true,index=0,timer=0;
    async function refresh(c:Connection) {
      const t=target(c),id=key(t),before=revision.current.get(id);
      if(running.current.has(id)||operations.current.has(id)||!alive(t))return;
      let next:Entry;
      try {next=await read(t);}
      catch{next={summary:{connection:t.connection,unknown:true,text:'日志状态暂不可用'}};}
      if(live&&alive(t)&&revision.current.get(id)===before&&!running.current.has(id))
        update(id,{...next,error:entries.current[id]?.error});
    }
    async function poll() {
      const current=latest.current.active,candidates=latest.current.tabs.filter(c=>supported(c)&&(!current||!same(c,current)));
      const first=current&&supported(current)?current:undefined;
      const next=candidates[index++%candidates.length];
      if(first)await refresh(first);
      if(live&&next)await refresh(next);
      if(live)timer=window.setTimeout(()=>void poll(),500);
    }
    void poll();
    return()=>{live=false;scope.current='';running.current=new Set();clearTimeout(timer);};
  },[owner]);
  useEffect(()=>{
    const kept=new Set(tabs.filter(supported).map(c=>key(target(c))));
    for(const id of Object.keys(entries.current))if(!kept.has(id)&&!running.current.has(id)) {
      delete entries.current[id];revision.current.delete(id);
    }
    setVisible(old=>{
      const ids=Object.keys(old).filter(id=>kept.has(id)||running.current.has(id));
      return ids.length===Object.keys(old).length?old:Object.fromEntries(ids.map(id=>[id,old[id]]));
    });
  },[owner,tabs.map(c=>`${c.connection_id}/${c.generation}/${c.protocol}`).join(',')]);

  // The log menu and the advanced panel use the same synchronous dispatch gate.
  function claim(t:LogTarget) {
    const id=key(t),locks=running.current,versions=revision.current;
    if(scope.current!==t.service_id||!alive(t)||locks.has(id)||operations.current.has(id))return;
    locks.add(id);versions.set(id,{});
    setVisible(old=>({...old}));
    return ()=>{
      if(!locks.delete(id))return;
      versions.set(id,{});
      if(running.current===locks)setVisible(old=>({...old}));
    };
  }
  function locked(t:LogTarget){const id=key(t);return scope.current===t.service_id&&(running.current.has(id)||operations.current.has(id));}

  async function toggle(c:Connection) {
    const t=target(c),id=key(t),old=entries.current[id],recovery=operations.current.get(id);
    const locks=running.current,versions=revision.current;
    if(!supported(c)||scope.current!==owner||!alive(t)||locks.has(id)||!recovery&&(!old?.summary||old.summary.unknown))return;
    if(!recovery&&(!old?.log?.active&&c.state!=='CONNECTED'||old?.log?.phase==='OPENING'||old?.log?.phase==='STOPPING'))return;
    const expected=old?.log?.active?old.log.log_id:undefined;
    const kind=recovery?.kind??(expected?'stop':'start');
    locks.add(id);versions.set(id,{});
    update(id,{...old,pending:recovery?'query':kind,uncertain:false,error:undefined});
    let operation=recovery;
    const current=()=>running.current===locks&&latest.current.owner===owner;
    function accept(result:Awaited<ReturnType<typeof logging>>) {
      if(result.result!=='info'||result.protocol!==t.protocol||!same(result.connection,t.connection)||operation?.kind==='stop'&&operation.id!==result.log_id)
        throw Error();
      return result;
    }
    function query(op:Operation) {
      return logging(op.kind==='start'?{op:'start_status',connection:t.connection,request_id:op.id}:{op:'status',connection:t.connection,log_id:op.id});
    }
    try {
      let log:LogInfo;
      if(operation)log=accept(await query(operation));
      else {
        const fresh=await read(t);
        if(!current()||!alive(t))return;
        if((fresh.log?.active?fresh.log.log_id:undefined)!==expected||fresh.log?.phase==='OPENING'||fresh.log?.phase==='STOPPING'){
          update(id,{...fresh,error:'记录状态已变化，请核对后再操作。'});return;
        }
        operation={kind,id:expected??requestId()};
        remember(id,operation);
        log=accept(await logging(operation.kind==='start'?
          {op:'start',connection:t.connection,request_id:operation.id,limits:{segment_bytes:100*1024*1024,segments:5}}:
          {op:'stop',connection:t.connection,log_id:operation.id}));
      }
      const finished=()=>kind==='stop'?log.worker_finished:log.phase!=='OPENING';
      for(let i=0;!finished()&&i<24&&current();i++){
        await new Promise(resolve=>setTimeout(resolve,200));
        if(!current())return;
        log=accept(await query(operation));
      }
      if(!current())return;
      const summary={connection:t.connection,...summarizeLogging([log])};
      if(!finished()){update(id,{log,summary,uncertain:true,error:'记录尚未完成；可查询本次操作。'});return;}
      remember(id);
      const error=log.failure?'记录失败。请在终端日志中查看详情。':
        kind==='stop'&&!log.durable?'记录已停止，最终同步状态未确认。':undefined;
      update(id,{log,summary,error});
    }catch(error){
      if(!current())return;
      const uncertain=!!operation&&(!(error instanceof LogRequestError)||error.uncertain||!recovery&&error.code==='RequestExpired');
      if(!uncertain)remember(id);
      const stale=!operation?{connection:t.connection,unknown:true,text:'日志状态暂不可用'}:old?.summary;
      update(id,{...old,summary:stale,pending:undefined,uncertain,error:uncertain?
        '记录结果未确认。点击查询本次操作。':
        error instanceof LogRequestError?error.message:'日志状态暂不可用，请稍后再试。'});
    }finally{locks.delete(id);versions.set(id,{});}
  }

  function control(c:Connection):TabRecording|undefined {
    if(!supported(c))return;
    const id=key(target(c)),entry=visible[id],phase=entry?.log?.phase;
    const pending=entry?.pending??(phase==='OPENING'?'start':phase==='STOPPING'?'stop':undefined);
    const querying=!!entry?.uncertain||scope.current===owner&&operations.current.has(id)&&!pending;
    const state=querying?'unknown':pending?'pending':entry?.log?.active&&phase==='RECORDING'?'recording':
      entry?.error||phase==='FAILED'?'failed':!entry?.summary||entry.summary.unknown?'unknown':'idle';
    const label=querying?'查询本次记录结果':pending?(pending==='start'?'正在开始记录':pending==='stop'?'正在停止并同步记录':'正在查询记录结果'):
      entry?.log?.active?'停止记录':state==='unknown'?'正在查询记录状态':'开始记录';
    return {state,label,detail:entry?.error??(state==='recording'?'记录中':entry?.summary?.text??label),
      disabled:!owner||!!pending||running.current.has(id)||!querying&&(!entry?.summary||entry.summary.unknown||!entry?.log?.active&&c.state!=='CONNECTED')};
  }
  function summary(c:Connection):LoggingSummary|undefined {
    const t=target(c),id=key(t),entry=visible[id];
    if(entry?.pending==='start')return {connection:t.connection,phase:'OPENING',text:'正在开始记录'};
    if(entry?.pending==='stop')return {connection:t.connection,phase:'STOPPING',text:'正在停止并同步记录'};
    if(entry?.pending==='query'||entry?.uncertain||operations.current.has(id))
      return {connection:t.connection,unknown:true,text:entry?.error??'正在核对本次记录结果'};
    return entry?.summary;
  }
  return {summary,control,toggle,claim,locked};
}
