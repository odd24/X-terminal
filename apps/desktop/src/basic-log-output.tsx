import { useEffect, useRef, useState } from 'react';
import { logging, type ExportInfo, type ExportScope, type LogInfo } from './logging-api';
import { checkedExport, restoreExport } from './log-export';
import { LogSavePanel } from './log-save-panel';
import { requestId } from './request-id';
import { visibleControls } from './log-search';
const slot='terminal-text-log-task-v1';
export function BasicLogOutput({ log }: { log:LogInfo }) {
  const [text,setText]=useState(''),[message,setMessage]=useState('停止记录后可查看、保存文本日志。'),[busy,setBusy]=useState(false);
  const [task]=useState<ExportScope>(()=>{try {const old=restoreExport(sessionStorage.getItem(slot));if(old?.log_id===log.log_id&&old.connection.connection_id===log.connection.connection_id&&old.connection.generation===log.connection.generation)return old;}catch{/* unavailable storage */}return {connection:log.connection,log_id:log.log_id,request_id:requestId()};});
  const [result,setResult]=useState<ExportInfo>(),[attempted,setAttempted]=useState(()=>{try{return restoreExport(sessionStorage.getItem(slot))?.request_id===task.request_id;}catch{return false;}}),[uncertain,setUncertain]=useState(attempted);
  const mounted=useRef(true), flight=useRef(false), saveWanted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const ready=log.phase==='STOPPED'&&log.worker_finished&&log.durable;
  async function view(){if(flight.current)return;flight.current=true;setBusy(true);const scope={connection:log.connection,log_id:log.log_id,read_id:requestId()};let opened=false;
    try {const reply=await logging({op:'history_open',...scope});if(reply.result!=='history_opened')throw new Error('日志未就绪');opened=true;const page=await logging({op:'history_read',...scope,cursor:reply.info.available_from,max_records:128,max_bytes:65536});if(page.result!=='history_page')throw new Error('日志页不匹配');if(mounted.current){setText(visibleControls(page.records.map(r=>r.text.text).join('')));setMessage(page.finished?'本次保留日志已读取。':'仅预览首批保留记录；保存文本日志包含整个已验证保留范围。');}}
    catch(error){if(mounted.current)setMessage(String(error));}
    finally{if(opened)await logging({op:'history_close',...scope}).catch(()=>{});flight.current=false;if(mounted.current)setBusy(false);}
  }
  async function prepare(start:boolean){if(flight.current)return;flight.current=true;setBusy(true);try{
    if(start){saveWanted.current=true;setAttempted(true);setMessage('正在准备日志…');try{sessionStorage.setItem(slot,JSON.stringify(task));}catch{/* explicit IDs still retained in this view */}}
    const reply=await logging({op:start?'text_export_start':'text_export_status',...task});if(reply.result!=='text_export')throw new Error('文本日志回复不匹配');
    const checked=checkedExport({...reply,result:'export'},task);if(!mounted.current)return;setResult(checked);setUncertain(false);setMessage(checked.phase==='COMPLETED'?'':checked.phase==='FAILED'?'准备日志失败，请检查日志状态。':'正在准备日志…');
  }catch(error){if(mounted.current){setUncertain(true);setMessage(`${String(error)} 保留原编号，只查询结果，不自动重新生成。`);}}
  finally{flight.current=false;if(mounted.current)setBusy(false);}}
  useEffect(()=>{if(!result||!['QUEUED','RUNNING','CANCELLING'].includes(result.phase)||busy||uncertain)return;const timer=window.setTimeout(()=>void prepare(false),300);return()=>clearTimeout(timer);},[result,busy,uncertain]);
  return <div aria-label="本次日志查看保存"><div className="config-actions"><button disabled={!ready||busy} onClick={()=>void view()}>查看日志</button>{result?.phase!=='COMPLETED'&&<button disabled={!ready||busy||attempted} onClick={()=>void prepare(true)}>保存日志</button>}{attempted&&uncertain&&<button disabled={busy} onClick={()=>void prepare(false)}>查询保存结果</button>}</div>{message&&<p role="status" aria-label="文本日志提示">{message}</p>}{text&&<pre aria-label="本次日志文本">{text}</pre>}{result?.phase==='COMPLETED'&&<LogSavePanel source={result} mode="TEXT" autoStart={saveWanted.current}/>}</div>;
}
