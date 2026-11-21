import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {logViewerFailure,type LogViewer} from './log-viewer';

export function LogViewerSettings() {
  const [value,setValue]=useState<LogViewer>();
  const [busy,setBusy]=useState(true);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const flight=useRef(false);
  const mounted=useRef(false);
  useEffect(()=>{
    mounted.current=true;
    void read();
    return()=>{mounted.current=false;};
  },[]);
  async function read() {
    try{
      const result=await invoke<LogViewer>('log_viewer_settings');
      if(mounted.current)setValue(result);
    }catch(error){if(mounted.current)setError(logViewerFailure(String(error))??'日志打开方式暂不可用。');}
    finally{if(mounted.current)setBusy(false);}
  }
  async function change(op:'choose_log_viewer'|'reset_log_viewer') {
    if(flight.current)return;
    flight.current=true;setBusy(true);setMessage('');setError('');
    try{
      const result=await invoke<LogViewer|null>(op);
      if(mounted.current&&result){
        setValue(result);
        setMessage(result.executable?'已保存所选程序。':'已恢复 Windows 系统默认。');
      }
    }catch(error){
      if(mounted.current){
        await read();
        setError(logViewerFailure(String(error))??'操作结果暂未确认，已重新读取日志打开方式。');
      }
    }finally{
      flight.current=false;
      if(mounted.current)setBusy(false);
    }
  }
  return <section className="log-viewer-settings" aria-label="日志打开方式">
    <h3>日志打开方式</h3>
    <p aria-label="当前日志打开方式" className="notice-ellipsis" title={value?.executable??undefined}>
      {value?.executable?.split('\\').at(-1)??(value?'Windows 系统默认':busy?'正在读取…':'当前设置不可用')}
    </p>
    {value?.executable&&<small className="log-viewer-path notice-ellipsis" title={value.executable}>{value.executable}</small>}
    {value&&!value.available&&<small role="alert">所选程序不可用。请选择其他程序，或恢复 Windows 系统默认。</small>}
    <div className="config-actions">
      <button disabled={busy} aria-label="选择日志打开程序" onClick={()=>void change('choose_log_viewer')}>
        {value?.executable?'改选程序…':'选择程序…'}
      </button>
      <button disabled={busy||!value?.executable} onClick={()=>void change('reset_log_viewer')}>恢复 Windows 系统默认</button>
    </div>
    <small>此设置立即保存。Windows 没有关联 .log 时使用记事本。</small>
    {message&&<p role="status">{message}</p>}
    {error&&<small role="alert">{error}</small>}
  </section>;
}
