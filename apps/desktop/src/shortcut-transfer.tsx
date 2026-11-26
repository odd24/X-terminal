import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {AdbSettings, AdbShortcut} from './local-adb';
import {Dialog, Panel} from './ui';

type Status = 'new'|'same'|'conflict'|'missing';
type Decision = 'skip'|'keep'|'replace';
type Row = {item:AdbShortcut;script:string|null;files:string[];status:Status;existing:AdbShortcut[]};
type Preview = {token:string;rows:Row[]};
type Counts = {added:number;replaced:number;same:number;skipped:number;missing:number};
type PickerMode = 'import'|'export'|'attachments';
const labels:Record<Status,string> = {new:'新增',same:'完全相同',conflict:'冲突',missing:'缺脚本'};
const choose=(mode:PickerMode)=>invoke<{path:string;name:string}[]>('pick_shortcut_package',{mode});
const transfer=<T,>(action:Record<string,unknown>)=>invoke<T>('shortcut_transfer',{action});
const cancel=(token:string)=>transfer({kind:'cancel',token}).catch(()=>undefined);

function Details({item,script}:{item:AdbShortcut;script?:string|null}) {
  const target=script||item.script_path;
  const kind=target?'批处理脚本':item.desktop_kind==='send'?'会话发送':item.desktop_kind==='local'?'Windows 本地命令':'ADB';
  return <div>
    <p>{kind} · {item.pinned?'置顶':'常规'} · {item.desktop_kind==='send'
      ?item.append_enter?'追加 Enter':'保留原文'
      :item.close_on_success?'成功或手动停止后自动关闭结果标签':'保留结果标签'}</p>
    <pre>{target||item.command}</pre>
    {item.description&&<pre>{item.description}</pre>}
  </div>;
}

