import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Field } from './ui';

export type LocalRightClick = 'smart' | 'menu';

export function useLocalRightClick(enabled:boolean, changed:()=>void) {
  const [mode,setMode]=useState<LocalRightClick>();
  const [busy,setBusy]=useState(enabled);
  const [message,setMessage]=useState('');
  const flight=useRef(false);
  const callback=useRef(changed);
  callback.current=changed;
  async function load(next:LocalRightClick|null) {
    if(!enabled||flight.current)return;
    flight.current=true;
    setBusy(true);setMessage('');
    try {
      const value=await invoke<LocalRightClick>('local_right_click',{mode:next});
      if(value!=='smart'&&value!=='menu')throw new Error();
      callback.current();
      setMode(value);
      if(next)setMessage('已保存');
    } catch {
      callback.current();
      setMode(undefined);
      setMessage(next?'保存结果未确认，请重新读取。':'无法读取右键设置，请重新读取。');
    } finally {
      flight.current=false;setBusy(false);
    }
  }
  useEffect(()=>{void load(null);},[enabled]);
  return {mode,busy,message,change:(value:LocalRightClick)=>void load(value),reload:()=>void load(null)};
}

export function LocalRightClickSetting(state:ReturnType<typeof useLocalRightClick>) {
  return <section className="local-directory-settings" aria-label="本地终端右键">
    <Field label="终端右键行为">
      <select aria-label="终端右键行为" value={state.mode??''} disabled={state.busy||!state.mode}
        onChange={event=>state.change(event.target.value as LocalRightClick)}>
        {!state.mode&&<option value="">未读取设置</option>}
        <option value="smart">有选区时复制，无选区时粘贴</option>
        <option value="menu">显示菜单</option>
      </select>
    </Field>
    {state.message&&<div role="status">{state.message}</div>}
    {state.message&&state.message!=='已保存'&&<button disabled={state.busy} onClick={state.reload}>重新读取右键设置</button>}
  </section>;
}
