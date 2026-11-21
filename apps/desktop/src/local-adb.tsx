import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Dialog, Field} from './ui';

export type AdbShortcut = {id:string; name:string; command:string};
export type AdbSettings = {revision:string|null; executable:string|null; shortcuts:AdbShortcut[]};
export type AdbIntent = {button:string; revision:string; request:string};
type AdbDevice = {serial:string; state:string};
export type AdbChoice = {devices:AdbDevice[]; select:boolean; inherited_target:string|null};

export function loadAdbSettings() {
  return invoke<AdbSettings>('local_adb_settings', {settings:null});
}

export function AdbEditor({initial, close, update}: {initial:AdbSettings; close():void; update(value:AdbSettings):void}) {
  const [draft, setDraft] = useState(initial);
  const [id, setId] = useState(initial.shortcuts[0]?.id);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const index = draft.shortcuts.findIndex(button => button.id === id);
  const selected = draft.shortcuts[index];
  function modify(patch:Partial<AdbShortcut>) {
    setDraft(current=>({...current, shortcuts:current.shortcuts.map(button=>button.id===id?{...button,...patch}:button)}));
  }
  function add() {
    const button = {id:crypto.randomUUID(), name:'', command:''};
    setDraft(current=>({...current, shortcuts:[...current.shortcuts, button]}));
    setId(button.id);
  }
  function move(direction:number) {
    const shortcuts = [...draft.shortcuts];
    const [button] = shortcuts.splice(index, 1);
    shortcuts.splice(index+direction, 0, button);
    setDraft({...draft, shortcuts});
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    setFailure('');
    try {
      const value = await invoke<AdbSettings>('local_adb_settings', {settings:{...draft, executable:draft.executable?.trim()||null}});
      update(value);
      close();
    } catch (error) {
      setFailure(String(error));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog label="ADB 快捷操作设置" close={()=>{if(!busy)close();}}>
    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <h2>ADB 快捷操作</h2>
      <fieldset disabled={busy}>
        <Field label="ADB 程序路径">
          <input aria-label="ADB 程序路径" value={draft.executable??''} placeholder="留空使用 PATH"
            onChange={event=>setDraft({...draft, executable:event.target.value})}/>
        </Field>
        <Field label="按钮">
          <select aria-label="已保存 ADB 按钮" value={id??''} onChange={event=>setId(event.target.value)}>
            {!draft.shortcuts.length&&<option value="">暂无按钮</option>}
            {draft.shortcuts.map(button=><option key={button.id} value={button.id}>{button.name||'未命名按钮'}</option>)}
          </select>
        </Field>
        <div className="config-actions">
          <button type="button" onClick={add} disabled={draft.shortcuts.length>=32}>新建按钮</button>
          {selected&&<>
            <button type="button" disabled={index===0} onClick={()=>move(-1)}>上移</button>
            <button type="button" disabled={index===draft.shortcuts.length-1} onClick={()=>move(1)}>下移</button>
            <button type="button" onClick={()=>{
              const shortcuts=draft.shortcuts.filter(button=>button.id!==id);
              setDraft({...draft,shortcuts});setId(shortcuts[Math.min(index,shortcuts.length-1)]?.id);
            }}>移除按钮</button>
          </>}
        </div>
        {selected&&<>
          <Field label="按钮名称"><input aria-label="按钮名称" value={selected.name} maxLength={64}
            onChange={event=>modify({name:event.target.value})}/></Field>
          <Field label="完整 ADB 命令"><input aria-label="完整 ADB 命令" value={selected.command} maxLength={8192}
            placeholder="adb devices -l" onChange={event=>modify({command:event.target.value})}/></Field>
        </>}
      </fieldset>
      {failure&&<p role="alert">{failure}</p>}
      <div className="config-actions">
        <button type="button" data-dialog-autofocus disabled={busy} onClick={close}>取消编辑</button>
        <button type="submit" disabled={busy}>{busy?'正在保存…':'保存 ADB 快捷设置'}</button>
      </div>
    </form>
  </Dialog>;
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
