import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { uuid } from './agent-management';
type Peer = { pending_id: string; pid: number; ticket_id: string | null };
type Info = { broker_id: string; instance: string; executable: string; desktop_pid: number; service_id: string; peer: Peer | null };
type Preview = { preview_id: string; peer: Peer; service_id: string; grant_request_id: string; grant_metadata: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const validPeer = (v: unknown): v is Peer => object(v) && uuid(v.pending_id) && Number.isSafeInteger(v.pid) && Number(v.pid) > 0 && (v.ticket_id === null || uuid(v.ticket_id));
export function BridgePanel({ serviceId, grantId }: { serviceId: string; grantId?: string }) {
  const [info, setInfo] = useState<Info>(), [preview, setPreview] = useState<Preview>();
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('先读取本次启动参数，启动 MCP 后刷新待配对进程；再预览原授权并确认绑定。');
  const alive = useRef(true), flight = useRef(false), epoch = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { epoch.current++; setInfo(undefined); setPreview(undefined); setConsent(false); }, [serviceId, grantId]);
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (flight.current) return; flight.current = true; setBusy(true); const value = epoch.current;
    try { await action(() => alive.current && epoch.current === value); }
    catch (error) { if (alive.current && epoch.current === value) { setPreview(undefined); setConsent(false); setMessage(`操作未确认：${String(error)}。请只刷新状态核对，不自动重试批准。`); } }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  return <details><summary>MCP 初版连接</summary>
    <p>先在本面板签发或查询原授权，再把它一次绑定到本机实际桥进程。token 只由原生端持有；MCP 沿原授权转发读取、发送、租约/回执，以及独立SSH exec、本人任务查询/取消、串口精确字节和显式控制线。绑定不取租约、不发送命令、不执行exec，也不延长原期限。</p>
    <div className="config-actions"><button disabled={busy} onClick={() => void run(async current => {
      setPreview(undefined); setConsent(false);
      const result = await invoke<unknown>('bridge_management_request', { request: { op: 'info' } });
      if (!object(result) || result.service_id !== serviceId || !uuid(result.broker_id) || typeof result.instance !== 'string' || !/^bridge-[0-9a-f]{32}$/.test(result.instance) || typeof result.executable !== 'string' || !Number.isSafeInteger(result.desktop_pid) || result.peer !== null && !validPeer(result.peer)) throw new Error('配对来源不匹配');
      if (current()) { setInfo(result as Info); setMessage('已读取本次原生桥状态；以下参数不包含 token。应用重启后须重新读取。'); }
    })}>刷新MCP连接状态</button><button disabled={busy || !grantId || !info?.peer || info.peer.ticket_id !== null} onClick={() => void run(async current => {
      if (!info?.peer || !grantId) return; setPreview(undefined); setConsent(false);
      const result = await invoke<unknown>('bridge_management_request', { request: { op: 'preview', pending_id: info.peer.pending_id, grant_request_id: grantId } });
      if (!object(result) || !uuid(result.preview_id) || result.service_id !== serviceId || result.grant_request_id !== grantId || !validPeer(result.peer) || result.peer.pending_id !== info.peer.pending_id || result.peer.pid !== info.peer.pid || typeof result.grant_metadata !== 'string' || result.grant_metadata.length > 65536) throw new Error('固定配对预览不匹配');
      if (current()) { setPreview(result as Preview); setMessage('核对实际进程与原授权的完整元数据；30秒内一次确认，默认不同意。'); }
    })}>预览MCP绑定原授权</button></div>
    {info && <><p>本服务 {info.service_id} · 桥 {info.broker_id} · {info.peer ? `实际进程 PID ${info.peer.pid} · ${info.peer.ticket_id ? `已绑定票据 ${info.peer.ticket_id}（不代表权限仍有效）` : '等待明确批准'}` : '尚无受认可桥进程连接'}</p><pre aria-label="MCP本次启动参数">{JSON.stringify({ command: info.executable, args: ['--stdio', '--broker', info.instance, '--desktop-pid', String(info.desktop_pid)] }, null, 2)}</pre></>}
    {preview && <fieldset aria-label="MCP固定配对预览" disabled={busy}><legend>只绑定此进程与原授权</legend><p>PID {preview.peer.pid} · 原签发 {preview.grant_request_id}</p><pre>{preview.grant_metadata}</pre><label><input aria-label="同意MCP绑定原授权" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我同意此桥使用以上原授权；结果不明只刷新状态</label><div className="config-actions"><button autoFocus onClick={() => { setPreview(undefined); setConsent(false); }}>取消MCP绑定</button><button disabled={!consent} onClick={() => {
      if (!consent) return; const id = preview.preview_id; setPreview(undefined); setConsent(false);
      void run(async current => { const result = await invoke<unknown>('bridge_management_request', { request: { op: 'approve', preview_id: id } }); if (!validPeer(result) || result.pending_id !== preview.peer.pending_id || !result.ticket_id) throw new Error('配对结果不匹配'); if (current()) { setInfo(undefined); setMessage('已绑定独立Agent身份；请刷新状态，服务仍按实时权限与租约验证每次操作。'); } });
    }}>确认MCP绑定</button></div></fieldset>}
    <p role="status" aria-label="MCP配对状态">{message}</p><p>本版一次连接一个桥；更换授权或应用重启请重新启动并明确配对。断开桥不能撤回已派发动作；原编号查询、撤销和人工接管沿现有服务处理。当前固定25工具。串口建连须单次批准固定配置和设备，打开时应用预览中的初始控制线。SSH2 建连限已保存并批准的固定配置版本，主机信任和认证由桌面处理。SSH2 重连须批准旧代次及固定配置版本，认证仍由桌面处理。移除已结束会话记录须独立批准和租约，清理完成后才可执行。SSH2 和串口断开均须独立批准和租约，应答不明时用原有效授权查询原编号。包含独立SSH exec及本人任务查询/取消；exec须单独批准和租约，串口WRITE/CONTROL独立，控线无默认动作。尚不等于模型自治或完整MCP/实机验收。</p>
  </details>;
}
