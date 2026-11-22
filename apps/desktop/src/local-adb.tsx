import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {ContextMenu, ControlIcon, Dialog, Field, IconButton, Panel} from './ui';
import {insertShortcuts,setShortcutPins,stepShortcuts} from './local-shortcut-order';
import {useShortcutDrag} from './local-shortcut-drag';

export type AdbShortcut = {id:string; name:string; command?:string; script_path?:string; pinned?:boolean};
type ShortcutLayout = {columns:1|2; expanded:boolean};
export type AdbSettings = {revision:string|null; executable:string|null; shortcuts:AdbShortcut[]; layout?:ShortcutLayout};
export type AdbIntent = {button:string; revision:string; request:string};
type AdbDevice = {serial:string; state:string};
export type AdbDiagnostic = {image:string|null; enumeration:string|null; stdout:string; stderr:string; environment:[string,string][]; error:string|null};
export type AdbChoice = {devices:AdbDevice[]; select:boolean; inherited_target:string|null; diagnostic:AdbDiagnostic};

export function loadAdbSettings() {
  return invoke<AdbSettings>('local_adb_settings', {settings:null});
}

type Editor = {kind:'shortcut'; item:AdbShortcut; revision:string|null} | {kind:'settings'; path:string; revision:string|null};
const DEFAULT_LAYOUT:ShortcutLayout={columns:1,expanded:false};
const noShortcuts:AdbShortcut[]=[];
type Removal={snapshot:AdbSettings; ids:ReadonlySet<string>};

