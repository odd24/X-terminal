import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { auditState, checkedHistory, type AuditInfo, type AuditPage } from './audit-history';

export function AuditHistoryPanel({ serviceId }: { serviceId: string }) {
  const [info, setInfo] = useState<AuditInfo>();
  const [page, setPage] = useState<AuditPage>();
  const [message, setMessage] = useState('读取状态后固定已同步水位，再分页查看。');
  const [busy, setBusy] = useState(false);
  const live = useRef(true), flight = useRef(false);
  const currentService = useRef(serviceId); currentService.current = serviceId;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setInfo(undefined); setPage(undefined); }, [serviceId]);
  const run = async (action: () => Promise<void>) => { if (flight.current) return; flight.current = true; setBusy(true); try { await action(); } catch (error) { if (live.current) setMessage(`审计读取失败：${String(error)}。可重新读取状态，不改变授权或重跑业务。`); } finally { flight.current = false; if (live.current) setBusy(false); } };
  const read = (cursor: string, through: string) => run(async () => {
    const result = checkedHistory(await invoke('audit_history_request', { request: { op: 'page', cursor, through_cursor: through } }), serviceId, cursor, through);
    if (live.current && currentService.current === serviceId && result.type === 'page') { setPage(result); setMessage('已读取固定水位的一页；之前页不在窗口累积。'); }
  });
  const status = page?.status ?? info?.status;
  return <details><summary>持久审计历史与记录状态</summary>
    <p>仅保存请求与授权元数据，不保存命令、认证或终端正文。最多保留8段，每段1MiB或1024条；轮转会移除最早审计段。历史跨服务保留，但不会恢复授权。</p>
    <p>返回成功不表示远端动作完成，本地写入不表示对方收到；缺少阶段时身份和结果为未知。策略时间为原服务相对毫秒，RPC另有实际UTC毫秒时间，详情保留精确整数。</p>
    <div className="config-actions"><button disabled={busy} onClick={() => void run(async () => {
      setInfo(undefined); setPage(undefined);
      const result = checkedHistory(await invoke('audit_history_request', { request: { op: 'info' } }), serviceId);
      if (live.current && currentService.current === serviceId && result.type === 'info') { setInfo(result); setPage(undefined); setMessage('已固定同步水位；读取本身也会产生之后的审计记录。'); }
    })}>读取持久审计状态</button><button disabled={busy || !info || info.status.state === 'DISABLED' || info.status.state === 'STORAGE_FAILURE' && info.status.synced_through === '0'} onClick={() => { if (info) void read('0', info.status.synced_through); }}>读取首个历史页</button><button disabled={busy || !page || page.next_cursor === page.through_cursor} onClick={() => { if (page) void read(page.next_cursor, page.through_cursor); }}>下一页历史</button></div>
    <p role="status">{message}</p>
    {status && <p aria-label="持久审计状态">{auditState(status.state)} · 已入队 {status.accepted_through} · 已同步 {status.synced_through} · 拒绝记录 {status.rejected_records} · 未完整段 {status.incomplete_segments} · 保留 {status.retained_records} 条。入队不等于落盘；故障不能撤回已开始的动作，原编号查询和人工接管仍可用。</p>}
    {page && <div aria-label="持久审计历史页"><p>服务 {page.service_id} · 固定水位 {page.through_cursor} · 下一游标 {page.next_cursor} · {page.gap ? '存在历史缺口：部分记录已退休或不可恢复' : '本页没有记录缺口'}</p><ul>{page.records.map(row => <li key={row.seq}><details><summary>#{row.seq} · 原服务 {row.service_id} · {row.category} · {row.summary}</summary><pre>{row.metadata}</pre></details></li>)}</ul></div>}
  </details>;
}
