import {useEffect, useLayoutEffect, useRef, useState} from 'react';
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
  const [managing,setManaging]=useState<string>();
  const [preview,setPreview]=useState<Preview>();
  const [decisions,setDecisions]=useState<Record<string,Decision>>({});
  const [counts,setCounts]=useState<Counts>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [written,setWritten]=useState(false);
  const live=useRef(false);
  const token=useRef<string>(undefined);
  const inFlight=useRef(false);
  const exportBody=useRef<HTMLDivElement>(null);
  const selectAll=useRef<HTMLInputElement>(null);
  const all=selected.size===source.shortcuts.length;
  const partial=selected.size>0&&!all;
  const editing=source.shortcuts.find(item=>item.id===managing);
  const exportPage=written?'done':editing?'attachments':preview?'preview':'selection';
  const returnTo=useRef<string>(undefined);
  const lastPage=useRef(exportPage);
  useLayoutEffect(()=>{
    if(selectAll.current)selectAll.current.indeterminate=partial;
  },[partial,exportPage]);
  useLayoutEffect(()=>{
    if(mode!=='export'||busy||lastPage.current===exportPage)return;
    lastPage.current=exportPage;
    if(exportPage==='selection'&&returnTo.current){
      const button=exportBody.current?.querySelector<HTMLButtonElement>(`[data-attachment-for="${returnTo.current}"]`);
      returnTo.current=undefined;
      button?.focus();
      return;
    }
    exportBody.current?.querySelector<HTMLElement>('[data-export-focus]')?.focus();
  },[mode,busy,exportPage]);
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
  async function addAttachments(id:string){
    const files=await choose('attachments');
    if(live.current&&files.length){
      setAttachments(previous=>({...previous,[id]:[...new Set([...(previous[id]??[]),...files.map(file=>file.path)])]}));
    }
  }
  function leaveAttachments(){
    returnTo.current=managing;
    setManaging(undefined);
  }
  if(mode==='export'){
    const included=preview?.rows.filter(row=>row.script&&row.files.includes(row.script))??[];
    const missing=include?(preview?.rows.filter(row=>row.status==='missing')??[]):[];
    const fileCount=preview?.rows.reduce((count,row)=>count+row.files.length,0)??0;
    return <Dialog label="导出快捷指令" close={()=>{if(!inFlight.current){if(editing)leaveAttachments();else close();}}}>
      <Panel title={editing?'管理配套文件':preview&&!written?'导出预览':'导出快捷指令'}>
        <div className="shortcut-export" ref={exportBody}>
          <div className="shortcut-export-tools">
            {editing?<strong className="shortcut-export-name" title={editing.name}>{editing.name}</strong>
              :preview&&!written?<p role="status">指令 {preview.rows.length} · 脚本 {included.length} · 配套文件 {fileCount-included.length}</p>
              :!written&&<>
                <label className="check"><input type="checkbox" data-dialog-autofocus data-export-focus checked={include} disabled={busy}
                  onChange={event=>setInclude(event.target.checked)}/>包含指令引用的脚本文件</label>
                <div className="shortcut-export-tally">
                  <label className="check"><input ref={selectAll} type="checkbox" checked={all} disabled={busy}
                    onChange={()=>setSelected(all?new Set():new Set(source.shortcuts.map(item=>item.id)))}/>全选</label>
                  <span role="status">已选 {selected.size} / {source.shortcuts.length}</span>
                </div>
              </>}
          </div>
          <div className="shortcut-export-list" aria-label={editing?'配套文件':preview?'导出清单':'待导出的快捷指令'}>
            {editing?(attachments[editing.id]?.length?attachments[editing.id].map(file=><div className="shortcut-export-row" key={file}>
              <span className="shortcut-export-name" title={file}>{file.split('\\').at(-1)}</span>
              <button aria-label={'移除配套文件 '+file} disabled={busy} onClick={()=>{
                exportBody.current?.querySelector<HTMLButtonElement>('.shortcut-export-footer .primary-action')?.focus();
                setAttachments(previous=>({...previous,[editing.id]:previous[editing.id].filter(value=>value!==file)}));
              }}>移除</button>
            </div>):<p>暂无配套文件</p>):preview&&!written?<>
              {missing.length>0&&<div className="shortcut-export-missing">
                <strong>缺脚本</strong>
                <ul>{missing.map(row=><li key={row.item.id}>{row.item.name}</li>)}</ul>
              </div>}
              <details>
                <summary>查看完整清单</summary>
                {preview.rows.map(row=><details key={row.item.id}>
                  <summary>{row.item.name}{row.status==='missing'?(include?' · 缺脚本':' · 未包含脚本'):''}</summary>
                  <Details item={row.item} script={row.script}/>
                  {row.files.length>0&&<ul aria-label="包内文件">{row.files.map(file=><li key={file}>{file}</li>)}</ul>}
                </details>)}
              </details>
            </>:written?<p role="status">ZIP 已保存</p>:source.shortcuts.map(item=>{
              const checked=selected.has(item.id), count=attachments[item.id]?.length??0;
              return <div className="shortcut-export-row" key={item.id}>
                <label className="check" title={item.name}><input type="checkbox" checked={checked} disabled={busy} onChange={event=>{
                  const add=event.currentTarget.checked;
                  setSelected(previous=>{const next=new Set(previous);if(add)next.add(item.id);else next.delete(item.id);return next;});
                }}/><span className="shortcut-export-name">{item.name}</span></label>
                {item.script_path&&include&&<button data-attachment-for={item.id} disabled={busy||!checked}
                  aria-label={(count?`配套文件（${count}）`:'添加配套文件')+' '+item.name}
                  onClick={()=>{if(count)setManaging(item.id);else void run(()=>addAttachments(item.id));}}>
                  {count?`配套文件（${count}）`:'添加配套文件…'}
                </button>}
              </div>;
            })}
          </div>
          <div className="shortcut-export-footer">
            {!!error&&<p role="alert">{error}</p>}
            <div className="config-actions">
              {editing?<>
                <button data-export-focus disabled={busy} onClick={leaveAttachments}>返回选择</button>
                <button className="primary-action" disabled={busy} onClick={()=>void run(()=>addAttachments(editing.id))}>添加配套文件…</button>
              </>:written?<button className="primary-action" data-export-focus disabled={busy} onClick={close}>完成</button>:<>
                {preview&&<button data-export-focus disabled={busy} onClick={reset}>返回选择</button>}
                <button disabled={busy} onClick={close}>取消</button>
                {preview?<button className="primary-action" disabled={busy} onClick={()=>void run(async()=>{
                  const [file]=await choose('export');
                  if(file&&live.current){
                    await transfer({kind:'write_export',token:preview.token,path:file.path});
                    token.current=undefined;
                    setWritten(true);
                  }
                })}>保存 ZIP</button>:<button className="primary-action" disabled={busy||!selected.size} onClick={()=>void run(()=>show({
                  kind:'preview_export',revision:source.revision,ids:[...selected],include_scripts:include,
                  attachments:include?Object.fromEntries(Object.entries(attachments).filter(([id])=>selected.has(id))):{},
                }))}>下一步：预览</button>}
              </>}
            </div>
          </div>
        </div>
      </Panel>
    </Dialog>;
  }
  const title='导入快捷指令';
  return <Dialog label={title} wide close={()=>{if(!inFlight.current)close();}}>
    <Panel title={title}>
      {!preview&&!counts&&<button data-dialog-autofocus disabled={busy} onClick={()=>void run(async()=>{
        const [file]=await choose('import');
        if(file&&live.current)await show({kind:'preview_import',path:file.path});
      })}>选择 ZIP</button>}
      {preview&&!counts&&<>
        <p>{Object.entries(labels).map(([status,label])=>label+' '+preview.rows.filter(row=>row.status===status).length).join(' · ')}</p>
        <div className="shortcut-transfer-rows">
          {preview.rows.map(row=><details key={row.item.id}>
            <summary>{row.item.name} · {labels[row.status]}</summary>
            <Details item={row.item} script={row.script}/>
            {row.files.length>0&&<ul aria-label="包内文件">{row.files.map(file=><li key={file}>{file}</li>)}</ul>}
            {row.existing.map(item=><div key={item.id}><strong>本机 · {item.name}</strong><Details item={item}/></div>)}
          </details>)}
          {preview.rows.filter(row=>row.status==='conflict').map(row=><label key={row.item.id}>
            {row.item.name} <select aria-label={'冲突处理 '+row.item.name} disabled={busy} value={decisions[row.item.id]??'skip'}
              onChange={event=>setDecisions({...decisions,[row.item.id]:event.target.value as Decision})}>
              <option value="skip">跳过</option><option value="keep">保留两份</option>
              <option value="replace" disabled={row.existing.length!==1}>替换</option>
            </select>
          </label>)}
        </div>
        <div className="config-actions">
          <button disabled={busy} onClick={reset}>重新选择 ZIP</button>
          <button disabled={busy} onClick={()=>void run(async()=>{
            const result=await transfer<Counts>({kind:'apply_import',token:preview.token,decisions});
            token.current=undefined;setCounts(result);
            if(result.added+result.replaced)await applied();
          })}>确认导入</button>
        </div>
      </>}
      {counts&&<p role="status">新增 {counts.added} · 替换 {counts.replaced} · 完全相同 {counts.same} · 跳过 {counts.skipped} · 缺脚本 {counts.missing}</p>}
      {error&&<p role="alert">{error}</p>}
      <button disabled={busy} onClick={close}>{counts?'完成':'取消'}</button>
    </Panel>
  </Dialog>;
}
