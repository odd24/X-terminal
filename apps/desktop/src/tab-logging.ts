import {useEffect,useRef,useState} from 'react';
import {logging} from './logging-api';
import {summarizeLogging,type LoggingSummary} from './logging-panel';

type Connection=LoggingSummary['connection']&{protocol:string};
const same=(a:LoggingSummary['connection']|undefined,b:LoggingSummary['connection'])=>
  a?.connection_id===b.connection_id&&a.generation===b.generation;
const key=(owner:string,c:Connection)=>`${owner}/${c.protocol}/${c.connection_id}/${c.generation}`;
const supported=(c:Connection)=>c.protocol==='SSH2'||c.protocol==='SERIAL';

export function logBadge(summary?:LoggingSummary) {
  if(summary?.unknown)return '状态未知';
  if(summary?.phase==='RECORDING')return '● 记录中';
  if(summary?.phase==='OPENING')return '正在起录…';
  if(summary?.phase==='STOPPING')return '● 正在同步…';
  if(summary?.phase==='FAILED')return '记录失败';
}

export function useTabLogging(owner:string,tabs:Connection[],active:Connection|undefined,summary:LoggingSummary|undefined) {
  const latest=useRef({tabs,active});
  latest.current={tabs,active};
  const [background,setBackground]=useState<Record<string,LoggingSummary>>({});
  function retainVisible(old:Record<string,LoggingSummary>) {
    return Object.fromEntries(latest.current.tabs.flatMap(tab=>{
      const id=key(owner,tab);
      return old[id]?[[id,old[id]]]:[];
    }));
  }
  useEffect(()=>{
    setBackground({});
    if(!owner)return;
    let live=true, index=0, timer=0;
    async function poll() {
      const candidates=latest.current.tabs.filter(c=>supported(c)&&!same(latest.current.active,c));
      const connection=candidates[index%candidates.length];
      if(connection){
        index++;
        const target={connection_id:connection.connection_id,generation:connection.generation};
        let next:LoggingSummary;
        try {
          const reply=await logging({op:'list',connection:target});
          if(reply.result!=='list'||reply.logs.some(log=>log.protocol!==connection.protocol||!same(log.connection,target)))throw Error();
          next={connection:target,...summarizeLogging(reply.logs)};
        }catch{next={connection:target,unknown:true,text:'状态未知'};}
        if(live&&!same(latest.current.active,connection))setBackground(old=>{
          const id=key(owner,connection);
          if(old[id]?.text===next.text&&old[id]?.phase===next.phase)return old;
          if(!latest.current.tabs.some(tab=>same(tab,connection)))return old;
          return {...retainVisible(old),[id]:next};
        });
      }
      if(live)timer=window.setTimeout(()=>void poll(),500);
    }
    void poll();
    return()=>{live=false;clearTimeout(timer);};
  },[owner]);
  // Keep the last verified active state during a tab change until its background turn.
  useEffect(()=>{
    if(!owner||!active||!summary||!same(summary.connection,active))return;
    const id=key(owner,active);
    setBackground(old=>old[id]?.text===summary.text&&old[id]?.phase===summary.phase?old:{...retainVisible(old),[id]:summary});
  },[owner,active?.connection_id,active?.generation,active?.protocol,summary]);
  return (c:Connection)=>owner&&supported(c)?same(summary?.connection,c)&&summary?.text!=='正在查询本次日志状态'?summary:background[key(owner,c)]:undefined;
}
