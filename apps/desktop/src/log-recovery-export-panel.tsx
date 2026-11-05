import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logging, ExportRequestError, type ExportScope } from './logging-api';
import { checkedRecoveryExport, restoreRecoveryExport, type RecoveryExportInfo, type RecoveryExportRequest } from './log-recovery-export';
import { checkedRecoveryInfo, recoveryStopText, type RecoveryInfo } from './log-recovery';
import { requestId } from './request-id';
import { LogSavePanel } from './log-save-panel';

const key = 'terminal-log-recovery-export-task-v1';
const terminal = (info: RecoveryExportInfo) => ['COMPLETED', 'CANCELLED', 'FAILED', 'REMOVED'].includes(info.phase);
const states = { QUEUED: '等待恢复导出', RUNNING: '正在生成未完整前缀文件', CANCELLING: '已请求停止，等待确认', COMPLETED: '未完整前缀文件已保存到应用目录', CANCELLED: '恢复导出已停止，未发布文件', FAILED: '恢复导出失败，未发布文件', REMOVED: '恢复导出产物已整理，不再可用' };
const failures = { INVALID_SOURCE: '源日志不可读取或范围不匹配', CAPACITY: '共享导出容量已满', TOO_LARGE: '编码文件超过256 MiB', STORAGE: '存储失败或已有同编号目录', WORKER_FAILED: '工作线程失败' };
type Task = { scope: ExportScope; last?: RecoveryExportInfo };
function remembered(): Task | undefined { try { const scope = restoreRecoveryExport(sessionStorage.getItem(key)); return scope ? { scope } : undefined; } catch { return; } }
export function LogRecoveryExportPanel({ selected, disabled }: { selected?: RecoveryInfo; disabled: boolean }) {
  const [task, setTask] = useState<Task | undefined>(remembered);
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(!!task);
  const [missing, setMissing] = useState(false);
  const [message, setMessage] = useState(task ? '已恢复恢复导出编号；请查询，不会自动重启。' : '独立选择恢复目标后，显式导出未完整前缀。');
  const [directory, setDirectory] = useState('');
  const current = useRef(task);
  const mounted = useRef(true);
  const busy = useRef(false);
  const path = useRef<HTMLInputElement>(null);
  const query = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  async function close(target: Task) {
    if (target.last && terminal(target.last)) return;
    try { await logging({ op: 'recovery_export_cancel', ...target.scope }); } catch { /* Original ID remains queryable; no restart. */ }
  }
  useEffect(() => {
    mounted.current = true;
    void invoke<string>('config_directory').then(value => { if (mounted.current) setDirectory(value); }).catch(() => {});
    return () => { mounted.current = false; if (current.current) void close(current.current); };
  }, []);
  async function run(target: Task, op: RecoveryExportRequest['op']) {
    if (busy.current) return;
    busy.current = true; setPending(true);
    try {
      const info = checkedRecoveryExport(await logging({ op, ...target.scope }), target.scope);
      target.last = info;
      if (!mounted.current) { await close(target); return; }
      if (current.current !== target) return;
      if (info.phase === 'REMOVED' && document.activeElement === path.current) refocus.current = true;
      setTask({ ...target }); setUnknown(false); setMissing(false);
      setMessage(`${states[info.phase]}${info.failure ? `：${failures[info.failure]}` : ''}。源日志始终未完整，文件结尾也不代表源完整或已同步。`);
    } catch (error) {
      if (mounted.current && current.current === target) {
        const absent = error instanceof ExportRequestError && ['NotFound', 'RequestExpired'].includes(error.code);
        setMissing(absent); setUnknown(!absent);
        setMessage(`${error instanceof Error ? error.message : '恢复导出请求失败。'} ${absent ? '旧编号保留，可显式新建；不覆盖已有文件。' : '保留原任务编号，仅查询结果；未自动重启。'}`);
      }
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  useEffect(() => { if (refocus.current && !pending) { refocus.current = false; query.current?.focus(); } }, [task, pending]);
  useEffect(() => {
    if (!task?.last || (terminal(task.last) && task.last.phase !== 'COMPLETED') || pending || unknown || missing) return;
    const timer = setTimeout(() => { if (current.current) void run(current.current, 'recovery_export_status'); }, task.last.phase === 'COMPLETED' ? 5000 : 500);
    return () => clearTimeout(timer);
  }, [task, pending, unknown, missing]);
  const active = task && !missing && (!task.last || !terminal(task.last) || unknown);
  function start() {
    if (!selected || disabled || busy.current || active) return;
    let info: RecoveryInfo;
    try { info = checkedRecoveryInfo(selected); } catch { setMessage('恢复目标无效，请刷新目录重新核对。'); return; }
    const target: Task = { scope: { connection: { ...info.connection }, log_id: info.log_id, request_id: requestId() } };
    current.current = target; setTask(target); setUnknown(false); setMissing(false);
    try { sessionStorage.setItem(key, JSON.stringify({ ...target.scope, mode: 'RECOVERY' })); } catch { /* Visible ID still identifies the original task. */ }
    setMessage('已固定恢复导出目标；从最早可见前缀重新校验，不采用浏览页游标。');
    void run(target, 'recovery_export_start');
  }
  const done = !unknown && !missing && task?.last?.phase === 'COMPLETED' ? task.last : undefined;
  return <fieldset aria-label="恢复日志导出"><legend>导出未完整前缀</legend>
    <small>仅生成显式未完整 JSONL，不修复源文件；已退休段和捕获前内容不包含。与普通导出共用8次尝试（含失败）及每份256 MiB上限。关闭面板会请求停止，已发布文件保留。</small>
    <div className="config-actions"><button disabled={disabled || !selected || pending || !!active} onClick={start}>导出未完整恢复前缀</button><button ref={query} disabled={!task || pending} onClick={() => { if (current.current) void run(current.current, 'recovery_export_status'); }}>查询恢复导出结果</button><button disabled={!active || pending || unknown || missing} onClick={() => { if (current.current) void run(current.current, 'recovery_export_cancel'); }}>停止恢复导出</button></div>
    {task && <p className="data-location" aria-label="恢复导出任务目标">恢复模式 · 日志 {task.scope.log_id} · {task.scope.connection.connection_id} / {task.scope.connection.generation} · 任务 {task.scope.request_id}</p>}
    <p role="status" aria-label="恢复导出状态">{message}</p>
    {done?.recovered && <><p aria-label="恢复导出范围">未完整 · 已恢复 {done.recovered.recovered_records} 条 · 原始 {done.recovered.recovered_raw_bytes} 字节 · 源缺口 {done.recovered.recovered_gap_bytes} 字节 · 文件 {done.bytes} 字节 · {recoveryStopText(done.recovered.stop)}</p><label>恢复产物路径<input ref={path} aria-label="恢复导出文件路径" readOnly value={`${directory ? `${directory}\\` : ''}terminal-log-exports\\${done.request_id}\\export.jsonl`} onFocus={event => event.target.select()} /></label>{!directory && <small>应用目录暂不可用，以上为相对位置。</small>}</>}
    <LogSavePanel mode="RECOVERY" source={done} />
  </fieldset>;
}
