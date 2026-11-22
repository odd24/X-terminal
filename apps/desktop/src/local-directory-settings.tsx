import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';

type DirectorySettings = {
  saved_path: string|null;
  desktop_path: string|null;
  effective_path: string|null;
  warning: string|null;
};

export function LocalDirectorySettings() {
  const [settings,setSettings]=useState<DirectorySettings>();
  const [busy,setBusy]=useState(true);
  const [message,setMessage]=useState('');
  const [failure,setFailure]=useState('');
  const active=useRef(false);

  async function update(action:'read'|'choose'|'restore') {
    setBusy(true);
    setMessage('');
    setFailure('');
    try {
      const next=await invoke<DirectorySettings|null>('local_directory_settings',{action});
      if(!active.current)return;
      if(next)setSettings(next);
      if(action==='choose')setMessage(next?'默认目录已保存':'已取消选择');
      if(action==='restore')setMessage('已恢复使用桌面');
    } catch(error) {
      if(active.current)setFailure(String(error));
    } finally {
      if(active.current)setBusy(false);
    }
  }

  useEffect(()=>{
    active.current=true;
    void update('read');
    return ()=>{active.current=false;};
  },[]);

  return <section aria-label="本地终端默认目录" className="local-directory-settings">
    <dl>
      <dt>默认目录</dt>
      <dd aria-label="默认目录">{settings?(settings.saved_path??settings.desktop_path??'桌面位置不可用'):'正在读取…'}</dd>
      {settings?.warning&&<>
        <dt>实际打开位置</dt>
        <dd aria-label="实际打开位置">{settings.effective_path??'没有可用目录'}</dd>
      </>}
    </dl>
    <div className="config-actions">
      <button type="button" disabled={busy} onClick={()=>void update('choose')}>选择文件夹</button>
      <button type="button" disabled={busy||!settings?.saved_path} onClick={()=>void update('restore')}>恢复桌面</button>
    </div>
    <small>选择或恢复后自动保存，下次新建 PowerShell 或轻量命令行时生效。</small>
    {settings?.warning&&<div role="alert">{settings.warning}</div>}
    {failure&&<div role="alert">{failure}</div>}
    {message&&<div role="status">{message}</div>}
  </section>;
}
