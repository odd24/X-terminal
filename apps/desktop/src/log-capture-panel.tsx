import { useEffect, useRef, useState } from 'react';
import { logging, type LogInfo } from './logging-api';
import { capturePhases, checkedCapture, checkedCaptures } from './log-captures';

export function LogCapturePanel() {
  const [logs, setLogs] = useState<LogInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [needsQuery, setNeedsQuery] = useState<Set<string>>(() => new Set());
  const [last, setLast] = useState<LogInfo>();
  const [message, setMessage] = useState('先刷新本次服务捕获清单，再独立选择维护目标。');
  const mounted = useRef(true); const inFlight = useRef(false);
  const query = useRef<HTMLButtonElement>(null); const returnFocus = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!pending && returnFocus.current) { returnFocus.current = false; query.current?.focus(); } }, [pending]);
  const entry = logs.find(log => log.log_id === selected);
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    try {
      const found = checkedCaptures(await logging({ op: 'capture_list' }), logs);
      if (!mounted.current) return;
      setLogs(found); setSelected(old => found.some(log => log.log_id === old) ? old : ''); setNeedsQuery(new Set());
      setLast(old => old ? found.find(log => log.log_id === old.log_id && log.connection.connection_id === old.connection.connection_id && log.connection.generation === old.connection.generation) ?? old : old);
      setMessage(`已列出本次服务 ${found.length} 项捕获；包含旧代次与已移除连接，不是持久历史目录。缺失编号不表示文件已删除。`);
    } catch (error) { if (mounted.current) { setNeedsQuery(old => new Set([...old, selected])); setMessage(error instanceof Error ? error.message : '清单查询失败。'); } }
    finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  async function act(op: 'status' | 'release_failed') {
    if (!entry || inFlight.current || (op === 'release_failed' && (entry.phase !== 'FAILED' || !entry.worker_finished || needsQuery.has(entry.log_id)))) return;
    const frozen = { ...entry, connection: { ...entry.connection } };
    inFlight.current = true; setPending(true); setLast(frozen);
    if (op === 'release_failed') returnFocus.current = true;
    try {
      const info = checkedCapture(await logging({ op, connection: frozen.connection, log_id: frozen.log_id }), frozen.connection, frozen.log_id);
      if (op === 'release_failed' && !['RELEASED', 'REMOVED'].includes(info.phase)) throw new Error('解除响应状态不匹配；请查询原目标，未自动重试。');
      if (!mounted.current) return;
      setLogs(old => old.map(log => log.log_id === info.log_id ? info : log)); setLast(info); setNeedsQuery(old => { const next = new Set(old); next.delete(info.log_id); return next; });
      setMessage(`${capturePhases[info.phase]}。${op === 'release_failed' ? '仅维护原记录关联，不重新记录，不删除文件，也不解除其他记录。' : '已查询原目标；失败计数保留为历史。'}`);
    } catch (error) { if (mounted.current) { setNeedsQuery(old => new Set([...old, frozen.log_id])); setMessage(`${error instanceof Error ? error.message : '维护请求失败。'} 结果可能未知，请查询原目标；未自动再次提交。`); } }
    finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  return <details aria-label="捕获记录维护"><summary>本次服务捕获维护（所有连接与代次）</summary>
    <small>清单最多 64 项，含已移除连接，不跟随活动连接。服务重启不恢复本次回执；文件历史另查。只有已失败且文件线程结束的记录可解除关联；不删除文件，物理容量仍需独立预览清理。</small>
    <div className="config-actions"><button disabled={pending} onClick={() => void refresh()}>刷新捕获维护清单</button></div>
    <label>独立维护记录<select aria-label="捕获维护选择" disabled={pending || !logs.length} value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择捕获编号</option>{logs.map(log => <option key={log.log_id} value={log.log_id}>{log.log_id} · {log.connection.connection_id} / {log.connection.generation} · {capturePhases[log.phase]}</option>)}</select></label>
    {entry && <p className="data-location" aria-label="捕获维护目标">日志 {entry.log_id} · {entry.protocol} · {entry.connection.connection_id} / {entry.connection.generation} · {capturePhases[entry.phase]} · {entry.worker_finished ? '文件线程已结束' : '文件线程尚未结束'} · 已写 {entry.written_records} 条 / {entry.written_raw_bytes} 原始字节 · 源缺口 {entry.source_gap_bytes} 字节 · 失败 {entry.failure ?? '无'}</p>}
    <div className="config-actions"><button ref={query} disabled={pending || !entry} onClick={() => void act('status')}>查询维护记录状态</button><button disabled={pending || entry?.phase !== 'FAILED' || !entry.worker_finished || needsQuery.has(entry.log_id)} onClick={() => void act('release_failed')}>解除失败记录关联（不删除文件）</button></div>
    {last && <p className="data-location" aria-label="上次维护固定目标">上次操作目标：{last.log_id} · {last.connection.connection_id} / {last.connection.generation} · 上次已知：{capturePhases[last.phase]}（结果以查询为准，不随选择切换）</p>}
    <p role="status" aria-label="捕获维护状态">{message}</p>
  </details>;
}
