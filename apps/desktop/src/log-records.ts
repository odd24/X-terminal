import type { HistoryRecord } from './logging-api';
import { visibleControls } from './log-search';
export function logTime(timestamp: number) {
  const date = new Date(timestamp);
  return Number.isSafeInteger(timestamp) && Number.isFinite(date.getTime()) ? `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}.${String(timestamp % 1000).padStart(3, '0')}` : '时间超出显示范围';
}
export function display(records: HistoryRecord[], hex: boolean): string {
  return records.map(record => {
    const event = record.text;
    const heading = `[文本 ${event.seq} / 来源 ${event.source_seq ?? '最终排空'} · ${logTime(event.timestamp_ms)}${event.decode_error ? ' · 解码含替换字符' : ''}]`;
    if (event.gap_bytes !== null) return `${heading}\n[源缺口 ${event.gap_bytes} 字节，内容未知]`;
    return `${heading}\n${hex ? (record.raw?.bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ') || '[无原始字节]') : visibleControls(event.text)}`;
  }).join('\n');
}
