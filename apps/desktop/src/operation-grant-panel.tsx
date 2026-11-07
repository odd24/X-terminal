import { useEffect, useRef, useState } from 'react';
import { readConfiguration, type Profile } from './config-api';
import { serial, type Inventory } from './serial-api';
import type { Connection } from './ssh-api';
import { Field } from './ui';
import { requestId } from './request-id';
import { OperationApproval, emptyDraft, singleActions, singleName, type Draft, type OperationContext, type OperationProposal, type SingleAction } from './operation-grant';
import { profileDescription } from './profile-grant';

export function OperationGrantPanel({ serviceId, target, profileId, encoding, disabled, submit }: { serviceId: string; target?: Connection; profileId?: string; encoding?: string; disabled: boolean; submit(proposal: OperationProposal, current: () => boolean): Promise<void> }) {
  const approval = useRef(new OperationApproval()), alive = useRef(true), epoch = useRef(0), loading = useRef(false), submitting = useRef(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft), [seconds, setSeconds] = useState(300);
  const [profiles, setProfiles] = useState<Profile[]>([]), [revision, setRevision] = useState<string>(), [selected, setSelected] = useState('');
  const [inventory, setInventory] = useState<Inventory>(), [deviceId, setDeviceId] = useState('');
  const [proposal, setProposal] = useState<OperationProposal>(), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('默认无操作、无同意。仅批准以下一次固定请求，不执行操作。');
  const invalidate = () => { epoch.current++; approval.current.invalidate(); setProposal(undefined); setConsent(false); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; approval.current.invalidate(); }; }, []);
  const profile = profiles.find(item => item.id === selected);
  const device = inventory?.devices.find(item => item.device_id === deviceId);
  const context: OperationContext = { service_id: serviceId, target, original_profile_id: profileId, encoding, profile, revision, ...(inventory && device ? { device: { revision: inventory.revision, device_id: device.device_id, port: device.port } } : {}) };
  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => { invalidate(); setDraft(previous => ({ ...previous, [key]: value })); };
  const profileAction = draft.action === 'start' || draft.action === 'reconnect';
  const sshDimensions = draft.action === 'resize' || draft.action === 'reconnect' || (draft.action === 'start' && profile?.settings.protocol === 'ssh2');
  return <fieldset disabled={disabled || busy} aria-label="Agent单次操作面板"><legend>批准一次完整操作</legend>
    <p role="status" aria-label="Agent单次状态">{message}</p>
    <p>批准不执行、不取租约。实际Agent须提交同一操作编号和全部参数；不能更换正文、目标、控制线或尺寸。读取另行批准，认证/主机信任仍由Desktop处理。</p>
    <Field label="单次动作"><select aria-label="Agent单次动作" value={draft.action} onChange={event => { invalidate(); setDraft({ ...emptyDraft(), action: event.target.value as SingleAction }); setSelected(''); setProfiles([]); setRevision(undefined); setInventory(undefined); setDeviceId(''); }}><option value="">选择一个动作</option>{singleActions(target).map(action => <option key={action} value={action}>{singleName[action]}</option>)}</select></Field>
    {draft.action && draft.action !== 'start' && <small aria-label="Agent单次目标">{target?.protocol} · {target?.connection_id} / 代次 {target?.generation} · {target?.state}</small>}
    {profileAction && <>
      <button onClick={() => {
        if (loading.current) return;
        invalidate(); const attempt = epoch.current; loading.current = true; setBusy(true); setSelected(''); setProfiles([]); setRevision(undefined); setInventory(undefined); setDeviceId('');
        void readConfiguration().then(snapshot => {
          if (!alive.current || attempt !== epoch.current) return;
          setProfiles(snapshot.profiles.filter(p => draft.action === 'reconnect' ? p.id === profileId && p.settings.protocol === 'ssh2' : ['ssh2', 'serial'].includes(p.settings.protocol))); setRevision(snapshot.revision); setMessage('请选择固定配置；批准前再次核对配置版本，不会建连。');
        }).catch(error => { if (alive.current && attempt === epoch.current) setMessage(String(error)); }).finally(() => { loading.current = false; if (alive.current) setBusy(false); });
      }}>读取单次固定配置</button>
      <Field label="单次配置"><select aria-label="Agent单次配置" value={selected} onChange={event => { invalidate(); setSelected(event.target.value); setInventory(undefined); setDeviceId(''); }}><option value="">选择固定版本配置</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.settings.protocol.toUpperCase()}</option>)}</select></Field>
      {profile && <p aria-label="Agent单次配置摘要">{profileDescription(profile)} · 配置版本 {revision}</p>}
      {draft.action === 'start' && profile?.settings.protocol === 'serial' && <>
        <button onClick={() => {
          if (loading.current) return;
          invalidate(); const attempt = epoch.current; loading.current = true; setBusy(true); setDeviceId(''); setInventory(undefined);
          void serial({ op: 'inventory' }).then(reply => {
            if (!alive.current || attempt !== epoch.current) return;
            if (reply.result !== 'inventory') throw new Error('库存响应不匹配');
            setInventory(reply); setMessage('已只读刷新库存。选择匹配端口；任何后续库存刷新会使这次Start失效，须重新预览。');
          }).catch(error => { if (alive.current && attempt === epoch.current) setMessage(String(error)); }).finally(() => { loading.current = false; if (alive.current) setBusy(false); });
        }}>读取单次串口库存</button>
        <Field label="固定串口设备"><select aria-label="Agent单次设备" value={deviceId} onChange={event => { invalidate(); setDeviceId(event.target.value); }}><option value="">选择与配置端口一致的设备</option>{inventory?.devices.map(d => <option key={d.device_id} value={d.device_id} disabled={profile.settings.protocol !== 'serial' || d.port !== profile.settings.port}>{d.port} · {d.device_id}</option>)}</select></Field>
      </>}
    </>}
    {sshDimensions && <div className="form-grid">
      <Field label="SSH列数（2–500）"><input aria-label="Agent单次列数" type="number" min={2} max={500} value={draft.cols} onChange={event => edit('cols', Number(event.target.value))} /></Field>
      <Field label="SSH行数（1–200）"><input aria-label="Agent单次行数" type="number" min={1} max={200} value={draft.rows} onChange={event => edit('rows', Number(event.target.value))} /></Field>
    </div>}
    {['write_text', 'exec', 'send'].includes(draft.action) && <Field label={draft.action === 'exec' ? '完整exec命令' : '完整发送正文（保留换行）'}><textarea aria-label="Agent单次正文" rows={4} maxLength={196608} value={draft.text} onChange={event => edit('text', event.target.value)} /></Field>}
    {['write_text', 'exec', 'send'].includes(draft.action) && <small>当前代次固定编码：{encoding ?? '尚未读取完成，暂不能预览'}。服务严格编码，无法表示、编码后超限或节奏总等待超过60秒时拒绝，不自动改写正文。</small>}
    {draft.action === 'write' && <Field label="原始字节HEX（不会自动追加换行）"><textarea aria-label="Agent单次HEX" rows={4} value={draft.hex} maxLength={196608} onChange={event => edit('hex', event.target.value)} /></Field>}
    {draft.action === 'exec' && <>
      <p>这是独立exec通道，不是交互终端输入。结果/取消沿本人任务查询，输出上限及超时固定。</p>
      <Field label="exec超时（毫秒）"><input aria-label="Agent单次exec超时" type="number" min={1} max={86400000} value={draft.timeout_ms} onChange={event => edit('timeout_ms', Number(event.target.value))} /></Field>
      <Field label="exec输出上限（字节）"><input aria-label="Agent单次exec上限" type="number" min={1} max={1048576} value={draft.max_output_bytes} onChange={event => edit('max_output_bytes', Number(event.target.value))} /></Field>
    </>}
    {draft.action === 'send' && <>
      <Field label="串口发送格式"><select aria-label="Agent单次发送格式" value={draft.format} onChange={event => edit('format', event.target.value as Draft['format'])}><option value="text">文本（连接编码）</option><option value="hex">HEX字节</option></select></Field>
      <Field label="追加结尾"><select aria-label="Agent单次结尾" value={draft.ending} onChange={event => edit('ending', event.target.value as Draft['ending'])}>{['none', 'cr', 'lf', 'cr_lf'].map(e => <option key={e} value={e}>{e === 'none' ? '不追加' : e.toUpperCase()}</option>)}</select></Field>
      <Field label="每片字节（1–1024）"><input aria-label="Agent单次片长" type="number" min={1} max={1024} value={draft.chunk_bytes} onChange={event => edit('chunk_bytes', Number(event.target.value))} /></Field>
      <Field label="片间隔（0–1000毫秒）"><input aria-label="Agent单次间隔" type="number" min={0} max={1000} value={draft.interval_ms} onChange={event => edit('interval_ms', Number(event.target.value))} /></Field>
    </>}
    {draft.action === 'control' && <>
      <Field label="控制线"><select aria-label="Agent单次控制线" value={draft.line} onChange={event => edit('line', event.target.value as Draft['line'])}>{['DTR', 'RTS', 'BREAK'].map(line => <option key={line}>{line}</option>)}</select></Field>
      <Field label="明确控制电平"><select aria-label="Agent单次电平" value={String(draft.asserted)} onChange={event => edit('asserted', event.target.value === 'true')}><option value="false">关闭</option><option value="true">开启</option></select></Field>
      <p>硬件流控管理RTS时服务会拒绝手动RTS；批准不改变任何控制线。</p>
    </>}
    {draft.action === 'disconnect' && <p>只请求关闭以上代次；Requested不等于本地回收，须查询原编号的TransportEnded。不能撤回已执行动作。</p>}
    {draft.action === 'forget_start' && <p>只有本地传输实际回收后才可移除会话记录；清理未完无成功回执，可原编号重试。不删日志、配置或用户文件。</p>}
    <Field label="单次授权期限（秒，1–1800）"><input aria-label="Agent单次秒数" type="number" min={1} max={1800} value={seconds} onChange={event => { invalidate(); setSeconds(Number(event.target.value)); }} /></Field>
    <button disabled={!draft.action} onClick={() => { try { invalidate(); setProposal(approval.current.prepare(context, draft, seconds, requestId())); setMessage('请核对以下全部参数及期限；尚未签发或执行。'); } catch (error) { setMessage(String(error)); } }}>预览Agent单次操作</button>
    {proposal && <fieldset><legend>核对完整单次操作</legend>
      <div className="data-location" aria-label="Agent单次预览">{proposal.description.map(([label, value]) => <div key={label}><strong>{label}：</strong>{label.startsWith('完整') ? <pre>{value}</pre> : <p>{value}</p>}</div>)}<p>授权期限 {proposal.lifetime_ms / 1000} 秒 · 不含终端读取权限 · 批准不执行操作</p></div>
      <label className="check"><input aria-label="同意Agent单次操作" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我批准以上原编号、全部参数和期限的一次操作</label>
      <div className="config-actions"><button autoFocus onClick={() => { invalidate(); setMessage('已取消单次预览；未签发。'); }}>取消Agent单次批准</button><button disabled={!consent} onClick={() => {
        if (submitting.current) return;
        submitting.current = true;
        try { const fixed = approval.current.consume(context, draft, proposal); invalidate(); const attempt = epoch.current; void submit(fixed, () => alive.current && attempt === epoch.current).finally(() => { submitting.current = false; }); }
        catch (error) { submitting.current = false; invalidate(); setMessage(String(error)); }
      }}>确认批准Agent单次</button></div>
    </fieldset>}
  </fieldset>;
}
