import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logging, ExportRequestError, type ArchiveInfo, type ExportInfo, type ExportScope } from './logging-api';
import { checkedExport, restoreExport, terminalExport } from './log-export';
import { requestId } from './request-id';

const storageKey = 'terminal-log-export-task-v1';
const states: Record<ExportInfo['phase'], string> = { QUEUED: '等待导出', RUNNING: '正在校验并生成文件', CANCELLING: '已请求停止，等待服务确认', COMPLETED: '导出文件已保存到应用目录', CANCELLED: '导出已停止，未发布文件', FAILED: '导出失败，未发布文件' };
const failures: Record<NonNullable<ExportInfo['failure']>, string> = { INVALID_SOURCE: '源日志未完成、已损坏或范围不匹配', CAPACITY: '导出目录容量或磁盘空间不足', TOO_LARGE: '编码后的文件超过 256 MiB 上限', STORAGE: '文件存储失败或已有同编号目录', WORKER_FAILED: '导出工作线程失败' };
function remembered() { try { return restoreExport(sessionStorage.getItem(storageKey)); } catch { return undefined; } }
function remember(target: ExportScope) { try { sessionStorage.setItem(storageKey, JSON.stringify(target)); } catch { /* The task still has an explicit, visible ID. */ } }
type Task = { scope: ExportScope; last?: ExportInfo };

export function LogExportPanel({ selected, disabled }: { selected?: ArchiveInfo; disabled: boolean }) {
  const [task, setTask] = useState<Task | undefined>(() => { const scope = remembered(); return scope ? { scope } : undefined; });
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(!!task);
  const [missing, setMissing] = useState(false);
  const [message, setMessage] = useState(task ? '已恢复上次任务编号；请查询结果，不会重新启动导出。' : '选择历史日志后可导出 JSONL 文件。');
  const [directory, setDirectory] = useState('');
  const current = useRef(task);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  async function cancelClosed(target: Task) {
    if (target.last && terminalExport(target.last)) return;
    try { await logging({ op: 'export_cancel', ...target.scope }); } catch { /* Outcome remains unknown; the saved ID can be queried after reopening. */ }
  }
  useEffect(() => {
    mounted.current = true;
    void invoke<string>('config_directory').then(path => { if (mounted.current) setDirectory(path); }).catch(() => {});
    return () => { mounted.current = false; if (current.current) void cancelClosed(current.current); };
  }, []);
  async function run(target: Task, op: 'export_start' | 'export_status' | 'export_cancel') {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    try {
      const result = checkedExport(await logging({ op, ...target.scope }), target.scope);
      target.last = result;
      if (!mounted.current) { await cancelClosed(target); return; }
      if (current.current !== target) return;
      setTask({ ...target }); setUncertain(false); setMissing(false);
      setMessage(`${states[result.phase]}${result.failure ? `：${failures[result.failure]}` : ''}。${result.phase === 'COMPLETED' ? '仅包含保留范围；捕获前及退休段不在文件中。' : ''}`);
    } catch (error) {
      if (mounted.current && current.current === target) {
        const absent = error instanceof ExportRequestError && error.code === 'NotFound';
        setMissing(absent); setUncertain(!absent);
        setMessage(`${error instanceof Error ? error.message : '请求失败。'} ${absent ? '旧编号保留供核对；可为选中日志显式新建导出，已有文件不会覆盖。' : '保留原任务编号，仅查询结果；未自动重启导出。'}`);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  useEffect(() => {
    if (!task?.last || terminalExport(task.last) || pending || uncertain || missing) return;
    const timer = setTimeout(() => { const target = current.current; if (target) void run(target, 'export_status'); }, 500);
    return () => clearTimeout(timer);
  }, [task, pending, uncertain, missing]);
  function start() {
    if (!selected || disabled || inFlight.current || (current.current && !missing && (!current.current.last || !terminalExport(current.current.last) || uncertain))) return;
    if (![selected.connection.generation, selected.available_from, selected.written_records, selected.written_raw_bytes].every(value => Number.isSafeInteger(value) && value >= 0)) { setMessage('日志数值超出桌面精确表示范围，未启动导出。'); return; }
    const target: Task = { scope: { connection: { ...selected.connection }, log_id: selected.log_id, request_id: requestId() } };
    current.current = target; setTask(target); remember(target.scope); setUncertain(false); setMissing(false);
    setMessage('正在提交导出；目标已固定，不跟随活动连接或历史选择切换。');
    void run(target, 'export_start');
  }
  const done = !uncertain && !missing && task?.last?.phase === 'COMPLETED' ? task.last : undefined;
  const active = task && !missing && (!task.last || !terminalExport(task.last) || uncertain);
  return <fieldset aria-label="历史日志导出"><legend>导出日志</legend>
    <small>保存 JSONL 到应用目录，原始字节与派生文本分别保留。每份最多 256 MiB，共保留 8 次尝试（含失败）；不会覆盖已有文件。关闭日志面板会请求停止未完成任务，已保存文件保留。</small>
    <div className="config-actions"><button disabled={disabled || !selected || pending || !!active} onClick={start}>导出选中日志</button><button disabled={!task || pending} onClick={() => { if (current.current) void run(current.current, 'export_status'); }}>查询导出结果</button><button disabled={!active || pending} onClick={() => { if (current.current) void run(current.current, 'export_cancel'); }}>停止日志导出</button></div>
    {task && <p className="data-location" aria-label="导出任务目标">日志 {task.scope.log_id} · {task.scope.connection.connection_id} / {task.scope.connection.generation} · 任务 {task.scope.request_id}</p>}
    <p role="status" aria-label="日志导出状态">{message}</p>
    {done && <><p aria-label="日志导出范围">实际保留 {done.retained_records} 条 · 原始 {done.retained_raw_bytes} 字节 · 源缺口 {done.retained_gap_bytes} 字节 · 文本结束游标 {done.next_cursor} · 文件 {done.bytes} 字节</p><label>已保存文件路径<input aria-label="日志导出文件路径" readOnly value={`${directory ? `${directory}\\` : ''}terminal-log-exports\\${done.request_id}\\export.jsonl`} onFocus={event => event.target.select()} /></label>{!directory && <small>应用目录路径暂不可用，以上为相对应用目录的位置。</small>}</>}
  </fieldset>;
}
