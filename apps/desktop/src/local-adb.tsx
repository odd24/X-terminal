import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {ContextMenu, ControlIcon, Dialog, Field, IconButton} from './ui';

export type AdbShortcut = {id:string; name:string; command?:string; script_path?:string};
export type AdbSettings = {revision:string|null; executable:string|null; shortcuts:AdbShortcut[]};
export type AdbIntent = {button:string; revision:string; request:string};
type AdbDevice = {serial:string; state:string};
export type AdbDiagnostic = {image:string|null; enumeration:string|null; stdout:string; stderr:string; environment:[string,string][]; error:string|null};
export type AdbChoice = {devices:AdbDevice[]; select:boolean; inherited_target:string|null; diagnostic:AdbDiagnostic};

export function loadAdbSettings() {
  return invoke<AdbSettings>('local_adb_settings', {settings:null});
}

type Editor = {kind:'shortcut'; item:AdbShortcut; revision:string|null} | {kind:'settings'; path:string; revision:string|null};

export function AdbShortcutPanel({id, open, settings, starting, close, reload, update, execute, diagnostics}: {
  id:string; open:boolean; settings?:AdbSettings; starting:boolean; close():void; reload():void;
  update(value:AdbSettings):void; execute(item:AdbShortcut, revision:string):void;
  diagnostics:Readonly<Record<string, AdbDiagnostic>>;
}) {
  const [editor, setEditor] = useState<Editor>();
  const [menu, setMenu] = useState<{id:string; anchor:HTMLButtonElement}>();
  const [addMenu, setAddMenu] = useState<HTMLButtonElement>();
  const [diagnosticId, setDiagnosticId] = useState<string>();
  const diagnosticPanel = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const saving = useRef(false);
  const canAdd = !!settings && settings.shortcuts.length < 32 && !busy && !editor;
  const diagnostic = diagnosticId ? diagnostics[diagnosticId] : undefined;
  useEffect(()=>{if(!open){setMenu(undefined);setAddMenu(undefined);}},[open]);
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
  async function save(next:AdbSettings) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setFailure('');
    try {
      const value = await invoke<AdbSettings>('local_adb_settings', {settings:next});
      update(value);
      setEditor(undefined);
    } catch (error) {
      setFailure(String(error));
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
  function move(index:number, step:number) {
    if (!settings) return;
    const shortcuts = [...settings.shortcuts];
    [shortcuts[index], shortcuts[index+step]] = [shortcuts[index+step], shortcuts[index]];
    void save({...settings, shortcuts});
  }
  return <aside id={id} className="adb-shortcut-panel" aria-label="快捷指令" hidden={!open}>
    <div className="adb-panel-heading">
      <h2>快捷指令</h2>
      <IconButton icon="plus" label="新建快捷指令" disabled={!canAdd} aria-haspopup="menu" aria-expanded={!!addMenu}
        onClick={event=>setAddMenu(addMenu?undefined:event.currentTarget)}/>
      <IconButton icon="collapse" label="收起快捷指令" onClick={close}/>
    </div>
    <div className="adb-panel-body">
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
        : !settings.shortcuts.length ? <button type="button" className="adb-empty" onClick={event=>setAddMenu(event.currentTarget)}>添加第一条指令</button>
        : <ul className="adb-shortcut-list">{settings.shortcuts.map((item,index)=><li key={item.id}>
          <button type="button" className="adb-shortcut-run" aria-label={item.name} title={item.script_path??item.command}
            aria-disabled={starting} onKeyDown={event=>{if(event.repeat&&(event.key==='Enter'||event.key===' '))event.preventDefault();}} onClick={event=>{
              if (!starting && event.detail <= 1 && settings.revision) execute(item,settings.revision);
            }}><span>{item.name}</span><code>{item.script_path?'本地脚本 · '+item.script_path:'ADB · '+item.command}</code></button>
          <button type="button" className="adb-row-menu-trigger" aria-label={item.name+' 的管理操作'}
            aria-haspopup="menu" aria-expanded={menu?.id===item.id}
            onClick={event=>setMenu(menu?.id===item.id?undefined:{id:item.id,anchor:event.currentTarget})}><ControlIcon icon="more"/></button>
          {diagnostics[item.id]?.error&&<button type="button" className="adb-row-menu-trigger adb-diagnostic-alert" aria-label={item.name+' 的失败详情'}
            title={diagnostics[item.id].error??undefined} onClick={()=>setDiagnosticId(item.id)}>!</button>}
          {open&&menu?.id===item.id&&<ContextMenu className="adb-row-menu" label={item.name+' 的管理菜单'}
            x={0} y={0} anchor={menu.anchor} anchored close={()=>setMenu(undefined)}>
            <button role="menuitem" type="button" disabled={busy} onClick={()=>{setMenu(undefined);edit(item);}}>编辑</button>
            <button role="menuitem" type="button" disabled={busy||index===0} onClick={()=>{setMenu(undefined);move(index,-1);}}>上移</button>
            <button role="menuitem" type="button" disabled={busy||index===settings.shortcuts.length-1} onClick={()=>{setMenu(undefined);move(index,1);}}>下移</button>
            {item.script_path
              ?<button role="menuitem" type="button" disabled={busy} onClick={()=>{setMenu(undefined);void selectScripts(item);}}>重新定位</button>
              :<button role="menuitem" type="button" disabled={!diagnostics[item.id]} onClick={()=>{setMenu(undefined);setDiagnosticId(item.id);}}>查看最近诊断</button>}
            <button role="menuitem" type="button" disabled={busy} onClick={()=>{
              setMenu(undefined);
              void save({...settings,shortcuts:settings.shortcuts.filter(row=>row.id!==item.id)});
            }}>删除</button>
          </ContextMenu>}
        </li>)}</ul>}
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
      {failure&&<p role="alert">{failure}</p>}
    </div>
    <div className="adb-panel-footer">
      <button type="button" disabled={!settings||busy||!!editor} onClick={()=>{
        if(settings){setFailure('');setEditor({kind:'settings',path:settings.executable??'',revision:settings.revision});}
      }}>ADB 设置</button>
    </div>
    {open&&addMenu&&<ContextMenu className="adb-row-menu" label="新建指令类型" x={0} y={0} anchor={addMenu}
      anchored close={()=>setAddMenu(undefined)}>
      <button role="menuitem" type="button" onClick={()=>{setAddMenu(undefined);add();}}>ADB 命令</button>
      <button role="menuitem" type="button" onClick={()=>{setAddMenu(undefined);void selectScripts();}}>本地脚本</button>
    </ContextMenu>}
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
