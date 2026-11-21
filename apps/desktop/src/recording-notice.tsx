import {useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {LogInfo,ReadableInfo} from './logging-api';
import {checkedMenu,menuFailure,type LogTarget,type MenuInfo} from './log-menu';
import {requestId} from './request-id';
import {CornerNotice,useCornerNoticeFailure} from './corner-notice';

type Notice={target:LogTarget;title:string;id:string;file?:ReadableInfo;gap:number};
export type NotifyStopped=(target:LogTarget,title:string,log:LogInfo)=>void;
const seenSlot='terminal-stopped-notices-v1';
const delay=(ms:number)=>new Promise(resolve=>window.setTimeout(resolve,ms));
const count=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const uuid=(id:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);

export function syncedStop(log:LogInfo) {
  return log.phase==='STOPPED'&&log.worker_finished&&log.durable&&!log.active&&log.failure===null;
}

export function useRecordingNotices(owner:string,openDirectory:()=>Promise<string>) {
  const [notices,setNotices]=useState<Notice[]>([]);
  const failure=useCornerNoticeFailure();
  const seen=useRef<{owner:string;ids:Set<string>}>({owner:'',ids:new Set()});
  const currentOwner=useRef(owner);
  currentOwner.current=owner;

  function notify(target:LogTarget,title:string,log:LogInfo) {
    if(!target.service_id||currentOwner.current!==target.service_id||!syncedStop(log)||!uuid(log.log_id)||
      log.protocol!==target.protocol||log.connection.connection_id!==target.connection.connection_id||
      log.connection.generation!==target.connection.generation)return;
    if(seen.current.owner!==target.service_id){
      let ids:string[]=[];
      try{
        const saved=JSON.parse(sessionStorage.getItem(seenSlot)??'null');
        if(saved?.owner===target.service_id&&Array.isArray(saved.ids)&&saved.ids.length<=64)
          ids=saved.ids.filter((id:unknown)=>typeof id==='string'&&uuid(id));
      }catch{/* the live window still deduplicates its notices */}
      seen.current={owner:target.service_id,ids:new Set(ids)};
    }
    if(seen.current.ids.has(log.log_id))return;
    seen.current.ids.add(log.log_id);
    try{
      sessionStorage.setItem(seenSlot,JSON.stringify({owner:target.service_id,ids:[...seen.current.ids]}));
    }catch{/* the live window still deduplicates its notices */}
    const file=log.readable;
    const validFile=file&&file.filename.endsWith('.log')&&file.filename.length<=255&&
      !file.filename.startsWith('.')&&!/[\\/:\u0000-\u001f\u007f]/.test(file.filename);
    const notice={target,title,id:log.log_id,file:validFile?file:undefined,gap:log.source_gap_bytes};
    setNotices(queue=>[...queue.filter(item=>item.target.service_id===target.service_id),notice]);
  }

  const notice=notices.find(item=>item.target.service_id===owner);
  async function open(original:Notice,kind:'file'|'directory') {
    if(currentOwner.current!==original.target.service_id)return;
    const message=kind==='file'?await openStoppedFile(original):await openDirectory();
    if(message&&currentOwner.current===original.target.service_id)failure.report(`${original.title} · ${message}`);
  }
  return {notice,notify,open,failure,dismiss:(id:string)=>setNotices(queue=>queue.filter(item=>item.id!==id))};
}

export function useOpenLogDirectory() {
  const flight=useRef(false);
  const [error,setError]=useState('');
  async function run(forNotice:boolean) {
    if(flight.current)return '日志目录正在打开。';
    flight.current=true;
    if(!forNotice)setError('');
    try{await invoke('open_managed_log_directory');return '';}
    catch(error){
      const code=String(error);
      const message=['DIRECTORY_UNAVAILABLE','DIRECTORY_CHANGED'].includes(code)?'日志目录不可用。':
        ['CAPACITY','SOURCE_MISSING','STORAGE','SHELL_UNAVAILABLE','WORKER_FAILED'].includes(code)?'日志目录未能打开。'+menuFailure(code):'';
      if(!forNotice&&message)setError(message);
      return message||'日志目录打开结果暂未确认。';
    }finally{flight.current=false;}
  }
  return {open:async()=>{await run(false);},openForNotice:()=>run(true),error,
    dismiss:(message:string)=>setError(previous=>previous===message?'':previous)};
}

async function openStoppedFile(notice:Notice) {
  const {target,id:logId}=notice;
  const id=requestId();
  const read=(op:'open_file'|'status')=>invoke<MenuInfo>('terminal_log_request',{
    request:{op,target,request_id:id,...(op==='open_file'?{log_id:logId}:{})}
  }).then(reply=>checkedMenu(reply,target,id,'FILE'));
  let info;
  try{info=await read('open_file');}
  catch(error){
    const code=String(error);
    if(code==='SESSION_IN_OTHER_WINDOW')return '原会话已移至其他窗口。';
    if(['STALE_SERVICE','STALE_TARGET','INVALID_SOURCE','SOURCE_NOT_READY','CAPACITY','STORAGE'].includes(code))
      return menuFailure(code);
    try{info=await read('status');}catch{return '打开结果暂未确认。';}
  }
  try{
    for(let i=0;i<30&&(info.phase==='QUEUED'||info.phase==='RUNNING');i++){
      await delay(150);info=await read('status');
    }
  }catch{return '打开结果暂未确认。';}
  return info.phase==='OPENED'?'':info.phase==='FAILED'?menuFailure(info.failure??''):'打开结果暂未确认。';
}

export function RecordingNotice({notice,dismiss,open}:{notice:Notice;dismiss(id:string):void;open(original:Notice,kind:'file'|'directory'):Promise<void>}) {
  const {file,gap}=notice;
  return <CornerNotice className="recording-notice" aria-label="录制完成通知"
    autoDismiss dismiss={()=>dismiss(notice.id)}
    heading={<span title={`${notice.title} · ${notice.target.protocol} · ${notice.target.connection.connection_id} / ${notice.target.connection.generation}`}>{notice.title} · 记录已停止并同步</span>}
    actions={activate=><>
      {file&&<button onClick={()=>activate(()=>void open(notice,'file'))}>打开该日志</button>}
      <button onClick={()=>activate(()=>void open(notice,'directory'))}>打开日志目录</button>
    </>}>
    <div className="recording-notice-file notice-ellipsis" title={file?.filename}>{file?.filename??'可读文件暂不可用'}</div>
    <small className="recording-notice-totals">
      {file&&count(file.synced_bytes)&&<>已同步 {file.synced_bytes.toLocaleString('zh-CN')} 字节</>}
      {file&&count(file.synced_records)&&<> · {file.synced_records.toLocaleString('zh-CN')} 条输出</>}
      {count(gap)&&gap>0&&<> · 源缺口 {gap.toLocaleString('zh-CN')} 字节</>}
    </small>
  </CornerNotice>;
}
