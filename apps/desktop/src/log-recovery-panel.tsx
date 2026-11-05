import { useEffect, useRef, useState } from 'react';
import { logging } from './logging-api';
import { checkedRecoveryInfo, checkedRecoveryList, checkedRecoveryPage, recoveryStopText, sameRecoveryInfo, type RecoveryEntry, type RecoveryInfo, type RecoveryPage, type RecoveryScope } from './log-recovery';
import { display, logTime } from './log-records';
import { requestId } from './request-id';
import { LogRecoveryExportPanel } from './log-recovery-export-panel';
type Handle = { scope: RecoveryScope; info: RecoveryInfo; cursor: number; source: number; flushed: boolean };
type Job = { cancelled: boolean };
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);

export function LogRecoveryPanel() {
  const [open, setOpen] = useState(false);
  return <details aria-label="失败日志恢复工具" onToggle={event => setOpen(event.currentTarget.open)}><summary>失败日志只读前缀恢复</summary>{open && <RecoveryBrowser />}</details>;
}
function RecoveryBrowser() {
  const [entries, setEntries] = useState<RecoveryEntry[]>([]);
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState<RecoveryPage>();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [hex, setHex] = useState(false);
  const [message, setMessage] = useState('刷新恢复目录后，独立选择目标；不会修改源文件或向终端发送内容。');
  const mounted = useRef(true);
  const active = useRef<Handle | undefined>(undefined);
  const owned = useRef(new Set<Handle>());
  const job = useRef<Job | undefined>(undefined);
  const openButton = useRef<HTMLButtonElement>(null);
  const entry = entries.find(value => value.log_id === selected);
  async function release(target: Handle) {
    try {
      const reply = await logging({ op: 'recovery_close', ...target.scope });
      return reply.result === 'recovery_closed' && reply.read_id === target.scope.read_id;
    } catch { return false; }
    finally { owned.current.delete(target); }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (job.current) job.current.cancelled = true;
      active.current = undefined;
      for (const target of owned.current) void release(target);
    };
  }, []);
  function begin(): Job {
    const task = { cancelled: false }; job.current = task; setBusy(true); return task;
  }
  function valid(task: Job) { return mounted.current && !task.cancelled; }
  function finish(task: Job) {
    if (job.current === task) { job.current = undefined; if (mounted.current) setBusy(false); }
  }
  async function closeActive() {
    const old = active.current; active.current = undefined;
    if (mounted.current) { setOpened(false); setPage(undefined); }
    return old ? release(old) : true;
  }
  async function refresh() {
    if (busy) return;
    const task = begin();
    try {
      await closeActive();
      const logs = checkedRecoveryList(await logging({ op: 'recovery_list' }));
      if (!valid(task)) return;
      setEntries(logs); setSelected('');
      setMessage(logs.length ? '请选择恢复目标；头部可识别不代表内容完整。' : '尚无可见日志目录。');
    } catch (error) { if (valid(task)) setMessage(errorText(error)); }
    finally { finish(task); }
  }
  async function choose(id: string) {
    if (busy) return;
    const task = begin();
    const closed = await closeActive();
    if (valid(task)) { setSelected(id); setMessage(closed ? '目标已切换；尚未打开恢复读取。' : '旧读取关闭未确认，服务将按闲置期限回收；尚未读取新目标。'); }
    finish(task);
  }
  async function browse(reopen: boolean) {
    if (busy || !entry?.info) return;
    const metadata = entry.info;
    const task = begin();
    let target = active.current;
    try {
      if (reopen) {
        await closeActive();
        if (!valid(task)) return;
        const info = checkedRecoveryInfo(metadata);
        target = { scope: { connection: { ...info.connection }, log_id: info.log_id, read_id: requestId() }, info, cursor: info.available_from, source: info.source_available_from, flushed: false };
        owned.current.add(target);
        const reply = await logging({ op: 'recovery_open', ...target.scope });
        if (!valid(task)) { await release(target); return; }
        if (reply.result !== 'recovery_opened' || reply.read_id !== target.scope.read_id || !sameRecoveryInfo(checkedRecoveryInfo(reply.info), info)) throw new Error('恢复目标在打开前已变化，请刷新目录重新核对。');
        active.current = target;
        setOpened(true);
      }
      if (!target || !valid(task)) return;
      const reply = await logging({ op: 'recovery_read', ...target.scope, cursor: target.cursor, max_records: 64, max_bytes: 32768 });
      if (!valid(task)) { await release(target); return; }
      const checked = checkedRecoveryPage(reply, target.scope, target.info, target.cursor, target.source, target.flushed);
      target.cursor = checked.page.next_cursor; target.source = checked.source; target.flushed = checked.flushed;
      setPage(checked.page);
      setMessage(checked.page.stop ? recoveryStopText(checked.page.stop) : '本页前缀已验证，尚未到停止位置；日志完整性未知。');
    } catch (error) {
      if (target) await release(target);
      if (active.current === target) active.current = undefined;
      if (valid(task)) { setOpened(false); setMessage(`${errorText(error)} 未自动重开；已显示页仅为先前验证前缀。`); }
    } finally { finish(task); }
  }
  async function stop() {
    if (job.current) job.current.cancelled = true;
    const task = begin();
    active.current = undefined; setOpened(false); setPage(undefined);
    setMessage('已请求关闭恢复读取；在途响应将丢弃。');
    const closed = await Promise.all([...owned.current].map(release));
    if (valid(task)) setMessage(closed.every(Boolean) ? '恢复读取已关闭；源日志未修改。' : '关闭未确认；在途打开返回后再次释放，服务仍有闲置回收期限。');
    finish(task);
    requestAnimationFrame(() => { if (valid(task) && job.current === undefined) openButton.current?.focus(); });
  }
  return <fieldset aria-label="恢复读取面板"><legend>读取已验证前缀</legend>
    <small>仅尝试连续前缀，遇到首处错误停止；文件结尾也不代表完整或已同步。已退休段和捕获前内容不可恢复。当前页替换上一页，正文仅作历史文本显示。</small>
    <div className="config-actions"><button disabled={busy} onClick={() => void refresh()}>刷新恢复目录</button></div>
    <label>恢复目标<select aria-label="恢复日志选择" value={selected} disabled={busy} onChange={event => void choose(event.target.value)}><option value="">请选择恢复日志</option>{entries.map(value => <option key={value.log_id} value={value.log_id}>{value.log_id} · {value.info ? '首头可识别，内容未全检' : '不可识别或被占用'}</option>)}</select></label>
    {entry && <p className="data-location" aria-label="恢复日志目标">日志 {entry.log_id}{entry.info && ` · ${entry.info.protocol} · ${entry.info.connection.connection_id} / ${entry.info.connection.generation} · ${entry.info.encoding} · ${logTime(entry.info.started_at_ms)} · 捕获文本起点 ${entry.info.text_cursor} / 可见起点 ${entry.info.available_from} · 可见分段 ${entry.info.first_segment}–${entry.info.last_observed_segment} · 完成标志${entry.info.completion_present ? '存在（未验证）' : '缺失'} / 临时标志${entry.info.partial_present ? '存在' : '缺失'}`}</p>}
    <div className="config-actions"><button ref={openButton} disabled={busy || !entry?.info} onClick={() => void browse(true)}>打开只读恢复</button><button disabled={busy || !opened || !!page?.stop} onClick={() => void browse(false)}>读取恢复下一页</button><button disabled={!busy && !opened} onClick={() => void stop()}>停止并关闭恢复读取</button></div>
    <LogRecoveryExportPanel selected={entry?.info ?? undefined} disabled={busy || opened} />
    <label className="check"><input type="checkbox" aria-label="恢复显示HEX" checked={hex} onChange={event => setHex(event.target.checked)} />显示原始 HEX</label>
    {page && <><p aria-label="恢复分页范围">本页文本 {page.cursor}–{page.next_cursor}（不含结束值） · {page.records.length} 条 · 仅已验证前缀</p><pre aria-label="恢复日志内容">{display(page.records, hex) || '本页无新记录。'}</pre></>}
    <p role="status" aria-label="恢复读取状态">{message}</p>
  </fieldset>;
}
