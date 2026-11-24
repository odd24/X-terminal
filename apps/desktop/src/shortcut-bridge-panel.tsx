import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { uuid } from './agent-management';

const scopes = {
  view:'查看',manage:'管理',extended_view:'扩展查看',extended_manage:'扩展管理',
  description_view:'描述查看',description_manage:'描述管理',
} as const;
type Scope = keyof typeof scopes;
type Remaining = `${Scope}_remaining_ms`;
type Peer = {pending_id:string;pid:number} & Record<Remaining,number>;
type Preview = {preview_id:string;pending_id:string;pid:number;scope:Scope;seconds:number};
const scopeKeys = Object.keys(scopes) as Scope[];
const remaining = (scope:Scope):Remaining => `${scope}_remaining_ms`;
const scopeDetail: Record<Scope,string> = {
  view:'读取和筛选旧式 ADB 指令与 BAT/CMD 脚本引用。',
  manage:'修改旧式 ADB 指令与 BAT/CMD 脚本引用，查询原写入回执。',
  extended_view:'读取四类配置，包括多步 Windows 本地命令原文、会话发送文本和执行选项。',
  extended_manage:'修改四类配置，包括多步 Windows 本地命令、会话发送文本和执行选项，并查询原写入回执。',
  description_view:'使用 v3 读取四类快捷指令配置及其描述。',
  description_manage:'使用 v3 修改四类快捷指令配置及其描述，并查询原写入回执。',
};
const inlineObject = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object';
const validPeer = (value:unknown):value is Peer => inlineObject(value) && uuid(value.pending_id)
  && Number.isSafeInteger(value.pid) && Number(value.pid)>0
  && scopeKeys.map(scope=>value[remaining(scope)]).every(ms=>Number.isSafeInteger(ms)&&Number(ms)>=0&&Number(ms)<=300_000);
const invokeManagement = (request:Record<string,unknown>) => invoke<unknown>('shortcut_bridge_management',{request});

export function ShortcutBridgePanel({serviceId}:{serviceId:string}) {
  const [peer,setPeer]=useState<Peer|null>(null);
  const [preview,setPreview]=useState<Preview>();
  const [seconds,setSeconds]=useState(60);
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const flight=useRef(false);
  function dismiss() {
    setPreview(undefined);
    setConsent(false);
  }
  function updateStatus(value:unknown,expected?:Pick<Peer,'pending_id'|'pid'>) {
    if(!inlineObject(value)||value.service_id!==serviceId)throw new Error('授权状态来源不匹配');
    const next=value.peer;
    if(next!==null&&!validPeer(next))throw new Error('桥进程回执无效');
    if(expected&&(next?.pending_id!==expected.pending_id||next.pid!==expected.pid))throw new Error('桥进程已变化');
    setPeer(next);
  }
  async function run(action:()=>Promise<void>) {
    if(flight.current)return;
    flight.current=true;
    setBusy(true);
    dismiss();
    try {await action();}
    catch {
      setPeer(null);
      setMessage('操作结果未确认。请刷新快捷指令授权状态。');
    } finally {
      setBusy(false);
      flight.current=false;
    }
  }
  function prepare(scope:Scope,original:Peer) {
    return run(async()=>{
      const next=await invokeManagement({op:'preview',pending_id:original.pending_id,scope,seconds});
      if(!inlineObject(next)||!uuid(next.preview_id)||next.pending_id!==original.pending_id
        ||next.pid!==original.pid||next.scope!==scope||next.seconds!==seconds)throw new Error('批准预览来源不匹配');
      setPreview(next as Preview);
      setMessage('核对进程与范围后，请在 30 秒内确认。');
    });
  }
  return <fieldset>
    <legend>MCP 快捷指令授权</legend>
    <p>分别批准查看和管理。普通授权覆盖旧式 ADB 和 BAT/CMD 引用。扩展授权还覆盖本地命令和会话发送文本。v3 描述授权包含四类配置及描述。执行或发送仍须在桌面触发。</p>
    <div className="config-actions">
      <button disabled={busy} onClick={()=>void run(async()=>{
        updateStatus(await invokeManagement({op:'status'}));
        setMessage('已刷新快捷指令授权。');
      })}>刷新快捷指令授权</button>
      <label>授权期限<select aria-label="快捷指令授权期限" value={seconds} disabled={busy||!!preview}
        onChange={event=>setSeconds(Number(event.target.value))}>
        <option value={15}>15 秒</option><option value={60}>1 分钟</option><option value={300}>5 分钟</option>
      </select></label>
    </div>
    {peer?<p>进程 PID {peer.pid}。剩余期限 {scopeKeys.map(scope=>`${scopes[scope]} ${Math.ceil(peer[remaining(scope)]/1000)} 秒`).join(' · ')}</p>
      :<p>请先启动上方提供的 MCP 进程，再刷新授权状态。</p>}
    <div className="config-actions">{scopeKeys.map(scope=>{
      const label=scopes[scope];
      return <span key={scope}>
        <button disabled={busy||!peer||!!preview} onClick={()=>{if(peer)void prepare(scope,peer);}}>预览{label}快捷指令授权</button>
        <button disabled={busy||!peer} onClick={()=>{
          if(peer)void run(async()=>{
            updateStatus(await invokeManagement({op:'revoke',pending_id:peer.pending_id,scope}),peer);
            setMessage(`已撤销${label}快捷指令授权。`);
          });
        }}>撤销{label}快捷指令授权</button>
      </span>;
    })}</div>
    {preview&&<fieldset aria-label="快捷指令授权预览" disabled={busy}>
      <legend>{scopes[preview.scope]}快捷指令</legend>
      <p>进程 PID {preview.pid} · 编号 {preview.pending_id} · {preview.seconds} 秒</p>
      <p>{scopeDetail[preview.scope]}</p>
      <label><input aria-label="同意快捷指令授权" type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>我同意该进程使用以上权限</label>
      <div className="config-actions">
        <button onClick={()=>{dismiss();setMessage('已取消本次预览。');}}>取消快捷指令授权</button>
        <button disabled={!consent} onClick={()=>{
          if(!consent)return;
          void run(async()=>{
            updateStatus(await invokeManagement({op:'approve',preview_id:preview.preview_id}),preview);
            setMessage(`已批准${scopes[preview.scope]}快捷指令。`);
          });
        }}>确认快捷指令授权</button>
      </div>
    </fieldset>}
    <p role="status" aria-label="快捷指令授权状态">{message}</p>
  </fieldset>;
}
