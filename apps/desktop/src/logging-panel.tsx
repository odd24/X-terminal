import { useEffect, useRef, useState } from 'react';
import { logging, type LogInfo } from './logging-api';
import { reference, type Connection } from './ssh-api';
import { requestId } from './request-id';
import { LogHistoryPanel } from './log-history-panel';
const phases: Record<LogInfo['phase'], string> = { OPENING: '正在打开文件', RECORDING: '正在记录', STOPPING: '正在排空并同步', STOPPED: '记录已停止', FAILED: '记录失败' };
const failures: Record<string, string> = { QUEUE_FULL: '写盘队列已满', DISK_FULL: '磁盘空间不足', STORAGE: '文件存储故障', INVALID_RECORD: '输出序号或代次异常', COUNTER_EXHAUSTED: '计数容量已耗尽', WORKER_PANICKED: '文件线程异常' };
export function LoggingPanel({ connection, open, close }: { connection?: Connection; open: boolean; close: () => void }) {
  const [logs, setLogs] = useState<LogInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [monitorError, setMonitorError] = useState('');
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState(100);
  const [segments, setSegments] = useState(5);
  const current = useRef(connection);
  current.current = connection;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let disposed = false; let timer = 0;
    const target = connection && reference(connection);
    setLogs([]); setSelected(''); setMessage(''); setMonitorError('');
    async function poll() {
      if (!target) return;
      try {
        const reply = await logging({ op: 'list', connection: target });
        if (disposed || reply.result !== 'list') return;
        setLogs(reply.logs); setMonitorError('');
      } catch { if (!disposed) setMonitorError('日志状态暂不可用；未重新启动记录。'); }
      if (!disposed) timer = window.setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [connection?.connection_id, connection?.generation]);
  const visibleLogs = logs.filter(log => log.connection.connection_id === connection?.connection_id && log.connection.generation === connection?.generation);
  const latest = visibleLogs.find(log => log.active) ?? visibleLogs[0];
  const shown = visibleLogs.find(log => log.log_id === selected) ?? latest;
  const targetText = connection ? `${connection.protocol} · ${connection.connection_id} / ${connection.generation}` : '尚无连接';
  async function act(action: 'start' | 'stop') {
    const target = current.current;
    if (!target || busy) return;
    const frozen = reference(target);
    setBusy(true); setMessage('');
    try {
      const reply = await logging(action === 'start' ? { op: 'start', connection: frozen, request_id: requestId(), limits: { segment_bytes: Math.round(size * 1024 * 1024), segments } } : { op: 'stop', connection: frozen, log_id: shown!.log_id });
      if (mounted.current && current.current?.connection_id === frozen.connection_id && current.current.generation === frozen.generation && reply.result === 'info') {
        setSelected(reply.log_id); setLogs(old => [reply, ...old.filter(log => log.log_id !== reply.log_id)]);
        setMessage(action === 'start' ? '已接受记录请求；打开、写盘和同步结果见状态。' : '已停止接收新输出；停止前已提交的内容不会撤回，最终结果见日志状态。');
      }
    } catch (error) { if (mounted.current && current.current?.connection_id === frozen.connection_id && current.current.generation === frozen.generation) setMessage(String(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <>
    {(latest || monitorError) && <div className="input-status" aria-label="日志状态" role="status">日志：{monitorError || (latest && `${phases[latest.phase]}${latest.failure ? ` · ${failures[latest.failure] ?? latest.failure}，后续输出未记录` : ''} · 源缺口 ${latest.source_gap_bytes} 字节 · 拒绝 ${latest.rejected_records} 条${latest.durable ? ' · 保留窗口同步完成' : ''}`)}</div>}
    {open && <section className="config-panel" aria-label="终端日志面板">
      <div className="config-heading"><h2>终端日志</h2><button onClick={close}>关闭日志面板</button></div>
      <p aria-label="日志目标">目标 {targetText}</p>
      <small>仅记录启动后的终端新输出，原始字节与解码文本分开保存；不补写历史，可能从字符或控制序列中间开始。不包含独立 exec 任务或认证表单。关闭本面板不停止记录。</small>
      {!connection && <p>先选择或建立连接，再开始记录。</p>}
      <details><summary>下次启动的轮转限额</summary><div className="form-grid"><label>每段合计 MiB<input aria-label="日志每段MiB" type="number" min="0.125" max="100" step="0.125" value={size} onChange={event => setSize(Number(event.target.value))} /></label><label>保留段数<input aria-label="日志保留段数" type="number" min="1" max="16" value={segments} onChange={event => setSegments(Number(event.target.value))} /></label></div><small>不修改正在运行的记录。达到限额会覆盖该份日志最早的分段；两文件合计最多 {size * segments} MiB。失败不会自动扩容或重新记录。</small></details>
      <div className="config-actions"><button disabled={busy || connection?.state !== 'CONNECTED' || visibleLogs.some(log => log.active) || !Number.isFinite(size) || size < 0.125 || size > 100 || !Number.isInteger(segments) || segments < 1 || segments > 16} onClick={() => void act('start')}>开始记录终端</button><button disabled={busy || !shown?.active} onClick={() => void act('stop')}>停止记录终端</button></div>
      {visibleLogs.length > 0 && <label>本次服务日志<select aria-label="日志记录" value={shown?.log_id ?? ''} onChange={event => setSelected(event.target.value)}>{visibleLogs.map(log => <option key={log.log_id} value={log.log_id}>{log.log_id.slice(0, 8)} · {phases[log.phase]}</option>)}</select></label>}
      {shown && <p aria-label="日志详情">{shown.log_id} · {phases[shown.phase]} · 编码 {shown.encoding} · 限额 {shown.limits.segment_bytes / 1024 / 1024} MiB × {shown.limits.segments} · 原始起点 {shown.source_cursor} / 文本起点 {shown.text_cursor} · 已接受 {shown.accepted_records} 条 / 成对写入 {shown.written_records} 条 · 最后成功写入的分段 {shown.first_retained_segment}–{shown.last_segment} / 退休 {shown.retired_segments} 段 · {shown.worker_finished ? '文件线程已结束' : '文件线程尚未结束'}{shown.durable ? ' · 保留窗口已同步' : ' · 尚无同步完成保证'}{shown.source_gap_bytes > 0 && ` · 接收源缺口 ${shown.source_gap_bytes} 字节，不能视为完整数据`}{shown.failure && ` · ${failures[shown.failure] ?? shown.failure}`}</p>}
      <small>本次服务记录与持久历史分开显示。文件保留在应用数据目录的 terminal-logs。</small>
      <LogHistoryPanel />
      {message && <p role="status">{message}</p>}
    </section>}
  </>;
}
