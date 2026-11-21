import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {logViewerFailure,type LogViewer} from './log-viewer';
import {Field} from './ui';

type Catalog={candidates:{id:string;name:string}[];selected_id:string|null};
const empty:Catalog={candidates:[],selected_id:null};

export function LogViewerSettings() {
  const [value,setValue]=useState<LogViewer>();
  const [catalog,setCatalog]=useState<Catalog>(empty);
  const [busy,setBusy]=useState(true);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [catalogError,setCatalogError]=useState('');
  const flight=useRef(false);
  const mounted=useRef(false);

  async function refresh() {
    const [setting,options]=await Promise.allSettled([
      invoke<LogViewer>('log_viewer_settings'),
      invoke<Catalog>('registered_log_viewers'),
    ]);
    if(!mounted.current)return;
    if(setting.status==='fulfilled')setValue(setting.value);
    else setError(logViewerFailure(String(setting.reason))??'日志打开方式暂不可用。');
    setCatalog(options.status==='fulfilled'?options.value:empty);
    setCatalogError(options.status==='fulfilled'?'':logViewerFailure('LOG_VIEWER_CATALOG'));
  }
  useEffect(()=>{
    mounted.current=true;
    void refresh().finally(()=>{if(mounted.current)setBusy(false);});
    return()=>{mounted.current=false;};
  },[]);

  async function change(choice:string) {
    if(flight.current||busy)return;
    flight.current=true;setBusy(true);setMessage('');setError('');
    try{
      const result=choice==='system'?await invoke<LogViewer>('reset_log_viewer'):
        choice==='other'?await invoke<LogViewer|null>('choose_log_viewer'):
          await invoke<LogViewer>('select_registered_log_viewer',{id:choice});
      if(!mounted.current||!result)return;
      setValue(result);
      if(choice==='other')await refresh();
      else setCatalog(previous=>({...previous,selected_id:choice==='system'?null:choice}));
      if(mounted.current)setMessage(result.executable?'已保存所选应用。':'已恢复 Windows 系统默认。');
    }catch(reason){
      if(!mounted.current)return;
      await refresh();
      if(mounted.current)setError(logViewerFailure(String(reason))??'操作结果暂未确认，已重新读取设置。');
    }finally{
      flight.current=false;
      if(mounted.current)setBusy(false);
    }
  }

  const custom=!!value?.executable&&!catalog.selected_id;
  const filename=value?.executable?.split('\\').at(-1);
  return <section className="log-viewer-settings" aria-label="日志打开方式">
    <Field label="默认打开应用">
      <select aria-label="日志默认打开应用" disabled={busy} value={catalog.selected_id??(custom?'custom':'system')}
        onChange={event=>void change(event.currentTarget.value)}>
        <option value="system">Windows 系统默认</option>
        {catalog.candidates.length>0&&<optgroup label="Windows 登记的应用">
          {catalog.candidates.map(app=><option value={app.id} key={app.id}>{app.name}</option>)}
        </optgroup>}
        {custom&&<option value="custom" disabled>{filename}（已选本地程序）</option>}
        <option value="other">选择其他应用…</option>
      </select>
    </Field>
    {value?.executable&&<p aria-label="当前日志打开方式" className="log-viewer-path notice-ellipsis" title={value.executable}>
      {value.executable}
    </p>}
    <small>选择后立即保存。Windows 没有可用的 .log 打开方式时使用记事本。</small>
    {value&&!value.available&&<p role="alert">所选程序不可用。请选择其他应用，或恢复 Windows 系统默认。</p>}
    {catalogError&&<p role="status">{catalogError}</p>}
    {message&&<p role="status">{message}</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
