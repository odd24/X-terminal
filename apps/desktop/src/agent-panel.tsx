import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Connection, ConnectionRef } from './ssh-api';
import { Field, Panel } from './ui';
import { GrantApproval, actionName, checkedAudit, checkedGrant, checkedLease, checkedList, restoreSlot, scopeText, slotKey, supportedActions, uuid, type Action, type AuditPage, type GrantView, type Lease, type Proposal, type Slot, type Summary } from './agent-management';
import { requestId } from './request-id';

const call = (request: Record<string, unknown>) => invoke<unknown>('agent_management_request', { request });
const readSlot = () => { try { return restoreSlot(sessionStorage.getItem(slotKey)); } catch { return undefined; } };
const targetText = (connection: ConnectionRef) => `${connection.connection_id} / 代次 ${connection.generation}`;

export function AgentPanel({ serviceId, target, close }: { serviceId: string; target?: Connection; close(): void }) {
  const approval = useRef(new GrantApproval());
  const [selected, setSelected] = useState<Action[]>([]);
  const [seconds, setSeconds] = useState(300);
  const [proposal, setProposal] = useState<Proposal>();
  const [consent, setConsent] = useState(false);
  const [slot, setSlot] = useState<Slot | undefined>(readSlot);
  const [queryId, setQueryId] = useState(() => readSlot()?.request_id ?? '');
  const [view, setView] = useState<GrantView>();
  const [list, setList] = useState<Summary[]>([]);
  const [lease, setLease] = useState<{ connection: ConnectionRef; value: Lease | null }>();
  const [audit, setAudit] = useState<AuditPage>();
  const [confirmation, setConfirmation] = useState<{ kind: 'revoke'; request_id: string } | { kind: 'takeover'; connection: ConnectionRef }>();
  const [busy, setBusy] = useState(false), flight = useRef(false), alive = useRef(true);
  const [message, setMessage] = useState('选择能力并预览后明确批准。关闭/重载不恢复同意；本入口不发送终端输入。');
  const targetKey = target ? `${target.connection_id}:${target.generation}:${target.protocol}:${target.state}` : '';
  useEffect(() => { alive.current = true; return () => { alive.current = false; approval.current.invalidate(); }; }, []);
  useEffect(() => { approval.current.invalidate(); setProposal(undefined); setConsent(false); setSelected([]); setConfirmation(undefined); setLease(undefined); }, [serviceId, targetKey]);
  const invalidate = () => { approval.current.invalidate(); setProposal(undefined); setConsent(false); };
  const remember = (id: string) => {
    const saved = { service_id: serviceId, request_id: id };
    // Write before sending. A storage failure must not create an untrackable grant.
    sessionStorage.setItem(slotKey, JSON.stringify(saved)); setSlot(saved); setQueryId(id);
  };
  async function run(operation: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setMessage('正在核对原服务；请等待结果。');
    try { await operation(); }
    catch (error) { if (alive.current) setMessage(`操作未确认：${String(error)}。不自动重试；签发或撤销结果不明时，只查询原服务/原编号。`); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function query(id: string) {
    if (!uuid(id)) throw new Error('请输入完整签发编号');
    if (slot?.request_id === id && slot.service_id !== serviceId) throw new Error('该编号属于旧服务；本服务不会继承旧授权');
    const result = checkedGrant(await call({ op: 'grant_status', request_id: id }), id);
    if (!alive.current) return;
    remember(id); setView(result); setConfirmation(undefined);
    setMessage('已查询原编号；未续期或恢复已撤范围。ACTIVE仅表示票据有效，实际能力见当前有效范围。');
  }
  const unresolved = !!slot && slot.service_id === serviceId && slot.request_id !== view?.summary.request_id;
  const available = target ? supportedActions(target) : [];
  return <Panel title="Agent 授权" label="Agent授权面板" close={() => { invalidate(); close(); }} closeLabel="关闭Agent授权">
    <p role="status" aria-label="Agent管理状态">{message}</p>
    <small>服务 {serviceId} · 凭据只在原生/服务内存中。真实 MCP 桥交付尚未接入；本面板不提供 token 复制或保存。</small>
    <p>读取范围包含该代次服务当前有界保留的原始输出、解码文本与屏幕；不包含持久日志/导出、认证秘密或其他连接。写入、独立 exec 与控制线分别批准；变更操作还需 Agent 自己取得最长60秒的独占租约。</p>
    <fieldset disabled={busy || unresolved}><legend>批准当前目标</legend>
      <small aria-label="Agent批准目标">{target ? `${target.protocol} · ${targetText(target)}` : '尚无活动连接'}</small>
      <p>默认未选择能力。Connect/Disconnect、SSH尺寸控制和广播尚未开放；合成会话只提供测试读取。</p>
      {available.map(action => <label className="check" key={action}><input type="checkbox" aria-label={`授权${actionName[action]}`} checked={selected.includes(action)} onChange={event => { invalidate(); setSelected(previous => event.target.checked ? [...previous, action] : previous.filter(item => item !== action)); }} />{actionName[action]}</label>)}
      <Field label="授权期限（秒，1–1800）"><input type="number" min={1} max={1800} aria-label="Agent授权秒数" value={seconds} onChange={event => { invalidate(); setSeconds(Number(event.target.value)); }} /></Field>
      <button disabled={!target || !selected.length} onClick={() => { try { if (!target) return; setProposal(approval.current.prepare(serviceId, target, selected, seconds)); setConsent(false); setMessage('请核对固定目标、能力和期限；尚未签发。'); } catch (error) { invalidate(); setMessage(String(error)); } }}>预览Agent授权</button>
    </fieldset>
    {unresolved && <p>保留编号的签发结果尚未核对；请先查询原编号，当前禁止再次签发。</p>}
    {proposal && <fieldset disabled={busy}><legend>核对本次授权</legend>
      <small aria-label="Agent授权预览">{proposal.protocol} · {targetText(proposal.connection)} · {proposal.lifetime_ms / 1000} 秒</small>
      <ul>{proposal.scopes.map(scope => <li key={scope.action}>{scopeText(scope)}</li>)}</ul>
      <label className="check"><input aria-label="同意本次Agent范围" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我批准以上固定代次、独立能力与期限</label>
      <div className="config-actions"><button autoFocus onClick={() => { invalidate(); setMessage('已取消预览；未签发。'); }}>取消Agent批准</button><button disabled={!consent} onClick={() => {
        if (flight.current) return;
        let approved: Proposal;
        try { approved = approval.current.consume(serviceId, target, proposal); invalidate(); }
        catch (error) { invalidate(); setMessage(String(error)); return; }
        void run(async () => {
          const id = requestId(); remember(id); setView(undefined);
          const result = checkedGrant(await call({ op: 'grant', request_id: id, scopes: approved.scopes, lifetime_ms: approved.lifetime_ms }), id);
          if (!alive.current) return;
          setView(result); setMessage('已签发限时授权，尚未向真实桥交付；查询不续期，重连新代次不继承。');
        });
      }}>确认批准Agent</button></div>
    </fieldset>}
    <fieldset disabled={busy}><legend>查询与撤销原签发</legend>
      {slot && <small aria-label="Agent保留编号">服务 {slot.service_id} · 签发 {slot.request_id}{slot.service_id !== serviceId && ' · 旧服务，不继承'}</small>}
      <Field label="签发编号"><input aria-label="Agent签发编号" value={queryId} maxLength={36} onChange={event => { invalidate(); setQueryId(event.target.value); setView(undefined); setConfirmation(undefined); }} /></Field>
      <div className="config-actions"><button disabled={!uuid(queryId)} onClick={() => void run(() => query(queryId))}>查询原Agent编号</button><button onClick={() => void run(async () => { const result = checkedList(await call({ op: 'grant_list' })); if (alive.current) { setList(result); setMessage('已刷新本服务最多128项保留回执；不是持久授权历史。'); } })}>刷新本次授权清单</button></div>
      {list.length > 0 && <Field label="本服务保留回执"><select aria-label="本次Agent授权" value="" onChange={event => { if (!event.target.value) return; invalidate(); setQueryId(event.target.value); setView(undefined); setConfirmation(undefined); }}><option value="">选择编号后显式查询</option>{list.map(item => <option key={item.request_id} value={item.request_id}>{item.request_id} · {item.state} · 有效范围 {item.effective_scope_count}</option>)}</select></Field>}
      {view && <div aria-label="Agent授权详情"><p>票据 {view.summary.ticket_id} · {view.summary.state} · 有效范围 {view.summary.effective_scope_count} · 到期服务相对毫秒 {view.summary.expires_at_ms}（不是日期；刷新查询核对当前状态）</p>
        <strong>原批准范围</strong><ul>{view.approved_scopes.map((scope, index) => <li key={index}>{scopeText(scope)}</li>)}</ul>
        <strong>当前有效范围</strong><ul aria-label="Agent有效范围">{view.effective_scopes.length ? view.effective_scopes.map((scope, index) => <li key={index}>{scopeText(scope)}</li>) : <li>无可执行范围</li>}</ul>
        <button disabled={view.summary.state !== 'ACTIVE'} onClick={() => { invalidate(); setConfirmation({ kind: 'revoke', request_id: view.summary.request_id }); }}>撤销此Agent授权</button>
      </div>}
    </fieldset>
    <fieldset disabled={busy}><legend>当前连接租约与人工接管</legend>
      <small>{target ? targetText(target) : '尚无活动连接'}</small>
      <div className="config-actions"><button disabled={!target} onClick={() => { if (!target) return; const ref = { connection_id: target.connection_id, generation: target.generation }; void run(async () => { const result = checkedLease(await call({ op: 'lease', connection: ref }), ref); if (alive.current) { setLease({ connection: ref, value: result }); setMessage('只查询输入租约，未取得或续租。'); } }); }}>查询当前输入租约</button>
        <button disabled={!target} onClick={() => { if (!target) return; invalidate(); setConfirmation({ kind: 'takeover', connection: { connection_id: target.connection_id, generation: target.generation } }); }}>人工接管当前连接</button></div>
      {lease && <small aria-label="Agent租约详情">{targetText(lease.connection)} · {lease.value ? `持有者 ${lease.value.client_id} · 租约 ${lease.value.lease_id} · 到期服务相对毫秒 ${lease.value.expires_at_ms}` : '没有有效输入租约'}</small>}
    </fieldset>
    {confirmation && <fieldset disabled={busy}><legend>确认权限变更</legend><p aria-label="Agent变更目标">{confirmation.kind === 'revoke' ? `撤销签发 ${confirmation.request_id}` : `人工接管 ${targetText(confirmation.connection)}：撤下所有Agent非Read范围和租约，保留观察范围。`}</p><p>只能阻止尚未派发的动作或片段；不能撤回已派发、驱动已接受或远端已执行的动作。结果不明只查询原编号/固定目标。</p>
      <button autoFocus onClick={() => setConfirmation(undefined)}>取消Agent变更</button><button onClick={() => {
        const fixed = confirmation; setConfirmation(undefined);
        void run(async () => {
          if (fixed.kind === 'revoke') {
            setView(undefined); setQueryId(fixed.request_id);
            const result = checkedGrant(await call({ op: 'grant_revoke', request_id: fixed.request_id }), fixed.request_id);
            if (alive.current) { setView(result); setQueryId(fixed.request_id); setMessage('原签发已撤销；重复撤销不新签发，已执行动作不撤回。'); }
          } else {
            const result = await call({ op: 'takeover', connection: fixed.connection });
            if (!result || typeof result !== 'object' || Object.keys(result).length !== 1 || !('type' in result) || result.type !== 'ok') throw new Error('接管回复不匹配');
            if (alive.current) { setView(undefined); setLease(undefined); setMessage(`已人工接管 ${targetText(fixed.connection)}；请查询原授权的当前有效范围与固定目标租约。`); }
          }
        });
      }}>确认Agent变更</button></fieldset>}
    <details><summary>本服务审计与上下文范围</summary><p>最多512条元数据环，单页最多128；只显示本页，不拼成无限历史。服务相对时间不是北京时间日期。缺口表示更早条目已覆盖，尚无完整持久审计交付。</p>
      <div className="config-actions"><button disabled={busy} onClick={() => void run(async () => { const result = checkedAudit(await call({ op: 'audit', cursor: 0, limit: 128 }), 0); if (alive.current) { setAudit(result); setMessage('已读取首个保留审计页；未读取终端正文。'); } })}>读取保留审计</button><button disabled={busy || !audit} onClick={() => { if (!audit) return; const cursor = audit.next_cursor; void run(async () => { const result = checkedAudit(await call({ op: 'audit', cursor, limit: 128 }), cursor); if (alive.current) { setAudit(result); setMessage('已读取下一审计页；之前页未在窗口无限累积。'); } }); }}>下一页审计</button></div>
      {audit && <div aria-label="Agent审计页"><p>可用起点 {audit.available_from} · 下一游标 {audit.next_cursor} · {audit.gap ? '审计缺口：较早条目已覆盖' : '本页无覆盖缺口'}</p><ul>{audit.events.map(event => <li key={event.seq}>#{event.seq} · 服务相对 {event.timestamp_ms}ms · {event.kind} · 客户端 {event.client_id ?? '—'} · 请求 {event.request_id ?? '—'} · {event.scope ? scopeText(event.scope) : '无连接范围'} · {event.denial ?? '—'}</li>)}</ul></div>}
    </details>
  </Panel>;
}
