import { useEffect, useRef, useState } from 'react';
import { logging, type ArchiveInfo, type HistoryEntry, type HistoryPage, type HistoryRecord } from './logging-api';
import { LiteralLogSearch, visibleControls, type LogMatch } from './log-search';
import { requestId } from './request-id';
import { LogExportPanel } from './log-export-panel';
type Handle = { info: ArchiveInfo; read_id: string; cursor: number };
const states: Record<HistoryEntry['state'], string> = { HEADER_CHECKED: '头部已核对，内容待读取验证', UNFINISHED: '尚无可读完成标志', INVALID: '文件或格式无效', UNAVAILABLE: '文件被占用或不可访问' };
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function logTime(timestamp: number) {
  const date = new Date(timestamp);
  return Number.isSafeInteger(timestamp) && Number.isFinite(date.getTime()) ? `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}.${String(timestamp % 1000).padStart(3, '0')}` : '时间超出显示范围';
}
function scope(handle: Handle) { return { connection: handle.info.connection, log_id: handle.info.log_id, read_id: handle.read_id }; }
function safe(info: ArchiveInfo) {
  return [info.connection.generation, info.source_cursor, info.text_cursor, info.available_from, info.source_available_from, info.first_retained_segment, info.last_segment, info.written_records, info.written_raw_bytes, info.started_at_ms, info.text_cursor + info.written_records, info.source_cursor + info.written_records, info.source_gap_bytes ?? 0].every(value => Number.isSafeInteger(value) && value >= 0);
}
function display(records: HistoryRecord[], hex: boolean): string {
  return records.map(record => {
    const event = record.text;
    const heading = `[文本 ${event.seq} / 来源 ${event.source_seq ?? '最终排空'} · ${logTime(event.timestamp_ms)}${event.decode_error ? ' · 解码含替换字符' : ''}]`;
    if (event.gap_bytes !== null) return `${heading}\n[源缺口 ${event.gap_bytes} 字节，内容未知]`;
    return `${heading}\n${hex ? (record.raw?.bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ') || '[无原始字节]') : visibleControls(event.text)}`;
  }).join('\n');
}
export function LogHistoryPanel() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState('');
  const [handle, setHandle] = useState<Handle>();
  const [page, setPage] = useState<HistoryPage>();
  const [hex, setHex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('先刷新历史目录，再选择日志；不会向活动连接发送内容。');
  const [needle, setNeedle] = useState('');
  const [matches, setMatches] = useState<LogMatch[]>([]);
  const [searchStatus, setSearchStatus] = useState('');
  const mounted = useRef(true);
  const owned = useRef(new Set<Handle>());
  const browser = useRef<Handle | undefined>(undefined);
  const job = useRef<{ cancelled: boolean } | undefined>(undefined);
  async function release(target: Handle) {
    try { await logging({ op: 'history_close', ...scope(target) }); return true; }
    catch { return false; }
    finally { owned.current.delete(target); }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (job.current) job.current.cancelled = true;
      for (const target of owned.current) void release(target);
    };
  }, []);
  const entry = entries.find(item => item.log_id === selected);
  const shownInfo = handle?.info.log_id === selected ? handle.info : entry?.info;
  async function closeBrowser() {
    const old = browser.current; browser.current = undefined;
    if (mounted.current) { setHandle(undefined); setPage(undefined); }
    return old ? release(old) : true;
  }
  async function open(info: ArchiveInfo): Promise<Handle> {
    if (!safe(info)) throw new Error('日志数值超出桌面精确表示范围，未开始读取。');
    const target = { info, read_id: requestId(), cursor: info.available_from };
    owned.current.add(target);
    try {
      const reply = await logging({ op: 'history_open', ...scope(target) });
      if (reply.result !== 'history_opened' || reply.read_id !== target.read_id || reply.info.log_id !== info.log_id || reply.info.connection.connection_id !== info.connection.connection_id || reply.info.connection.generation !== info.connection.generation || !safe(reply.info)) throw new Error('历史日志打开响应不匹配。');
      target.info = reply.info; target.cursor = reply.info.available_from;
      if (!mounted.current) throw new Error('面板已关闭。');
      return target;
    } catch (error) { await release(target); throw error; }
  }
  async function next(target: Handle): Promise<HistoryPage> {
    const reply = await logging({ op: 'history_read', ...scope(target), cursor: target.cursor, max_records: 64, max_bytes: 32768 });
    if (reply.result !== 'history_page' || reply.read_id !== target.read_id || reply.log_id !== target.info.log_id || reply.connection.connection_id !== target.info.connection.connection_id || reply.connection.generation !== target.info.connection.generation || reply.cursor !== target.cursor || !Number.isSafeInteger(reply.next_cursor) || reply.next_cursor !== target.cursor + reply.records.length || (!reply.finished && !reply.records.length)) throw new Error('历史日志分页响应不匹配，未接受内容。');
    target.cursor = reply.next_cursor;
    return reply;
  }
  async function refresh() {
    if (busy) return; setBusy(true);
    try {
      const reply = await logging({ op: 'history_list' });
      if (!mounted.current || reply.result !== 'history_list') return;
      await closeBrowser();
      if (!mounted.current) return;
      setEntries(reply.logs); setSelected(reply.logs.find(item => item.log_id === selected)?.log_id ?? reply.logs[0]?.log_id ?? '');
      setMatches([]); setSearchStatus('');
      setMessage(reply.logs.length ? '目录仅核对文件头；打开后逐页验证内容。' : '尚无历史日志；可先显式开始并停止终端记录。');
    } catch (error) { if (mounted.current) setMessage(errorText(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function choose(value: string) {
    if (busy) return; setBusy(true);
    const closed = await closeBrowser();
    if (mounted.current) { setSelected(value); setMatches([]); setSearchStatus(''); setMessage(closed ? '已切换历史目标；尚未打开读取。' : '历史目标已切换，旧读取关闭未确认；服务将按闲置期限回收。'); setBusy(false); }
  }
  async function browse(reopen: boolean) {
    const metadata = entry?.info;
    if (busy || !metadata) return; setBusy(true);
    try {
      if (reopen) { await closeBrowser(); browser.current = await open(metadata); }
      const target = browser.current;
      if (!target) return;
      const result = await next(target);
      if (mounted.current) { setHandle({ ...target }); setPage(result); setMessage(result.finished ? '保留范围全部内容已通过结构校验；捕获前及退休段不在范围内。' : '当前页已核对；保留范围尚未全部读取验证。'); }
    } catch (error) { await closeBrowser(); if (mounted.current) setMessage(errorText(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function search() {
    const metadata = entry?.info;
    if (busy || !metadata || !needle.length || needle.length > 256) return;
    const matcher = new LiteralLogSearch(needle); const task = { cancelled: false }; job.current = task;
    let target: Handle | undefined; let count = 0; let found: LogMatch[] = [];
    setBusy(true); setMatches([]); setSearchStatus('正在从保留起点读取并搜索…');
    try {
      target = await open(metadata);
      for (;;) {
        const result = await next(target);
        if (task.cancelled || !mounted.current) break;
        for (const record of result.records) { found = [...found, ...matcher.push(record.text)]; count++; }
        setMatches(found); setSearchStatus(`已扫描 ${count} 条，累计匹配 ${matcher.total} 条，显示 ${found.length} 条；尚未全检。`);
        if (result.finished) { setSearchStatus(`保留范围搜索与结构校验完成，累计匹配 ${matcher.total} 条，显示前 ${found.length} 条${matcher.limited ? '（结果列表上限 100 条）' : ''}；捕获前及退休段不在范围内。`); break; }
      }
      if (mounted.current && task.cancelled) setSearchStatus(`搜索已停止，已扫描前缀累计匹配 ${matcher.total} 条，显示前 ${found.length} 条；尚未全检。`);
    } catch (error) { if (mounted.current) setSearchStatus(`${errorText(error)} 先前结果仅覆盖已扫描前缀，尚未全检。`); }
    finally {
      if (target && !(await release(target)) && mounted.current) setMessage('搜索读取关闭未确认；服务将按闲置期限回收。');
      if (job.current === task) job.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }
  return <details aria-label="历史日志工具"><summary>历史日志、搜索与导出</summary>
    <div className="config-actions"><button disabled={busy} onClick={() => void refresh()}>刷新历史目录</button></div>
    <label>历史日志<select aria-label="历史日志选择" value={selected} disabled={busy || !entries.length} onChange={event => void choose(event.target.value)}>{!entries.length && <option value="">尚未加载目录</option>}{entries.map(item => <option key={item.log_id} value={item.log_id}>{item.info && `${logTime(item.info.started_at_ms)} · ${item.info.protocol} · `}{item.log_id.slice(0, 8)} · {states[item.state]}</option>)}</select></label>
    {entry && <p aria-label="历史日志目标">日志 {entry.log_id} · {states[entry.state]}{shownInfo && ` · ${shownInfo.protocol} · ${shownInfo.connection.connection_id} / ${shownInfo.connection.generation} · ${shownInfo.encoding} · 初始文本 ${shownInfo.text_cursor} / 保留起点 ${shownInfo.available_from} · 保留分段 ${shownInfo.first_retained_segment}–${shownInfo.last_segment} · 声明源缺口 ${shownInfo.source_gap_bytes ?? '未知'} 字节`}</p>}
    <small>浏览独立于活动连接；仅显示已完成日志的保留范围，时间显示北京时间。完成标志与文件头不代表内容已全检。失败/未完成日志暂不可读。文本保留 ANSI 并以转义显示控制字符，不作为终端执行；HEX 是原始字节。当前页替换上一页，不累积整份文件到内存。</small>
    <div className="config-actions"><button disabled={busy || !entry?.info} onClick={() => void browse(true)}>打开历史日志</button><button disabled={busy || !handle || page?.finished} onClick={() => void browse(false)}>读取下一页</button><button disabled={busy || !handle} onClick={() => { setBusy(true); void closeBrowser().then(closed => { if (mounted.current) { setMessage(closed ? '历史读取已关闭。' : '关闭未确认；服务将按闲置期限回收。'); setBusy(false); } }); }}>关闭历史读取</button></div>
    <label className="check"><input type="checkbox" aria-label="历史显示HEX" checked={hex} onChange={event => setHex(event.target.checked)} />显示原始 HEX</label>
    {page && <><p aria-label="历史分页范围">本页文本游标 {page.cursor}–{page.next_cursor}（不含结束值） · {page.records.length} 条 · {page.finished ? '保留范围全检通过' : '尚未全检'}</p><pre aria-label="历史日志内容">{display(page.records, hex) || '本页无新记录。'}</pre></>}
    <p role="status" aria-label="历史读取状态">{message}</p>
    <label>搜索保留文本（区分大小写，字面匹配）<input aria-label="历史搜索内容" value={needle} maxLength={256} disabled={busy} onChange={event => setNeedle(event.target.value)} /></label>
    <small>从保留起点重新扫描，支持跨记录匹配；源缺口会截断匹配。完整扫描并统计匹配总数，列表最多显示前 100 条；取消或读取失败时不声称全文搜索/校验完成。</small>
    <div className="config-actions"><button disabled={busy || !entry?.info || !needle.length || needle.length > 256} onClick={() => void search()}>搜索保留文本</button><button disabled={!busy || !job.current} onClick={() => { if (job.current) job.current.cancelled = true; }}>停止历史搜索</button></div>
    <p role="status" aria-label="历史搜索状态">{searchStatus}</p>
    {matches.length > 0 && <pre aria-label="历史搜索结果">{matches.map((match, index) => `${index + 1}. 文本 ${match.firstSeq}–${match.lastSeq}: ${visibleControls(match.excerpt)}`).join('\n')}</pre>}
    <LogExportPanel selected={entry?.info ?? undefined} disabled={busy} />
  </details>;
}