export function ShortcutTransfer({mode, settings, close, applied}:{
  mode:'import'|'export';settings:AdbSettings;close():void;applied():Promise<void>;
}) {
  const source=useRef(settings).current;
  const [selected,setSelected]=useState(()=>new Set(source.shortcuts.map(item=>item.id)));
  const [include,setInclude]=useState(true);
  const [attachments,setAttachments]=useState<Record<string,string[]>>({});
  const [preview,setPreview]=useState<Preview>();
  const [decisions,setDecisions]=useState<Record<string,Decision>>({});
  const [counts,setCounts]=useState<Counts>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [written,setWritten]=useState(false);
  const live=useRef(false);
  const token=useRef<string>(undefined);
  const inFlight=useRef(false);
  useEffect(()=>{
    live.current=true;
    return ()=>{live.current=false;if(token.current)void cancel(token.current);};
  },[]);
  async function run(action:()=>Promise<void>){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError('');
    try{await action();}
    catch(reason){if(live.current)setError(String(reason));}
    finally{inFlight.current=false;if(live.current)setBusy(false);}
  }
  async function show(action:Record<string,unknown>){
    const result=await transfer<Preview>(action);
    if(!live.current){await cancel(result.token);return;}
    token.current=result.token;
    setDecisions({});
    setPreview(result);
  }
  function reset(){
    if(token.current)void cancel(token.current);
    token.current=undefined;
    setPreview(undefined);
    setError('');
  }
  const title=mode==='export'?'导出快捷指令':'导入快捷指令';
  return <Dialog label={title} wide close={()=>{if(!inFlight.current)close();}}>
    <Panel title={title}>
      {mode==='export'&&!preview&&!written&&<>
        <label><input type="checkbox" checked={include} disabled={busy} onChange={event=>setInclude(event.target.checked)}/> 携带引用脚本和配套文件</label>
        <div className="config-actions">
          <button disabled={busy||selected.size===source.shortcuts.length} onClick={()=>setSelected(new Set(source.shortcuts.map(item=>item.id)))}>全选指令</button>
          <button disabled={busy||!selected.size} onClick={()=>setSelected(new Set())}>清除选择</button>
        </div>
        <div className="shortcut-transfer-rows">
          {source.shortcuts.map(item=><div key={item.id}>
            <label><input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={event=>{
              const checked=event.target.checked;
              setSelected(value=>{const next=new Set(value);if(checked)next.add(item.id);else next.delete(item.id);return next;});
            }}/> {item.name}</label>
            {item.script_path&&include&&selected.has(item.id)&&<>
              <button disabled={busy} aria-label={'选择配套文件 '+item.name} onClick={()=>void run(async()=>{
                const files=await choose('attachments');
                if(live.current&&files.length)setAttachments(old=>({...old,[item.id]:[...new Set([...(old[item.id]??[]),...files.map(file=>file.path)])]}));
              })}>选择配套文件</button>
              {attachments[item.id]?.map(file=><div key={file}>{file}<button disabled={busy} aria-label={'移除配套文件 '+file} onClick={()=>
                setAttachments(old=>({...old,[item.id]:old[item.id].filter(value=>value!==file)}))}>移除</button></div>)}
            </>}
          </div>)}
        </div>
        <button data-dialog-autofocus disabled={busy||!selected.size} onClick={()=>void run(()=>show({
          kind:'preview_export',revision:source.revision,ids:[...selected],include_scripts:include,
          attachments:include?Object.fromEntries(Object.entries(attachments).filter(([id])=>selected.has(id))):{},
        }))}>预览导出</button>
      </>}
      {mode==='import'&&!preview&&!counts&&<button data-dialog-autofocus disabled={busy} onClick={()=>void run(async()=>{
        const [file]=await choose('import');
        if(file&&live.current)await show({kind:'preview_import',path:file.path});
      })}>选择 ZIP</button>}
      {preview&&!counts&&!written&&<>
        {mode==='import'&&<p>{Object.entries(labels).map(([status,label])=>label+' '+preview.rows.filter(row=>row.status===status).length).join(' · ')}</p>}
        <div className="shortcut-transfer-rows">
          {preview.rows.map(row=><details key={row.item.id}>
            <summary>{row.item.name}{mode==='import'||row.status==='missing'?' · '+labels[row.status]:''}</summary>
            <Details item={row.item} script={row.script}/>
            {row.files.length>0&&<ul aria-label="包内文件">{row.files.map(file=><li key={file}>{file}</li>)}</ul>}
            {row.existing.map(item=><div key={item.id}><strong>本机 · {item.name}</strong><Details item={item}/></div>)}
          </details>)}
          {mode==='import'&&preview.rows.filter(row=>row.status==='conflict').map(row=><label key={row.item.id}>
            {row.item.name} <select aria-label={'冲突处理 '+row.item.name} disabled={busy} value={decisions[row.item.id]??'skip'}
              onChange={event=>setDecisions({...decisions,[row.item.id]:event.target.value as Decision})}>
              <option value="skip">跳过</option><option value="keep">保留两份</option>
              <option value="replace" disabled={row.existing.length!==1}>替换</option>
            </select>
          </label>)}
        </div>
        <div className="config-actions">
          <button disabled={busy} onClick={reset}>{mode==='export'?'返回选择':'重新选择 ZIP'}</button>
          {mode==='export'?<button disabled={busy} onClick={()=>void run(async()=>{
            const [file]=await choose('export');
            if(file&&live.current){
              await transfer({kind:'write_export',token:preview.token,path:file.path});
              token.current=undefined;setWritten(true);
            }
          })}>保存 ZIP</button>:<button disabled={busy} onClick={()=>void run(async()=>{
            const result=await transfer<Counts>({kind:'apply_import',token:preview.token,decisions});
            token.current=undefined;setCounts(result);
            if(result.added+result.replaced)await applied();
          })}>确认导入</button>}
        </div>
      </>}
      {counts&&<p role="status">新增 {counts.added} · 替换 {counts.replaced} · 完全相同 {counts.same} · 跳过 {counts.skipped} · 缺脚本 {counts.missing}</p>}
      {written&&<p role="status">ZIP 已保存</p>}
      {error&&<p role="alert">{error}</p>}
      <button disabled={busy} onClick={close}>{written||counts?'完成':'取消'}</button>
    </Panel>
  </Dialog>;
}