export function AdbShortcutPanel({id, open, settings, starting, keyboardFocus, close, reload, execute, diagnostics}: {
  id:string; open:boolean; settings?:AdbSettings; starting:boolean; close():void; reload():Promise<void>;
  execute(item:AdbShortcut, revision:string):void;
  diagnostics:Readonly<Record<string, AdbDiagnostic>>;
  keyboardFocus?:number;
}) {
  const [editor, setEditor] = useState<Editor>();
  const [menu, setMenu] = useState<{id:string; anchor:HTMLButtonElement}>();
  const [addMenu, setAddMenu] = useState<HTMLButtonElement>();
  const [diagnosticId, setDiagnosticId] = useState<string>();
  const diagnosticPanel = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [feedback,setFeedback]=useState('');
  const [managing,setManaging]=useState(false);
  const [selection,setSelection]=useState<ReadonlySet<string>>(()=>new Set());
  const [removal,setRemoval]=useState<Removal>();
  const scrollBody=useRef<HTMLDivElement>(null);
  const manageButton=useRef<HTMLButtonElement>(null);
  const pendingFocus=useRef<string>(undefined);
  const focusedRequest=useRef<number>(undefined);
  const saving = useRef(false);
  const items=settings?.shortcuts??noShortcuts;
  const layout=settings?.layout??DEFAULT_LAYOUT;
  const picked=items.filter(item=>selection.has(item.id));
  const pinnedItems=items.filter(item=>item.pinned);
  const regularItems=items.filter(item=>!item.pinned);
  const canAdd = !!settings && settings.shortcuts.length < 32 && !busy && !editor && !managing;
  const diagnostic = diagnosticId ? diagnostics[diagnosticId] : undefined;
  useEffect(()=>{
    if(!open){
      setMenu(undefined);setAddMenu(undefined);setManaging(false);setRemoval(undefined);
      setSelection(new Set());setFeedback('');
    }
  },[open]);
  useEffect(()=>{
    const ids=new Set(items.map(item=>item.id));
    setSelection(previous=>previous.size&&[...previous].some(id=>!ids.has(id))
      ?new Set([...previous].filter(id=>ids.has(id))):previous);
  },[items]);
  useLayoutEffect(()=>{
    if(busy||!pendingFocus.current||!open)return;
    const target=pendingFocus.current;
    pendingFocus.current=undefined;
    scrollBody.current?.querySelector<HTMLElement>(`[data-sort-handle="${target}"]`)?.focus({preventScroll:false});
  },[settings?.revision,busy,open]);
  useLayoutEffect(()=>{
    if(!open||keyboardFocus===undefined||focusedRequest.current===keyboardFocus)return;
    const body=scrollBody.current;
    if(!body)return;
    const target=body.querySelector<HTMLElement>('.adb-shortcut-run, .adb-shortcut-select input, button, input');
    if(target){
      target.focus();
      if(settings||editor)focusedRequest.current=keyboardFocus;
    }else if(settings){
      manageButton.current?.focus();
      focusedRequest.current=keyboardFocus;
    }
  },[open,keyboardFocus,items,settings,editor,managing]);
  useEffect(()=>{if(open&&diagnosticId)diagnosticPanel.current?.scrollIntoView({block:'nearest'});},[open,diagnosticId]);
  function edit(item:AdbShortcut) {
    if (!settings) return;
    setFailure('');
    setEditor({kind:'shortcut', item:{...item}, revision:settings.revision});
  }
  function add() {
    edit({id:crypto.randomUUID(), name:'', command:''});
  }
  async function selectScripts(replace?:AdbShortcut) {
    if(!settings||saving.current)return;
    saving.current=true;
    setBusy(true);
    setFailure('');
    let next:AdbSettings|undefined;
    try {
      const selected=await invoke<{name:string;path:string}[]>('pick_local_scripts',{multiple:!replace});
      if(!selected.length)return;
      if(replace){
        next={...settings,shortcuts:settings.shortcuts.map(item=>item.id===replace.id?{...item,script_path:selected[0].path}:item)};
      }else{
        const paths=new Set(settings.shortcuts.map(item=>item.script_path?.toLowerCase()));
        const added=selected.filter(file=>{
          const key=file.path.toLowerCase();
          if(paths.has(key))return false;
          paths.add(key);return true;
        }).map(file=>({id:crypto.randomUUID(),name:file.name,script_path:file.path}));
        if(!added.length){setFailure('所选脚本已在列表中');return;}
        next={...settings,shortcuts:[...settings.shortcuts,...added]};
      }
    }catch(error){setFailure(String(error));}
    finally{saving.current=false;setBusy(false);}
    if(next)await save(next);
  }
  async function save(next:AdbSettings, message='已保存', focus?:string) {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setFailure('');
    setFeedback('');
    try {
      await invoke('local_adb_settings', {settings:next});
      pendingFocus.current=focus;
      await reload();
      setEditor(undefined);
      setFeedback(message);
      return true;
    } catch (error) {
      setFailure(String(error));
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function submit() {
    if (!settings || !editor) return;
    const next = {...settings, revision:editor.revision};
    if (editor.kind==='settings') {
      void save({...next, executable:editor.path.trim()||null});
    } else {
      const index = settings.shortcuts.findIndex(item=>item.id===editor.item.id);
      const shortcuts = [...settings.shortcuts];
      if (index < 0) shortcuts.push(editor.item);
      else shortcuts[index] = editor.item;
      void save({...next, shortcuts});
    }
  }
  function move(ids:ReadonlySet<string>, step:-1|1, focus?:string) {
    if (!settings) return;
    const shortcuts=stepShortcuts(items,ids,step);
    if(shortcuts)void save({...settings,shortcuts},'顺序已保存',focus);
  }
  function pin(ids:ReadonlySet<string>,pinned:boolean){
    if(settings)void save({...settings,shortcuts:setShortcutPins(items,ids,pinned)},pinned?'已置顶':'已取消置顶');
  }
  const drag=useShortcutDrag(scrollBody,settings?.revision??null,open&&managing&&!busy&&!removal,selection,(gesture,target)=>{
    if(!settings)return;
    const shortcuts=insertShortcuts(items,gesture.selected,gesture.id,target.id,target.after);
    if(shortcuts)void save({...settings,shortcuts},'顺序已保存',gesture.id);
  });
  function toggleSelection(id:string){
    setSelection(current=>{
      const next=new Set(current);
      if(next.has(id))next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function confirmRemoval(){
    if(!removal||!settings||settings.revision!==removal.snapshot.revision)return;
    const {snapshot,ids}=removal;
    if(await save({...snapshot,shortcuts:snapshot.shortcuts.filter(item=>!ids.has(item.id))},`已移除 ${ids.size} 条入口`)){
      setRemoval(undefined);
      setSelection(new Set());
    }
  }
  function renderRow(item:AdbShortcut){
    const isPinned=!!item.pinned, single=new Set([item.id]);
    const target=drag.preview?.id===item.id?drag.preview:undefined;
    const detail=item.script_path?'本地脚本 · '+item.script_path:'ADB · '+item.command;
    const content=<><span>{item.name}</span><code>{detail}</code></>;
    return <li key={item.id} data-shortcut-id={item.id} data-pinned={isPinned}
      data-drag-source={drag.preview?.source===item.id||undefined}
      data-drop={target?(target.after?'after':'before'):undefined} data-drop-horizontal={target?.horizontal||undefined}>
      {managing?<><label className="adb-shortcut-select">
        <input type="checkbox" checked={selection.has(item.id)} disabled={busy} aria-label={`选择 ${item.name}`}
          onChange={()=>toggleSelection(item.id)}/>
        <span className="adb-shortcut-text">{content}</span>
      </label>
      <button type="button" className="adb-sort-handle" data-sort-handle={item.id} aria-label={`调整 ${item.name} 的顺序`}
        title="拖动排序，或按 ↑ / ↓ 调整" disabled={busy} {...drag.bindings(item.id,isPinned)}
        onKeyDown={event=>{
          if(event.key==='Escape'&&drag.active()){
            event.preventDefault();event.stopPropagation();drag.cancel();return;
          }
          if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
          event.preventDefault();
          if(!event.repeat)move(selection.has(item.id)?selection:single,event.key==='ArrowUp'?-1:1,item.id);
        }}><span aria-hidden="true">⠿</span></button></>:<>
      <button type="button" className="adb-shortcut-run adb-shortcut-text" aria-label={item.name} title={item.script_path??item.command}
        aria-disabled={starting||busy} onKeyDown={event=>{
          if(event.key==='Enter'){
            event.preventDefault();
            if(!event.repeat&&!event.nativeEvent.isComposing&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey)event.currentTarget.click();
          }else if(event.key==='ArrowUp'||event.key==='ArrowDown'){
            if(event.nativeEvent.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
            const buttons=Array.from(scrollBody.current?.querySelectorAll<HTMLButtonElement>('.adb-shortcut-run')??[]);
            const index=buttons.indexOf(event.currentTarget);
            if(index<0)return;
            event.preventDefault();
            buttons[(index+buttons.length+(event.key==='ArrowUp'?-1:1))%buttons.length]?.focus();
          }else if(event.repeat&&event.key===' ')event.preventDefault();
        }} onClick={event=>{
          if(!managing&&!starting&&!saving.current&&event.detail<=1&&settings?.revision)execute(item,settings.revision);
        }}>{content}</button>
      <button type="button" className="adb-row-menu-trigger" aria-label={item.name+' 的管理操作'}
        aria-haspopup="menu" aria-expanded={menu?.id===item.id}
        onClick={event=>setMenu(menu?.id===item.id?undefined:{id:item.id,anchor:event.currentTarget})}><ControlIcon icon="more"/></button>
      {diagnostics[item.id]?.error&&<button type="button" className="adb-row-menu-trigger adb-diagnostic-alert" aria-label={item.name+' 的失败详情'}
        title={diagnostics[item.id].error??undefined} onClick={()=>setDiagnosticId(item.id)}>!</button>}
      {open&&menu?.id===item.id&&<ContextMenu className="adb-row-menu" label={item.name+' 的管理菜单'}
        x={0} y={0} anchor={menu.anchor} anchored close={()=>setMenu(undefined)}>
        <button role="menuitem" type="button" disabled={busy} onClick={()=>{setMenu(undefined);edit(item);}}>编辑</button>
        <button role="menuitem" type="button" disabled={busy} onClick={()=>{setMenu(undefined);pin(single,!isPinned);}}>{isPinned?'取消置顶':'置顶'}</button>
        <button role="menuitem" type="button" disabled={busy||!stepShortcuts(items,single,-1)} onClick={()=>{setMenu(undefined);move(single,-1);}}>上移</button>
        <button role="menuitem" type="button" disabled={busy||!stepShortcuts(items,single,1)} onClick={()=>{setMenu(undefined);move(single,1);}}>下移</button>
        {item.script_path
          ?<button role="menuitem" type="button" disabled={busy} onClick={()=>{setMenu(undefined);void selectScripts(item);}}>重新定位</button>
          :<button role="menuitem" type="button" disabled={!diagnostics[item.id]} onClick={()=>{setMenu(undefined);setDiagnosticId(item.id);}}>查看最近诊断</button>}
        <button role="menuitem" type="button" disabled={busy} onClick={()=>{
          setMenu(undefined);
          if(settings)void save({...settings,shortcuts:items.filter(row=>row.id!==item.id)},'已移除入口');
        }}>删除</button>
      </ContextMenu>}</>}
    </li>;
  }
  return <aside id={id} className="adb-shortcut-panel" aria-label="快捷指令" data-expanded={layout.expanded} data-columns={layout.columns} hidden={!open}>
    <div className="adb-panel-heading">
      <h2>快捷指令</h2>
      <IconButton icon="plus" label="新建快捷指令" disabled={!canAdd} aria-haspopup="menu" aria-expanded={!!addMenu}
        onClick={event=>setAddMenu(addMenu?undefined:event.currentTarget)}/>
      <IconButton icon="collapse" label="收起快捷指令" onClick={close}/>
    </div>
    {!editor&&settings&&<div className="adb-panel-controls" aria-label="快捷指令显示与管理">
      {([1,2] as const).map(columns=>{
        const name=columns===1?'单列':'双列';
        return <button key={columns} type="button" aria-label={name+'显示'} aria-pressed={layout.columns===columns} disabled={busy}
          onClick={()=>{if(layout.columns!==columns)void save({...settings,layout:{...layout,columns}},'已切换'+name);}}>{name}</button>;
      })}
      <button type="button" aria-pressed={layout.expanded} disabled={busy}
        onClick={()=>void save({...settings,layout:{...layout,expanded:!layout.expanded}},layout.expanded?'已收起总览':'已展开全部指令')}>{layout.expanded?'收起总览':'全部展开'}</button>
      <button type="button" ref={manageButton} aria-pressed={managing} disabled={busy||!items.length&&!managing}
        onClick={()=>{setManaging(!managing);setSelection(new Set());setMenu(undefined);setAddMenu(undefined);}}>{managing?'完成管理':'管理'}</button>
    </div>}
    {managing&&settings&&<div className="adb-bulk-controls" aria-label="批量操作">
      <span role="status" aria-label="已选指令">已选 {picked.length} / {items.length}</span>
      <button type="button" disabled={busy||picked.length===items.length} onClick={()=>setSelection(new Set(items.map(item=>item.id)))}>全选</button>
      <button type="button" disabled={busy||!picked.length} onClick={()=>setSelection(new Set())}>清除</button>
      <button type="button" disabled={busy||!picked.some(item=>!item.pinned)} onClick={()=>pin(selection,true)}>置顶</button>
      <button type="button" disabled={busy||!picked.some(item=>item.pinned)} onClick={()=>pin(selection,false)}>取消置顶</button>
      <button type="button" disabled={busy||!stepShortcuts(items,selection,-1)} onClick={()=>move(selection,-1)}>上移</button>
      <button type="button" disabled={busy||!stepShortcuts(items,selection,1)} onClick={()=>move(selection,1)}>下移</button>
      <button type="button" disabled={busy||!picked.length} onClick={()=>{setFailure('');setRemoval({snapshot:settings,ids:new Set(picked.map(item=>item.id))});}}>移除所选</button>
    </div>}
    <div className="adb-panel-body" ref={scrollBody}>
      {editor ? <form aria-label={editor.kind==='settings'?'ADB 设置':'快捷指令编辑'} onSubmit={event=>{event.preventDefault();submit();}}>
        <fieldset disabled={busy}>
          {editor.kind==='settings'
            ? <Field label="ADB 程序路径"><input autoFocus aria-label="ADB 程序路径" value={editor.path} placeholder="留空使用 PATH"
              onChange={event=>setEditor({...editor,path:event.target.value})}/></Field>
            : <>
              <Field label="名称"><input autoFocus aria-label="指令名称" value={editor.item.name} maxLength={64}
                onChange={event=>setEditor({...editor,item:{...editor.item,name:event.target.value}})}/></Field>
              {editor.item.script_path?<Field label="脚本路径"><input value={editor.item.script_path} readOnly/></Field>
                :<Field label="完整 ADB 命令"><textarea aria-label="完整 ADB 命令" rows={5} wrap="soft" spellCheck={false} maxLength={8192}
                  value={editor.item.command??''} placeholder="adb devices -l"
                  onChange={event=>setEditor({...editor,item:{...editor.item,command:event.target.value}})}/></Field>}
            </>}
          <div className="config-actions">
            <button type="button" onClick={()=>{setEditor(undefined);setFailure('');}}>取消编辑</button>
            <button type="submit">{editor.kind==='settings'?'保存 ADB 设置':'保存指令'}</button>
          </div>
        </fieldset>
      </form> : !settings ? <button type="button" onClick={reload}>读取 ADB 快捷指令</button>
        : !items.length ? <button type="button" className="adb-empty" disabled={managing} onClick={event=>setAddMenu(event.currentTarget)}>添加第一条指令</button>
        : <>
          {!!pinnedItems.length&&<section aria-label="置顶指令">
            <h3 className="adb-list-heading">置顶</h3>
            <ul className="adb-shortcut-list">{pinnedItems.map(renderRow)}</ul>
          </section>}
          {!!regularItems.length&&<section aria-label="普通指令">
            {!!pinnedItems.length&&<h3 className="adb-list-heading">普通</h3>}
            <ul className="adb-shortcut-list">{regularItems.map(renderRow)}</ul>
          </section>}
        </>}
      {diagnostic&&<section ref={diagnosticPanel} className="adb-diagnostic" aria-label="最近 ADB 诊断">
        <div className="adb-panel-heading"><h2>最近 ADB 诊断</h2><IconButton icon="close" label="关闭 ADB 诊断" onClick={()=>setDiagnosticId(undefined)}/></div>
        {diagnostic.error&&<p role="alert">{diagnostic.error}</p>}
        <dl><dt>ADB 程序</dt><dd>{diagnostic.image??'未定位'}</dd>
          <dt>枚举参数</dt><dd>{diagnostic.enumeration??'本次未枚举'}</dd>
          {!!diagnostic.environment.length&&<><dt>ADB 环境</dt><dd>{diagnostic.environment.map(([key,value])=>key+'='+value).join('\n')}</dd></>}
        </dl>
        {diagnostic.stdout&&<pre aria-label="ADB 枚举输出">{diagnostic.stdout}</pre>}
        {diagnostic.stderr&&<pre aria-label="ADB 枚举错误输出">{diagnostic.stderr}</pre>}
      </section>}
    </div>
    {!removal&&failure&&<div className="adb-panel-error">
      <small role="alert">{failure}</small>
      <button type="button" disabled={busy} onClick={()=>{reload();setFailure('');}}>重新读取快捷指令</button>
    </div>}
    <div className="adb-panel-footer">
      <button type="button" disabled={!settings||busy||!!editor||managing} onClick={()=>{
        if(settings){setFailure('');setEditor({kind:'settings',path:settings.executable??'',revision:settings.revision});}
      }}>ADB 设置</button>
      {!!feedback&&<small role="status">{feedback}</small>}
    </div>
    {open&&addMenu&&<ContextMenu className="adb-row-menu" label="新建指令类型" x={0} y={0} anchor={addMenu}
      anchored close={()=>setAddMenu(undefined)}>
      <button role="menuitem" type="button" onClick={()=>{setAddMenu(undefined);add();}}>ADB 命令</button>
      <button role="menuitem" type="button" onClick={()=>{setAddMenu(undefined);void selectScripts();}}>本地脚本</button>
    </ContextMenu>}
    {open&&removal&&<Dialog label="移除快捷指令" close={()=>{if(!saving.current)setRemoval(undefined);}}
      fallbackFocus={()=>manageButton.current?.focus()}>
      <Panel title="移除快捷指令">
        <p>移除 {removal.ids.size} 条快捷入口？脚本文件会保留。</p>
        {settings?.revision!==removal.snapshot.revision&&<p role="alert">快捷指令已更新，请取消后重新选择。</p>}
        {!!failure&&<p role="alert">{failure}</p>}
        <div className="config-actions">
          <button type="button" disabled={busy} data-dialog-autofocus onClick={()=>setRemoval(undefined)}>取消移除</button>
          <button type="button" disabled={busy||settings?.revision!==removal.snapshot.revision}
            onClick={()=>void confirmRemoval()}>确认移除 {removal.ids.size} 条</button>
        </div>
      </Panel>
    </Dialog>}
  </aside>;
}

export function AdbDeviceDialog({devices, choose, close}: {devices:AdbDevice[]; choose(serial:string):void; close():void}) {
  const [target, setTarget] = useState('');
  return <Dialog label="选择本次 ADB 设备" close={close} modal={false}>
    <h2>选择本次 ADB 设备</h2>
    <Field label="设备">
      <select aria-label="本次 ADB 设备" value={target} onChange={event=>setTarget(event.target.value)}>
        <option value="">请选择设备</option>
        {devices.map(device=><option key={device.serial} disabled={device.state!=='device'} value={device.serial}>
          {device.serial} · {device.state}</option>)}
      </select>
    </Field>
    <div className="config-actions">
      <button type="button" data-dialog-autofocus onClick={close}>取消本次操作</button>
      <button type="button" disabled={!target} onClick={()=>choose(target)}>执行到所选设备</button>
    </div>
  </Dialog>;
}
