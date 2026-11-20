import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {ContextMenu,Dialog,ErrorNotice,Panel} from './ui';
import {logging,LogRequestError,type LogInfo,type ExportInfo} from './logging-api';
import {LogSavePanel} from './log-save-panel';
import {checkedSave,saveDiagnosticNotice,terminalSave,type SaveInfo} from './log-save';
import {requestId} from './request-id';
import {checkedMenu,restoreLogTask,sameLogTarget,knownMenuRejection,menuFailure,type MenuInfo,type RememberedLogTask,type TerminalMenuContext} from './log-menu';
type Props={paneLabel:string; onLog(log:LogInfo):void; focus(t:RememberedLogTask):void;menu?:TerminalMenuContext;close():void;owner:string;valid(t:Pick<RememberedLogTask,'target'|'pane'|'epoch'>):boolean;resume(t:RememberedLogTask):{pane:RememberedLogTask['pane'];epoch:number}|undefined;copy(context:TerminalMenuContext):void;paste(context:TerminalMenuContext):void};
type Receipt={target:RememberedLogTask;info:SaveInfo};
type Task=RememberedLogTask&{info?:MenuInfo;log?:LogInfo;uncertain:boolean;finished:boolean;auto:boolean;recovery:boolean;cancelled:boolean;message:string;error:boolean;save?:SaveInfo};
const slot='terminal-context-log-task-v1';
const recordingStatus=(task:Task|undefined)=>task?.kind==='start'||task?.kind==='stop';
const failures:Record<string,string>={CAPACITY:'日志文件容量已达上限',QUEUE_FULL:'日志写盘队列已满，后续输出未记录',DISK_FULL:'磁盘空间不足',STORAGE:'文件存储故障',INVALID_RECORD:'记录序号异常',COUNTER_EXHAUSTED:'记录计数已耗尽',WORKER_PANICKED:'文件线程异常'};
function captureMessage(log:LogInfo){return log.failure?failures[log.failure]??'日志记录失败':log.phase==='RECORDING'?`正在记录 · 已接受 ${log.accepted_records} 条 · 已写入 ${log.written_records} 条 · 已刷新 ${log.readable?.flushed_records??0} 条 · 已同步 ${log.readable?.synced_records??0} 条`:log.phase==='OPENING'?'正在创建实时日志文件…':log.phase==='STOPPING'?'正在停止并同步日志…':log.phase==='STOPPED'?'记录已停止并同步。':'记录当前不可用。';}
function initialTask():Task|undefined{try{const old=restoreLogTask(sessionStorage.getItem(slot));return old?{...old,uncertain:true,finished:false,auto:false,recovery:true,cancelled:false,error:false,message:'已恢复原操作编号，请查询结果；不会重新执行或自动续存。'}:undefined;}catch{return;}}
export function TerminalLogMenu(props:Props){
 const latest=useRef(props);latest.current=props;
 const [logs,setLogs]=useState<LogInfo[]>([]),[reading,setLoading]=useState(false),[loadedMenu,setLoadedMenu]=useState<TerminalMenuContext>(),[loadError,setLoadError]=useState('');
 const [task,setTask]=useState<Task|undefined>(initialTask),current=useRef(task),[busy,setBusy]=useState(false),[visible,setVisible]=useState(!!task);
 const [receipt,setReceipt]=useState<Receipt>(),[notice,setNotice]=useState<Receipt>(),[directoryError,setDirectoryError]=useState('');
 const directoryFlight=useRef(false);
 const flight=useRef(false),mounted=useRef(true);const menu=props.menu,loading=!!menu&&(reading||loadedMenu!==menu);
 function publish(t:Task){if(current.current!==t||!mounted.current)return;setTask({...t});try{const saved:RememberedLogTask={target:t.target,request_id:t.request_id,kind:t.kind,title:t.title,pane:t.pane,epoch:t.epoch,log_id:t.log_id,subkind:t.subkind,saveVisible:t.saveVisible};sessionStorage.setItem(slot,JSON.stringify(saved));}catch{/* original IDs remain visible; no text is persisted */}}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const t=current.current;if(t&&!t.finished&&['prepare','file','directory'].includes(t.kind))void invoke('terminal_log_request',{request:{op:'cancel',target:t.target,request_id:t.request_id}}).catch(()=>{});};},[]);
 useEffect(()=>{
  let active=true,timer=0;setLogs([]);setLoadError('');setLoading(!!menu);setLoadedMenu(undefined);
  async function read(){if(!menu||!latest.current.valid(menu))return;try{const result=await logging({op:'list',connection:menu.target.connection});if(!active)return;if(result.result!=='list'||result.logs.some(l=>l.connection.connection_id!==menu.target.connection.connection_id||l.connection.generation!==menu.target.connection.generation||l.protocol!==menu.target.protocol))throw Error();setLogs(result.logs);setLoadError('');}catch{if(active)setLoadError('状态未知。请关闭菜单后重试。');}finally{if(active){setLoadedMenu(menu);setLoading(false);timer=window.setTimeout(()=>void read(),500);}}}
  if(menu&&['SSH2','SERIAL'].includes(menu.target.protocol))void read();else setLoading(false);
  return()=>{active=false;clearTimeout(timer);};
 },[menu]);
 useEffect(()=>{if(menu&&!props.valid(menu))props.close();});
 async function cancelNative(t:Task){try{await invoke('terminal_log_request',{request:{op:'cancel',target:t.target,request_id:t.request_id}});}catch{/* original status query remains available; no replay */}}
 useEffect(()=>{const t=current.current;if(!t||t.finished||t.cancelled||!t.auto||props.valid(t)||!['prepare','file','directory'].includes(t.kind))return;t.cancelled=true;t.auto=false;t.recovery=true;setVisible(false);t.message='目标已切换，已停止后续步骤；请查询原操作结果。已开始的保存可能完成。';publish(t);void cancelNative(t);});
 async function run(t:Task,start=false,payload?:unknown){
  if(flight.current||current.current!==t)return;
  if(latest.current.owner!==t.target.service_id){t.auto=false;t.finished=true;t.uncertain=false;t.error=true;t.message='原会话服务已结束，旧编号无法恢复；没有重新记录或保存。';publish(t);return;}
  flight.current=true;setBusy(true);
  try{
   if(t.kind==='start'||t.kind==='stop'){
    const result=await logging(t.kind==='start'?(start?{op:'start',connection:t.target.connection,request_id:t.request_id,limits:{segment_bytes:100*1024*1024,segments:5}}:{op:'start_status',connection:t.target.connection,request_id:t.request_id}):{op:start?'stop':'status',connection:t.target.connection,log_id:t.log_id!});
    if(result.result!=='info'||result.connection.connection_id!==t.target.connection.connection_id||result.connection.generation!==t.target.connection.generation||result.protocol!==t.target.protocol||t.log_id&&result.log_id!==t.log_id)throw Error('日志回执目标不匹配，请查询原编号。');
    if(current.current!==t||!mounted.current)return;
    latest.current.onLog(result);t.log_id=result.log_id;t.log=result;t.uncertain=false;t.error=!!result.failure;t.message=captureMessage(result);t.finished=t.kind==='stop'?result.worker_finished:result.phase==='RECORDING'&&!!result.readable||['FAILED','STOPPED','REMOVED','RELEASED'].includes(result.phase);
   }else{
    const result=checkedMenu(await invoke<MenuInfo>('terminal_log_request',{request:start?payload:{op:'status',target:t.target,request_id:t.request_id}}),t.target,t.request_id,t.subkind!);
    if(current.current!==t||!mounted.current){if(t.kind==='prepare')void cancelNative(t);return;}
    t.info=result;t.uncertain=false;t.error=result.phase==='FAILED';
    if(result.phase==='COMPLETED'&&t.kind==='prepare'){
     if(t.cancelled||t.auto&&!latest.current.valid(t)){t.auto=false;t.cancelled=true;t.message='目标已变化，已放弃本次准备的临时副本。';void cancelNative(t);}
     else{t.message=t.subkind==='RECORDED'?`已准备 ${result.ranges.length} 份日志的完整已刷新范围。起录前未记录、源缺口和快照后新输出不在文件；正在记录的文件继续追加。`:t.subkind==='VIEWPORT'?'已冻结打开菜单时实际可见屏幕的物理行、空行及尾部空格；这是显示文本，不是完整通信记录。':'已冻结当前活动终端保留缓冲；最多含512行历史，不代表从连接开始的全部日志。';if(t.auto)t.saveVisible=true;}
     t.finished=false;
    }else if(result.phase==='OPENED'){t.finished=true;t.message=t.kind==='file'?'已请求系统文本编辑器打开本次实际日志文件。记录继续，文件周期刷新；编辑器未必自动刷新，可重新打开此文件查看新增内容。':'已请求打开所有窗口共用的日志目录。';}
    else if(result.phase==='FAILED'){t.finished=true;t.message=menuFailure(result.failure??'');}
    else if(result.phase==='REMOVED'){t.finished=!t.saveVisible;t.auto=false;t.message=t.saveVisible?'临时副本已回收，可查询原另存回执；不会重新生成。':'本次临时副本已放弃，原实时日志保持。';}
    else{t.finished=false;t.message=result.phase==='RELEASING'?'正在回收本次临时副本…':t.kind==='prepare'?'正在准备固定范围日志…':'正在打开本次日志来源…';}
   }
   publish(t);
  }catch(error){if(current.current!==t||!mounted.current)return;const code=error instanceof LogRequestError?error.code:String(error);const rejected=start&&(error instanceof LogRequestError?!error.uncertain:knownMenuRejection(code));t.auto=false;t.uncertain=!rejected;t.finished=rejected;t.error=true;t.message=error instanceof LogRequestError?error.message:menuFailure(code);if(t.uncertain)t.message+=' 保留原编号，请查询结果；没有自动重放或续存。';publish(t);}
  finally{flight.current=false;if(mounted.current)setBusy(false);}
 }
 useEffect(()=>{const t=current.current;if(!t||busy||t.uncertain||t.finished||t.saveVisible||t.info?.phase==='COMPLETED'&&!t.cancelled)return;const timer=window.setTimeout(()=>void run(t),150);return()=>clearTimeout(timer);},[task,busy]);
 function choose(kind:Task['kind'],subkind?:MenuInfo['kind']){
  const context=latest.current.menu;if(!context||flight.current||current.current&&!current.current.finished||!latest.current.valid(context))return;
  if((kind==='start'||kind==='stop'||kind==='file'||subkind==='RECORDED')&&(loadedMenu!==context||loadError))return;
  const shown=logs.find(l=>l.active)??logs[0];
  const t:Task={log:kind==='file'||kind==='stop'?shown:undefined,target:context.target,request_id:requestId(),kind,title:context.title,pane:context.pane,epoch:context.epoch,...(kind==='stop'||kind==='file'?{log_id:shown?.log_id}:{}),subkind,uncertain:false,finished:false,auto:true,recovery:false,cancelled:false,error:false,message:'正在处理日志操作…'};
  let payload:unknown;
  if(kind==='prepare'){
   const source=subkind==='RECORDED'?{kind:'recorded',log_ids:logs.filter(l=>l.readable||!['REMOVED','RELEASED'].includes(l.phase)).slice().reverse().map(l=>l.log_id)}:subkind==='VIEWPORT'?{kind:'viewport',...context.viewport}:{kind:'buffer',text:context.buffer?.text,rows:context.buffer?.rows,cols:context.buffer?.cols};
   payload={op:'prepare',target:t.target,request_id:t.request_id,source};
  }else if(kind==='file'||kind==='directory')payload={op:kind==='file'?'open_file':'open_directory',target:t.target,request_id:t.request_id,...(kind==='file'?{log_id:t.log_id}:{})};
  current.current=t;setNotice(undefined);setDirectoryError('');setVisible(true);publish(t);latest.current.close();void run(t,true,payload);
 }
 function closeStatus(){const t=current.current;setVisible(false);if(!t||recordingStatus(t))return;if(t.finished){current.current=undefined;setTask(undefined);try{sessionStorage.removeItem(slot);}catch{/* unavailable */}}else if(['prepare','file','directory'].includes(t.kind)){t.auto=false;t.cancelled=true;t.recovery=true;t.uncertain=true;t.message='已请求取消，请查询原结果；已开始的保存可能完成。';publish(t);void cancelNative(t);}}
 function saved(t:Task,info:SaveInfo){
  if(current.current!==t||info.scope.mode!=='MENU'||info.scope.request_id!==t.request_id||info.scope.log_id!==t.request_id||info.scope.connection.connection_id!==t.target.connection.connection_id||info.scope.connection.generation!==t.target.connection.generation)return;
  t.save=info;t.finished=terminalSave(info);publish(t);
  if(info.phase!=='COMPLETED'&&info.phase!=='CANCELLED')return;
  // The child has already stored this verified terminal receipt before callback.
  // Unmount cleanup must never cancel a completed publication or its destination.
  t.auto=false;setVisible(false);setDirectoryError('');
  const result={target:t,info};if(info.phase==='COMPLETED')setReceipt(result);
  if(latest.current.valid(t)){setNotice(result);latest.current.focus(t);}
  try{sessionStorage.removeItem(slot);}catch{/* known terminal receipt stays in memory */}
 }
 const recordingStatusId=recordingStatus(task)?task?.request_id:undefined;
 // Key the timeout to the opening and original operation, not its changing receipts.
 useEffect(()=>{
  if(!visible||!recordingStatusId)return;
  const timer=window.setTimeout(()=>setVisible(false),5000);
  return()=>clearTimeout(timer);
 },[visible,recordingStatusId]);
 useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(undefined),6000);return()=>clearTimeout(timer);},[notice]);
 async function openSaved(result:Receipt){if(directoryFlight.current)return;directoryFlight.current=true;setDirectoryError('');try{checkedSave(await invoke('export_save_request',{request:{op:'open_directory',scope:result.info.scope,save_id:result.info.save_id}}),result.info,result.info);}catch{if(mounted.current)setDirectoryError('保存目录暂时无法打开；已保存文件保持，可复制所示路径。');}finally{directoryFlight.current=false;}}
 const receiptMatches=!!menu&&!!receipt&&receipt.target.target.service_id===menu.target.service_id&&receipt.target.target.protocol===menu.target.protocol&&receipt.target.target.connection.connection_id===menu.target.connection.connection_id&&receipt.target.target.connection.generation===menu.target.connection.generation;

 const pending=busy||!!task&&!task.finished,shown=logs.find(l=>l.active)??logs[0],supported=!!menu&&['SSH2','SERIAL'].includes(menu.target.protocol),completeFiles=logs.filter(l=>l.readable||!['REMOVED','RELEASED'].includes(l.phase));
 const source:ExportInfo|undefined=task?.info&&['COMPLETED','REMOVED','RELEASING'].includes(task.info.phase)?{connection:task.target.connection,log_id:task.request_id,request_id:task.request_id,phase:task.info.phase==='COMPLETED'?'COMPLETED':'REMOVED',failure:null,bytes:task.info.bytes,sha256:task.info.sha256,retained_records:task.info.retained_records,retained_raw_bytes:null,retained_gap_bytes:task.info.retained_gap_bytes,next_cursor:null}:undefined;
 return <>
  {menu&&<ContextMenu className="terminal-context-menu" label="终端日志菜单" x={menu.x} y={menu.y} anchor={menu.anchor} close={props.close}>
   <small className="log-menu-target">{menu.title} · {props.paneLabel}</small>
   <button role="menuitem" disabled={!supported||pending||!menu.buffer} onClick={()=>choose('prepare','BUFFER')}>保存终端缓冲内容…</button>
   <button role="menuitem" disabled={!supported||loading||!!loadError||pending||(!shown?.active&&!menu.writable)}
    onClick={()=>choose(shown?.active?'stop':'start')}>{shown?.active?'停止记录':'开始记录'}</button>
   <button role="menuitem" disabled={!supported||pending} onClick={()=>choose('directory','DIRECTORY')}>打开日志目录</button>
   <hr/>
   <small>其他保存范围</small>
   <button role="menuitem" disabled={!supported||loading||!!loadError||pending||!completeFiles.length||completeFiles.some(l=>!l.readable)} onClick={()=>choose('prepare','RECORDED')}>另存全部已记录日志…</button>
   <button role="menuitem" disabled={!supported||pending||!menu.viewport} onClick={()=>choose('prepare','VIEWPORT')}>只保存当前可见屏幕…</button>
   <button role="menuitem" title={shown?.readable?.filename??'本次尚无可读日志文件'} disabled={!supported||loading||!!loadError||pending||!shown?.readable} onClick={()=>choose('file','FILE')}>打开当前日志文件</button>
   <hr/>
   <button role="menuitem" disabled={!menu.selected} onClick={()=>{if(props.valid(menu))props.copy(menu);props.close();}}>复制选区</button>
   <button role="menuitem" disabled={!menu.writable} onClick={()=>{if(props.valid(menu))props.paste(menu);props.close();}}>粘贴</button><hr/>
   {shown&&<small aria-label="右键日志状态">{captureMessage(shown)}{shown.source_gap_bytes>0&&` · 源缺口 ${shown.source_gap_bytes} 字节`}</small>}
   {!shown&&!loading&&!loadError&&<small>未记录 · 可保存仍保留的缓冲内容</small>}
   {shown&&!shown.readable&&<small>本次可读文件未就绪，不会打开上一轮文件。</small>}
   {receiptMatches&&receipt&&<><hr/><small aria-label="最近日志保存路径">上次已保存：{receipt.info.path}</small><button role="menuitem" onClick={()=>{void openSaved(receipt);props.close();}}>打开上次保存目录</button></>}
   {directoryError&&<small role="alert">{directoryError}</small>}
   {loadError&&<small role="alert">{loadError}</small>}{menu.warning&&<small role="alert">{menu.warning}</small>}
   {!pending&&!visible&&task&&recordingStatusId&&sameLogTarget(task.target,menu.target)&&
    <button role="menuitem" onClick={()=>{setVisible(true);props.close();}}>查看上次日志操作</button>}
   {pending&&<button role="menuitem" onClick={()=>{setVisible(true);props.close();if(current.current&&!busy)void run(current.current);}}>查询上次日志操作结果</button>}
  </ContextMenu>}
  {notice&&props.valid(notice.target)&&<div className="terminal-log-feedback" role="status" aria-label="日志保存反馈"><span title={notice.info.path??undefined}>{notice.target.title} · {notice.info.phase==='COMPLETED'?`日志已保存：${notice.info.path?.split(/[\\/]/).at(-1)}`:'日志保存已取消。'}{saveDiagnosticNotice(notice.info)}</span>{notice.info.phase==='COMPLETED'&&<button onClick={()=>void openSaved(notice)}>打开所在目录</button>}{directoryError&&<small role="alert">{directoryError}</small>}</div>}
  {task&&visible&&<Dialog label="日志操作结果" modal={false} passive close={closeStatus}><Panel title={`${task.title} · 窗格${task.pane==='first'?1:2}日志`} label="终端右键日志操作" close={closeStatus} closeLabel="收起日志操作">
   {task.error?<ErrorNotice title="日志操作未完成">{task.message}</ErrorNotice>:<p role="status" aria-label="右键日志操作状态">{task.message}</p>}
   {task.log?.readable&&<><p className="data-location" aria-label="实时日志文件名">{task.log.readable.filename}</p><small>同一应用数据目录的所有窗口共用 logs 文件夹。文件刷新目标100ms、持久同步目标1秒，系统阻塞时可能延迟；停止后核对最终同步状态。</small></>}
   {(task.uncertain||task.recovery)&&<button disabled={busy} onClick={()=>{if(current.current)void run(current.current);}}>查询本次日志操作</button>}
   {task.kind==='prepare'&&task.info?.phase==='COMPLETED'&&!task.saveVisible&&!task.cancelled&&!task.auto&&<button disabled={busy||!props.resume(task)} onClick={()=>{const t=current.current;if(t){const position=props.resume(t);if(position){t.pane=position.pane;t.epoch=position.epoch;t.saveVisible=true;t.auto=true;t.recovery=false;publish(t);}}}}>保存已准备的日志</button>}
   {task.saveVisible&&source&&<LogSavePanel key={`${task.request_id}/${task.recovery?'query':'live'}`} source={source} mode="MENU" autoStart={task.auto&&!task.cancelled&&props.valid(task)} onChange={info=>{const currentTask=current.current;if(currentTask?.request_id===task.request_id)saved(currentTask,info);}}/>}
   {task.info?.ranges.some(r=>r.source_gap_bytes>0||r.rejected_records>0||r.failed)&&<p role="alert">范围包含源缺口、拒绝或失败记录，不能视为完整通信。</p>}
   <details><summary>固定范围与编号</summary><p className="data-location">{task.target.protocol} · {task.target.connection.connection_id} / {task.target.connection.generation} · {task.request_id}</p>{task.info?.ranges.map(r=><p className="data-location" key={r.log_id}>{r.filename} · 刷新 {r.flushed_records} 条 / 同步 {r.synced_records} 条 · 固定 {r.bytes} 字节</p>)}</details>
  </Panel></Dialog>}
 </>;
}
