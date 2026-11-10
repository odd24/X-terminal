import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ExportInfo } from './logging-api';
import type { RecoveryExportInfo } from './log-recovery-export';
import { checkedSave, restoreSave, terminalSave, type SaveInfo, type SaveScope, type SaveMode } from './log-save';
import { requestId } from './request-id';
const storageKey = (mode: SaveMode) => mode === 'TEXT' ? 'terminal-text-log-save-v1' : mode === 'RECOVERY' ? 'terminal-recovery-export-save-v1' : 'terminal-export-save-v1';
const states: Record<SaveInfo['phase'], string> = { CHOOSING: '正在选择系统保存位置', AWAITING_CONFIRMATION: '目标文件已存在，等待明确替换确认', COPYING: '正在校验、复制并同步', COMPLETED: '本次另存已完成', CANCELLED: '另存已取消', EXPIRED: '替换确认已到期，未执行替换', FAILED: '另存失败，请核对目标与残留文件', RECOVERY_REQUIRED: '发布未完成，需要检查原文件备份；未自动重试' };
const failures: Record<string, string> = { SOURCE: '源产物已变化或不可读，请重新核对导出', TARGET: '所选目标不可用或不是受支持的普通本地文件', DIALOG: '系统位置选择器不可用', STAGING: '无法在目标目录新建暂存文件', COPY: '复制中断或写入失败', SYNC: '无法确认文件已同步', PERMISSIONS: '无法保留原文件的访问权限', BACKUP: '无法保留原文件备份', PUBLISH: '目标名称发生冲突或发布失败', CANCELLED: '已请求取消', AUTHORIZATION: '未收到原授权的保存提交确认' };
type Task = SaveScope & { last?: SaveInfo };
function remembered(mode: SaveMode, key=storageKey(mode)) { try { const value = restoreSave(sessionStorage.getItem(key), mode); return value?.scope.mode === mode ? value : undefined; } catch { return undefined; } }
export function LogSavePanel({ source, mode = 'NORMAL', autoStart = false, onChange, serviceId }: { source?: ExportInfo | RecoveryExportInfo | (SaveScope['scope'] & { phase: 'COMPLETED' }); mode?: SaveMode; autoStart?: boolean; onChange?(info:SaveInfo):void; serviceId?: string }) {
  const key = mode==='MENU'?`terminal-menu-log-save-${source?.request_id??''}`:storageKey(mode); const recovery = mode === 'RECOVERY'; const label = (text: string) => recovery ? `恢复${text}` : mode === 'MENU' ? `右键日志${text}` : mode === 'TEXT' ? `文本${text}` : mode === 'PROTECTED' ? `保护文本${text}` : text;
  const [task, setTask] = useState<Task | undefined>(() => {const old=remembered(mode,key);return !['TEXT','MENU'].includes(mode)||old?.scope.connection.connection_id===source?.connection.connection_id&&old?.scope.connection.generation===source?.connection.generation&&old?.scope.log_id===source?.log_id&&old?.scope.request_id===source?.request_id?old:undefined;}); const current = useRef(task);
  const [pending, setPending] = useState(false); const busy = useRef(false); const mounted = useRef(true);
  const [uncertain, setUncertain] = useState(!!task); const [missing, setMissing] = useState(false); const [reviewed, setReviewed] = useState(false); const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState(task ? '已恢复另存编号，请查询；不会重新选择位置或恢复覆盖同意。' : (recovery ? '未完整恢复产物发布后，可选择系统保存位置；另存不会修复源日志。' : '已完成导出后，可选择系统保存位置。'));
  const query = useRef<HTMLButtonElement>(null); const focus = useRef(false);
  const check = useRef<HTMLInputElement>(null); const confirm = useRef<HTMLButtonElement>(null);
  async function close(target: Task) { if (target.last && terminalSave(target.last)) return; try { await invoke('export_save_request', { request: { op: 'cancel', scope: target.scope, save_id: target.save_id } }); } catch { /* bounded confirmation lease still expires; published files cannot be undone */ } }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (current.current) void close(current.current); }; }, []);
  async function run(target: Task, op: 'start' | 'status' | 'cancel' | 'confirm' | 'open_directory') {
    if (busy.current) return;
    if (uncertain && op !== 'status') return;
    if (op === 'confirm' && (!target.last?.confirmation || target.last.cancel_requested || !reviewed || uncertain || (target.last.expires_at_ms ?? 0) <= Date.now())) return;
    busy.current = true; setPending(true); if (op !== 'status') setReviewed(false); focus.current = op !== 'status';
    try {
      let reply: unknown;
      if (op === 'start' && mode === 'PROTECTED') {
        const { connection, request_id, log_id } = target.scope;
        const response = await invoke<{ type: string; data: unknown }>('protected_export_desktop_request', { request: { op: 'save', scope: { service_id: serviceId, query: { connection, request_id }, artifact_id: log_id }, save_id: target.save_id } });
        if (response.type !== 'save') throw new Error('另存回执类型不匹配');
        reply = response.data;
      } else {
        reply = await invoke('export_save_request', { request: { op, scope: target.scope, save_id: target.save_id, ...(op === 'confirm' ? { confirmation: target.last!.confirmation } : {}) } });
      }
      const info = checkedSave(reply, target, target.last);
      target.last = info;
      if (!mounted.current) { await close(target); return; }
      if (current.current !== target) return;
      onChange?.(info);
      if (info.phase !== 'AWAITING_CONFIRMATION' && (document.activeElement === check.current || document.activeElement === confirm.current)) focus.current = true;
      setTask({ ...target }); setUncertain(false); setMissing(false); setNow(Date.now());
      if (info.phase !== 'AWAITING_CONFIRMATION' || info.cancel_requested) setReviewed(false);
      setMessage(op === 'open_directory' ? '已请求 Windows 打开所选保存目录。' : `${states[info.phase]}。${recovery ? '恢复模式：保存内容始终为未完整前缀，不代表源日志完整。' : ''}${info.cancel_requested && !terminalSave(info) ? (info.phase === 'CHOOSING' ? '已请求取消，请关闭系统选择器；返回后不会继续复制。' : '已请求取消，等待文件操作返回；已开始的发布可能完成，不能承诺撤销。') : ''}${info.failure ? ` ${failures[info.failure] ?? '文件操作失败'}${info.os_code !== null ? `（系统代码 ${info.os_code}）` : ''}。` : ''}`);
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
    if (!source || source.phase !== 'COMPLETED' || (recovery && (!('incomplete' in source) || !source.incomplete || !source.recovered)) || busy.current || (current.current && !missing && (!current.current.last || !terminalSave(current.current.last) || uncertain))) return;
    const target: Task = { scope: { mode, connection: { ...source.connection }, log_id: source.log_id, request_id: source.request_id }, save_id: requestId() };
    current.current = target; setTask(target); setReviewed(false); setMissing(false); setUncertain(false);
    if (mode !== 'PROTECTED') {
      try { sessionStorage.setItem(key, JSON.stringify(target)); } catch { /* visible task ID remains usable */ }
    }
    void run(target, 'start');
  }
  const automatic=useRef(false);
  useEffect(()=>{if((mode==='TEXT'||mode==='MENU')&&autoStart&&!automatic.current){automatic.current=true;if(!current.current)start();}},[autoStart,mode]);
  const info = !uncertain && !missing ? task?.last : undefined; const active = !!task && !missing && (!task.last || !terminalSave(task.last) || uncertain);
  const settled=info&&(info.phase==='COMPLETED'||info.phase==='CANCELLED');
  if((mode==='TEXT'||mode==='MENU')&&settled)return <div aria-label={label('保存回执')}><p role="status" aria-label={label('导出另存状态')}>{info.phase==='COMPLETED'?`日志已保存：${info.path}`:'另存已取消。'}</p><div className="config-actions">{mode==='TEXT'&&<button disabled={pending} onClick={start}>{info.phase==='COMPLETED'?'另存一份':'重新另存'}</button>}{info.phase==='COMPLETED'&&<button disabled={pending} onClick={()=>{if(current.current)void run(current.current,'open_directory');}}>打开保存目录</button>}</div></div>;
  if(mode==='TEXT'||mode==='MENU')return <fieldset aria-label={label('导出另存')}><legend>保存日志</legend>
    <div className="config-actions">{!task&&!autoStart&&<button disabled={!source||pending||uncertain||missing} onClick={start}>选择保存位置</button>}{info&&(info.phase==='FAILED'||info.phase==='EXPIRED')&&<button disabled={pending||uncertain||missing} onClick={start}>重新选择保存位置</button>}{(uncertain||missing)&&<button ref={query} disabled={!task||pending} onClick={()=>{if(current.current)void run(current.current,'status');}}>查询保存结果</button>}{active&&!uncertain&&!missing&&<button disabled={pending||info?.cancel_requested} onClick={()=>{if(current.current)void run(current.current,'cancel');}}>取消保存</button>}{info?.phase==='COMPLETED'&&<button disabled={pending} onClick={()=>{if(current.current)void run(current.current,'open_directory');}}>打开目录</button>}</div>
    <p role={info&&['FAILED','RECOVERY_REQUIRED','EXPIRED'].includes(info.phase)?'alert':'status'} aria-label={label('导出另存状态')}>{message}</p>
    {info?.path&&<label>保存位置<input aria-label={label('另存文件路径')} readOnly value={info.path}/></label>}
    {info?.phase==='AWAITING_CONFIRMATION'&&<><p>目标文件已存在（{info.existing_bytes} 字节）。确认替换后会在同目录保留原文件备份。</p><label className="check"><input ref={check} type="checkbox" aria-label={label('确认替换保存文件')} checked={reviewed} disabled={pending||uncertain||info.cancel_requested||now>=info.expires_at_ms!} onChange={event=>setReviewed(event.target.checked)}/>我已核对保存位置，确认替换并保留原文件备份</label><button ref={confirm} disabled={!reviewed||pending||uncertain||info.cancel_requested||now>=info.expires_at_ms!} onClick={()=>{if(current.current)void run(current.current,'confirm');}}>确认替换并保存</button></>}
    {info?.backup&&<label>原文件备份<input aria-label={label('另存原文件备份')} readOnly value={info.backup}/></label>}
    {info?.staging&&<label>未发布暂存文件<input readOnly value={info.staging}/></label>}
    <details><summary>详细信息</summary><small>关闭面板会请求取消未完成任务，已发布文件不能撤销。保存使用系统选择器和文件校验；已有文件必须独立确认替换。结果不监控目录后来发生的变化。</small>{task&&<p className="data-location" aria-label={label('另存固定目标')}>文本日志 · {task.scope.log_id} · {task.scope.connection.connection_id} / {task.scope.connection.generation} · {task.scope.request_id} · {task.save_id}</p>}</details>
  </fieldset>;
  return <fieldset aria-label={label("导出另存")}><legend>{recovery ? "另存未完整恢复产物" : "另存到自选位置"}</legend>
    {recovery && <p>恢复模式 · 未完整前缀。另存仅复制已发布的恢复 JSONL，保留停止报告；文件保存完成也不代表源日志完整。</p>}
    <small>使用系统位置选择器。新文件在验证与同步后发布；已有文件需另行确认，并在同目录保留原文件备份。当前替换仅支持普通可写本地文件，特殊属性文件请选新文件名。关闭面板会请求取消未完成任务，已发布文件不能撤销。</small>
    <div className="config-actions"><button disabled={!source || pending || active} onClick={start}>{recovery ? "另存未完整恢复文件" : mode === 'PROTECTED' ? "另存保护文本" : "另存导出文件"}</button><button ref={query} disabled={!task || pending} onClick={() => { if (current.current) void run(current.current, 'status'); }}>{label("查询另存结果")}</button><button disabled={!active || pending || uncertain || missing || info?.cancel_requested} onClick={() => { if (current.current) void run(current.current, 'cancel'); }}>{label("取消另存")}</button>{mode !== 'PROTECTED' && <button disabled={!info?.path || pending || uncertain || active} onClick={() => { if (current.current) void run(current.current, 'open_directory'); }}>{label("打开保存目录")}</button>}</div>
    {task && <p className="data-location" aria-label={label("另存固定目标")}>{task.scope.mode === 'RECOVERY' ? '恢复模式 · 未完整 · ' : '普通导出 · '}日志 {task.scope.log_id} · {task.scope.connection.connection_id} / {task.scope.connection.generation} · 导出 {task.scope.request_id} · 另存 {task.save_id}</p>}
    {info?.path && <label>所选保存路径<input aria-label={label("另存文件路径")} readOnly value={info.path} onFocus={event => event.target.select()} /></label>}
    {info?.phase === 'AWAITING_CONFIRMATION' && <><p>原文件 {info.existing_bytes} 字节。确认到期 {new Date(info.expires_at_ms!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间。保留原访问权限；原文件移至同目录备份后再发布新文件。发生冲突时保留备份并报告恢复位置，不保证自动回滚。</p><label className="check"><input ref={check} type="checkbox" aria-label={label("确认替换保存文件")} checked={reviewed} disabled={pending || uncertain || info.cancel_requested || now >= info.expires_at_ms!} onChange={event => setReviewed(event.target.checked)} />{recovery ? "我已核对未完整恢复目标，确认替换并保留原文件备份" : "我已核对固定目标，确认替换并保留原文件备份"}</label><div className="config-actions"><button ref={confirm} disabled={!reviewed || pending || uncertain || info.cancel_requested || now >= info.expires_at_ms!} onClick={() => { if (current.current) void run(current.current, 'confirm'); }}>{label("确认替换并保存")}</button></div></>}
    {info?.backup && <label>原文件备份<input aria-label={label("另存原文件备份")} readOnly value={info.backup} onFocus={event => event.target.select()} /></label>}
    {info?.staging && <label>未发布暂存文件<input readOnly value={info.staging} onFocus={event => event.target.select()} /></label>}
    <p role="status" aria-label={label("导出另存状态")}>{message}</p><small>结果是本次操作回执，不监控用户目录后来发生的变化。服务导出与另存任务分别查询，不会重新执行终端输入。</small>
  </fieldset>;
}
