import { useEffect, useRef, useState } from 'react';
import { logging, CleanupRequestError, type CleanupInfo, type CleanupKind, type CleanupScope } from './logging-api';
import { canCommitCleanup, checkedCleanup, checkedCleanupList, restoreCleanup } from './log-cleanup';
import { requestId } from './request-id';

const key = 'terminal-log-cleanup-task-v1';
type Task = { scope: CleanupScope; last?: CleanupInfo; submitted?: boolean };
function restored() { try { return restoreCleanup(sessionStorage.getItem(key)); } catch { return undefined; } }
function remember(scope: CleanupScope) { try { sessionStorage.setItem(key, JSON.stringify(scope)); } catch { /* Visible identifiers remain available. */ } }
export function LogCleanupPanel({ onAffected }: { onAffected: (kind: CleanupKind, id: string, removed: boolean) => void }) {
  const [task, setTask] = useState<Task | undefined>(() => { const scope = restored(); return scope ? { scope, submitted: true } : undefined; });
  const [kind, setKind] = useState<CleanupKind>('LOG');
  const [ids, setIds] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(!!task);
  const [missing, setMissing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState(task ? '已恢复清理编号；请查询结果，确认勾选不会恢复。' : '先选择独立的清理目标并预览文件。');
  const current = useRef(task); const mounted = useRef(true); const inFlight = useRef(false);
  const query = useRef<HTMLButtonElement>(null); const check = useRef<HTMLInputElement>(null); const commit = useRef<HTMLButtonElement>(null);
  const focus = useRef<'query' | 'check' | undefined>(undefined);
  const affected = useRef(onAffected); affected.current = onAffected;
  async function cancelClosed(target: Task) {
    if (target.submitted || (target.last && target.last.phase !== 'PREVIEW')) return;
    try { await logging({ op: 'cleanup_cancel', ...target.scope }); } catch { /* The bounded lease still expires at the service. */ }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (current.current) void cancelClosed(current.current); }; }, []);
  async function run(target: Task, op: 'cleanup_preview' | 'cleanup_status' | 'cleanup_cancel' | 'cleanup_commit') {
    if (inFlight.current) return;
    const confirmation = target.last?.confirmation;
    if (op === 'cleanup_commit' && (!canCommitCleanup(target.last, reviewed, Date.now()) || uncertain || missing || !confirmation)) return;
    if (op === 'cleanup_commit') target.submitted = true;
    if (document.activeElement === check.current || document.activeElement === commit.current) focus.current = 'query';
    if (op !== 'cleanup_status') setReviewed(false);
    inFlight.current = true; setPending(true);
    try {
      const reply = await logging(op === 'cleanup_commit' ? { op, ...target.scope, confirmation: confirmation! } : { op, ...target.scope });
      const info = checkedCleanup(reply, target.scope, target.last); target.last = info;
      if (info.phase === 'PREVIEW' && op === 'cleanup_status') target.submitted = false;
      if (!mounted.current) { await cancelClosed(target); return; }
      if (current.current !== target) return;
      if (info.phase !== 'PREVIEW') {
        if (document.activeElement === check.current || document.activeElement === commit.current) focus.current = 'query';
        setReviewed(false);
      } else if (op === 'cleanup_preview') focus.current = 'check';
      setTask({ ...target }); setUncertain(false); setMissing(false); setNow(Date.now());
      const r = info.report;
      setMessage(info.phase === 'PREVIEW' ? '文件清单已锁定，30 秒租约以服务到期时间为准；核对后才能确认删除。' : info.phase === 'CANCELLED' ? '预览已取消，没有执行删除。' : info.phase === 'EXPIRED' ? '预览已到期，没有执行删除；需要重新预览并确认。' : r?.directory_removed && r.failure === null ? '清理完成，目标目录已删除。' : `清理未完整完成：${r?.failure === 'CHANGED' ? '文件集合已变化，未删除文件' : '存储操作失败，可能已删除部分文件'}。已完成删除不能撤销；未自动重试。`);
      if (r && (r.directory_removed || r.removed_files > 0 || r.failure === 'CHANGED')) affected.current(info.kind, info.id, r.directory_removed);
    } catch (error) {
      if (mounted.current && current.current === target) {
        const absent = error instanceof CleanupRequestError && ['NotFound', 'RequestExpired'].includes(error.code);
        setMissing(absent); setUncertain(!absent); setReviewed(false); focus.current = 'query';
        setMessage(`${error instanceof Error ? error.message : '请求失败。'} 保留原编号，仅查询结果；未自动再次预览或删除。${absent ? '可显式选择目标重新预览。' : ''}`);
      }
    } finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  useEffect(() => {
    if (!pending && focus.current) { (focus.current === 'check' ? check.current : query.current)?.focus(); focus.current = undefined; }
  }, [pending, task]);
  useEffect(() => {
    if (task?.last?.phase !== 'PREVIEW') return;
    const timer = setInterval(() => {
      const time = Date.now(); setNow(time);
      if (time >= (current.current?.last?.expires_at_ms ?? 0)) {
        setReviewed(false);
        if (document.activeElement === check.current || document.activeElement === commit.current) query.current?.focus();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [task]);
  useEffect(() => {
    if (task?.last?.phase !== 'PREVIEW' || pending || uncertain || missing) return;
    const timer = setTimeout(() => { if (current.current) void run(current.current, 'cleanup_status'); }, Math.max(1000, task.last.expires_at_ms - Date.now() + 100));
    return () => clearTimeout(timer);
  }, [task, pending, uncertain, missing]);
  const active = !!task && !missing && (!task.last || task.last.phase === 'PREVIEW' || uncertain);
  async function refresh() {
    if (inFlight.current || active) return;
    inFlight.current = true; setPending(true);
    try {
      const found = checkedCleanupList(await logging({ op: 'cleanup_list', kind }), kind);
      if (mounted.current) { setIds(found); setSelected(''); setMessage('已列出应用管理的目录编号；选择后预览，不会自动删除。'); }
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : '目录查询失败。'); }
    finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  function preview() {
    if (!selected || !ids.includes(selected) || active || inFlight.current) return;
    const target: Task = { scope: { kind, id: selected, preview_id: requestId() } };
    current.current = target; setTask(target); remember(target.scope); setReviewed(false); setUncertain(false); setMissing(false);
    void run(target, 'cleanup_preview');
  }
  const info = task?.last; const r = info?.report;
  return <details aria-label="日志清理工具"><summary>清理日志与导出文件</summary><fieldset><legend>预览并确认清理</legend>
    <small>仅整理应用管理的单个目录。不会跟随活动连接或历史日志选择。删除不能撤销；逻辑字节数不等于磁盘实际释放空间。关闭日志面板会尝试取消尚未提交的预览，已提交删除不能撤销。</small>
    <label>清理类别<select aria-label="清理类别" disabled={pending || active} value={kind} onChange={event => { setKind(event.target.value as CleanupKind); setIds([]); setSelected(''); }}><option value="LOG">原始日志与派生文本</option><option value="EXPORT">导出产物</option></select></label>
    <div className="config-actions"><button disabled={pending || active} onClick={() => void refresh()}>刷新清理目录</button></div>
    <label>独立清理目标<select aria-label="清理目标选择" disabled={pending || active || !ids.length} value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择目录编号</option>{ids.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <div className="config-actions"><button disabled={pending || active || !selected} onClick={preview}>预览清理文件</button><button ref={query} disabled={pending || !task} onClick={() => { if (current.current) void run(current.current, 'cleanup_status'); }}>查询清理结果</button><button disabled={pending || !active} onClick={() => { if (current.current) void run(current.current, 'cleanup_cancel'); }}>取消清理预览</button></div>
    {task && <p className="data-location" aria-label="清理固定目标">{task.scope.kind === 'LOG' ? '日志' : '导出'} {task.scope.id} · 预览 {task.scope.preview_id}</p>}
    {info && <><p aria-label="清理预览范围">{info.files.length} 个文件 · 逻辑 {info.logical_bytes} 字节 · 到期 {new Date(info.expires_at_ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间{info.phase === 'PREVIEW' && ` · 预计剩余 ${Math.max(0, Math.ceil((info.expires_at_ms - now) / 1000))} 秒（以服务为准）`}</p><pre aria-label="清理文件清单">{info.files.map(file => `${file.name} · ${file.bytes} 字节`).join('\n') || '空目录'}</pre></>}
    <label className="check"><input ref={check} aria-label="确认清理文件" type="checkbox" checked={reviewed} disabled={pending || uncertain || missing || info?.phase !== 'PREVIEW' || now >= info.expires_at_ms} onChange={event => setReviewed(event.target.checked)} />我已核对上述固定目标和全部文件，确认永久删除</label>
    <div className="config-actions"><button ref={commit} disabled={pending || uncertain || missing || !canCommitCleanup(info, reviewed, now)} onClick={() => { if (current.current) void run(current.current, 'cleanup_commit'); }}>确认删除清单文件</button></div>
    <p role="status" aria-label="日志清理状态">{message}</p>
    {r && <p aria-label="清理实际结果">已删除 {r.removed_files} 个文件 · 逻辑 {r.removed_logical_bytes} 字节 · 目录{r.directory_removed ? '已删除' : '仍保留'} · {r.failure ?? '无失败'}{r.os_code !== null && ` · 系统错误 ${r.os_code}`}。计数仅包含实际删除前缀，未恢复已删除文件。</p>}
  </fieldset></details>;
}
