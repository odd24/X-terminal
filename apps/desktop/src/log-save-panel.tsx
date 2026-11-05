import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ExportInfo } from './logging-api';
import { checkedSave, restoreSave, terminalSave, type SaveInfo, type SaveScope } from './log-save';
import { requestId } from './request-id';
const key = 'terminal-export-save-v1';
const states: Record<SaveInfo['phase'], string> = { CHOOSING: '正在选择系统保存位置', AWAITING_CONFIRMATION: '目标文件已存在，等待明确替换确认', COPYING: '正在校验、复制并同步', COMPLETED: '本次另存已完成', CANCELLED: '另存已取消', EXPIRED: '替换确认已到期，未执行替换', FAILED: '另存失败，请核对目标与残留文件', RECOVERY_REQUIRED: '发布未完成，需要检查原文件备份；未自动重试' };
const failures: Record<string, string> = { SOURCE: '源产物已变化或不可读，请重新核对导出', TARGET: '所选目标不可用或不是受支持的普通本地文件', DIALOG: '系统位置选择器不可用', STAGING: '无法在目标目录新建暂存文件', COPY: '复制中断或写入失败', SYNC: '无法确认文件已同步', PERMISSIONS: '无法保留原文件的访问权限', BACKUP: '无法保留原文件备份', PUBLISH: '目标名称发生冲突或发布失败', CANCELLED: '已请求取消' };
type Task = SaveScope & { last?: SaveInfo };
function remembered() { try { return restoreSave(sessionStorage.getItem(key)); } catch { return undefined; } }
export function LogSavePanel({ source }: { source?: ExportInfo }) {
  const [task, setTask] = useState<Task | undefined>(() => remembered()); const current = useRef(task);
  const [pending, setPending] = useState(false); const busy = useRef(false); const mounted = useRef(true);
  const [uncertain, setUncertain] = useState(!!task); const [missing, setMissing] = useState(false); const [reviewed, setReviewed] = useState(false); const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState(task ? '已恢复另存编号，请查询；不会重新选择位置或恢复覆盖同意。' : '已完成导出后，可选择系统保存位置。');
  const query = useRef<HTMLButtonElement>(null); const focus = useRef(false);
  const check = useRef<HTMLInputElement>(null); const confirm = useRef<HTMLButtonElement>(null);
  async function close(target: Task) { if (target.last && terminalSave(target.last)) return; try { await invoke('export_save_request', { request: { op: 'cancel', scope: target.scope, save_id: target.save_id } }); } catch { /* bounded confirmation lease still expires; published files cannot be undone */ } }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (current.current) void close(current.current); }; }, []);
  async function run(target: Task, op: 'start' | 'status' | 'cancel' | 'confirm' | 'open_directory') {
    if (busy.current) return;
    if (op === 'confirm' && (!target.last?.confirmation || target.last.cancel_requested || !reviewed || uncertain || (target.last.expires_at_ms ?? 0) <= Date.now())) return;
    busy.current = true; setPending(true); if (op !== 'status') setReviewed(false); focus.current = op !== 'status';
    try {
      const info = checkedSave(await invoke('export_save_request', { request: { op, scope: target.scope, save_id: target.save_id, ...(op === 'confirm' ? { confirmation: target.last!.confirmation } : {}) } }), target, target.last);
      target.last = info;
      if (!mounted.current) { await close(target); return; }
      if (current.current !== target) return;
      if (info.phase !== 'AWAITING_CONFIRMATION' && (document.activeElement === check.current || document.activeElement === confirm.current)) focus.current = true;
      setTask({ ...target }); setUncertain(false); setMissing(false); setNow(Date.now());
      if (info.phase !== 'AWAITING_CONFIRMATION' || info.cancel_requested) setReviewed(false);
      setMessage(op === 'open_directory' ? '已请求 Windows 打开所选保存目录。' : `${states[info.phase]}。${info.cancel_requested && !terminalSave(info) ? (info.phase === 'CHOOSING' ? '已请求取消，请关闭系统选择器；返回后不会继续复制。' : '已请求取消，等待文件操作返回；已开始的发布可能完成，不能承诺撤销。') : ''}${info.failure ? ` ${failures[info.failure] ?? '文件操作失败'}${info.os_code !== null ? `（系统代码 ${info.os_code}）` : ''}。` : ''}`);
    } catch (error) {
      if (mounted.current && current.current === target) { const absent = ['NOT_FOUND', 'REQUEST_EXPIRED'].includes(String(error)); setMissing(absent); setUncertain(!absent); setReviewed(false); setMessage(`另存请求未获有效结果（${error instanceof Error ? error.message : String(error)}）。保留原任务编号，请先查询；没有自动重新保存。`); }
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  useEffect(() => { if (!pending && focus.current) { focus.current = false; query.current?.focus(); } }, [pending]);
  useEffect(() => {
    if (!task?.last || terminalSave(task.last) || pending || uncertain || missing) return;
    const delay = task.last.phase === 'AWAITING_CONFIRMATION' && !task.last.cancel_requested ? Math.max(500, task.last.expires_at_ms! - Date.now() + 100) : 500;
    const timer = setTimeout(() => { if (current.current) void run(current.current, 'status'); }, delay); return () => clearTimeout(timer);
  }, [task, pending, uncertain, missing]);
  useEffect(() => { if (task?.last?.phase !== 'AWAITING_CONFIRMATION') return; const timer = setInterval(() => { const t = Date.now(); setNow(t); if (t >= (current.current?.last?.expires_at_ms ?? 0)) { setReviewed(false); if (document.activeElement === check.current || document.activeElement === confirm.current) query.current?.focus(); } }, 1000); return () => clearInterval(timer); }, [task]);
  function start() {
    if (!source || source.phase !== 'COMPLETED' || busy.current || (current.current && !missing && (!current.current.last || !terminalSave(current.current.last) || uncertain))) return;
    const target: Task = { scope: { connection: { ...source.connection }, log_id: source.log_id, request_id: source.request_id }, save_id: requestId() };
    current.current = target; setTask(target); setReviewed(false); setMissing(false); setUncertain(false); try { sessionStorage.setItem(key, JSON.stringify(target)); } catch { /* visible task ID remains usable */ } void run(target, 'start');
  }
  const info = task?.last; const active = !!task && !missing && (!info || !terminalSave(info) || uncertain);
  return <fieldset aria-label="导出另存"><legend>另存到自选位置</legend>
    <small>使用系统位置选择器。新文件在验证与同步后发布；已有文件需另行确认，并在同目录保留原文件备份。当前替换仅支持普通可写本地文件，特殊属性文件请选新文件名。关闭面板会请求取消未完成任务，已发布文件不能撤销。</small>
    <div className="config-actions"><button disabled={!source || pending || active} onClick={start}>另存导出文件</button><button ref={query} disabled={!task || pending} onClick={() => { if (current.current) void run(current.current, 'status'); }}>查询另存结果</button><button disabled={!active || pending || info?.cancel_requested} onClick={() => { if (current.current) void run(current.current, 'cancel'); }}>取消另存</button><button disabled={!info?.path || pending || uncertain || active} onClick={() => { if (current.current) void run(current.current, 'open_directory'); }}>打开保存目录</button></div>
    {task && <p className="data-location" aria-label="另存固定目标">日志 {task.scope.log_id} · {task.scope.connection.connection_id} / {task.scope.connection.generation} · 导出 {task.scope.request_id} · 另存 {task.save_id}</p>}
    {info?.path && <label>所选保存路径<input aria-label="另存文件路径" readOnly value={info.path} onFocus={event => event.target.select()} /></label>}
    {info?.phase === 'AWAITING_CONFIRMATION' && <><p>原文件 {info.existing_bytes} 字节。确认到期 {new Date(info.expires_at_ms!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间。保留原访问权限；原文件移至同目录备份后再发布新文件。发生冲突时保留备份并报告恢复位置，不保证自动回滚。</p><label className="check"><input ref={check} type="checkbox" aria-label="确认替换保存文件" checked={reviewed} disabled={pending || uncertain || info.cancel_requested || now >= info.expires_at_ms!} onChange={event => setReviewed(event.target.checked)} />我已核对固定目标，确认替换并保留原文件备份</label><div className="config-actions"><button ref={confirm} disabled={!reviewed || pending || uncertain || info.cancel_requested || now >= info.expires_at_ms!} onClick={() => { if (current.current) void run(current.current, 'confirm'); }}>确认替换并保存</button></div></>}
    {info?.backup && <label>原文件备份<input aria-label="另存原文件备份" readOnly value={info.backup} onFocus={event => event.target.select()} /></label>}
    {info?.staging && <label>未发布暂存文件<input readOnly value={info.staging} onFocus={event => event.target.select()} /></label>}
    <p role="status" aria-label="导出另存状态">{message}</p><small>结果是本次操作回执，不监控用户目录后来发生的变化。服务导出与另存任务分别查询，不会重新执行终端输入。</small>
  </fieldset>;
}
