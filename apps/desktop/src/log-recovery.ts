import type { ConnectionRef } from './ssh-api';
import type { HistoryRecord } from './logging-api';

export type RecoveryInfo = { log_id: string; connection: ConnectionRef; protocol: string; encoding: string; started_at_ms: number; source_cursor: number; text_cursor: number; limits: { segment_bytes: number; segments: number }; first_segment: number; last_observed_segment: number; available_from: number; source_available_from: number; completion_present: boolean; partial_present: boolean };
export type RecoveryScope = { connection: ConnectionRef; log_id: string; read_id: string };
export type RecoveryEntry = { log_id: string; info: RecoveryInfo | null };
export type RecoveryRequest = { op: 'recovery_list' } | ({ op: 'recovery_open' | 'recovery_close' } & RecoveryScope) | ({ op: 'recovery_read'; cursor: number; max_records: number; max_bytes: number } & RecoveryScope);
const reasons = { END_OF_AVAILABLE: '已到可见文件结尾', MISSING_PARTNER: '缺少配对文件', MISSING_SEGMENT: '中间分段缺失', INVALID_HEADER: '分段头损坏', DISCONTINUITY: '分段身份或序号不连续', TRUNCATED_RECORD: '记录尾部截断', INVALID_RECORD: '记录配对或格式损坏', STORAGE: '存储读取失败' };
export type RecoveryStop = { kind: keyof typeof reasons; segment: number; next_cursor: number };
export type RecoveryPage = RecoveryScope & { cursor: number; next_cursor: number; available_from: number; source_available_from: number; records: HistoryRecord[]; stop: RecoveryStop | null };
export type RecoveryReply = { result: 'recovery_list'; logs: RecoveryEntry[] } | { result: 'recovery_opened'; read_id: string; info: RecoveryInfo } | ({ result: 'recovery_page' } & RecoveryPage) | { result: 'recovery_closed'; read_id: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 1): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
const bad = () => new Error('恢复响应的目标、范围或内容不匹配；未接受本页。');
export function checkedRecoveryInfo(value: unknown): RecoveryInfo {
  if (!object(value) || !uuid(value.log_id) || !object(value.connection) || !uuid(value.connection.connection_id) || !integer(value.connection.generation) || !['SSH1', 'SSH2', 'SERIAL', 'FIXTURE'].includes(value.protocol as string) || !['utf-8', 'gbk', 'gb18030'].includes(value.encoding as string) || !integer(value.started_at_ms, 0) || !object(value.limits) || !integer(value.limits.segment_bytes, 131072) || value.limits.segment_bytes > 104857600 || !integer(value.limits.segments) || value.limits.segments > 16 || typeof value.completion_present !== 'boolean' || typeof value.partial_present !== 'boolean') throw bad();
  for (const key of ['source_cursor', 'text_cursor', 'first_segment', 'last_observed_segment', 'available_from', 'source_available_from']) if (!integer(value[key])) throw bad();
  const info = value as unknown as RecoveryInfo;
  // Observed numbers may contain gaps; only the reader determines continuity.
  if (info.last_observed_segment < info.first_segment || info.available_from < info.text_cursor || info.source_available_from < info.source_cursor || (info.first_segment === 1 && (info.available_from !== info.text_cursor || info.source_available_from !== info.source_cursor))) throw bad();
  return info;
}
export function checkedRecoveryList(value: unknown): RecoveryEntry[] {
  if (!object(value) || value.result !== 'recovery_list' || !Array.isArray(value.logs) || value.logs.length > 64) throw bad();
  const ids = new Set<string>();
  return value.logs.map(entry => {
    if (!object(entry) || !uuid(entry.log_id) || ids.has(entry.log_id)) throw bad();
    ids.add(entry.log_id);
    const info = entry.info === null ? null : checkedRecoveryInfo(entry.info);
    if (info && info.log_id !== entry.log_id) throw bad();
    return { log_id: entry.log_id, info };
  });
}
export function sameRecoveryInfo(a: RecoveryInfo, b: RecoveryInfo) {
  return a.log_id === b.log_id && a.connection.connection_id === b.connection.connection_id && a.connection.generation === b.connection.generation && a.protocol === b.protocol && a.encoding === b.encoding && a.started_at_ms === b.started_at_ms && a.source_cursor === b.source_cursor && a.text_cursor === b.text_cursor && a.limits.segment_bytes === b.limits.segment_bytes && a.limits.segments === b.limits.segments && a.first_segment === b.first_segment && a.last_observed_segment === b.last_observed_segment && a.available_from === b.available_from && a.source_available_from === b.source_available_from && a.completion_present === b.completion_present && a.partial_present === b.partial_present;
}
export function checkedRecoveryPage(value: unknown, target: RecoveryScope, info: RecoveryInfo, cursor: number, source: number, flushed: boolean) {
  if (!object(value) || value.result !== 'recovery_page' || 'finished' in value || value.log_id !== target.log_id || value.read_id !== target.read_id || !object(value.connection) || value.connection.connection_id !== target.connection.connection_id || value.connection.generation !== target.connection.generation || value.cursor !== cursor || !integer(value.next_cursor) || value.available_from !== info.available_from || value.source_available_from !== info.source_available_from || !Array.isArray(value.records) || value.records.length > 64 || value.next_cursor !== cursor + value.records.length || (flushed && value.records.length)) throw bad();
  if (value.stop !== null) {
    if (!object(value.stop) || !Object.hasOwn(reasons, value.stop.kind as string) || !integer(value.stop.segment) || value.stop.segment < info.first_segment || value.stop.segment > info.last_observed_segment || value.stop.next_cursor !== value.next_cursor) throw bad();
  } else if (!value.records.length) throw bad();
  let bytes = 0;
  for (const [index, record] of value.records.entries()) {
    if (!object(record) || !object(record.text)) throw bad();
    const text = record.text;
    if (text.seq !== cursor + index || !integer(text.timestamp_ms, 0) || typeof text.text !== 'string' || typeof text.decode_error !== 'boolean' || (text.gap_bytes !== null && !integer(text.gap_bytes)) || new TextEncoder().encode(text.text).length > 16384) throw bad();
    bytes += new TextEncoder().encode(text.text).length + 256;
    if (record.raw === null) {
      if (text.source_seq !== null || text.gap_bytes !== null || index !== value.records.length - 1 || flushed) throw bad();
      flushed = true;
    } else {
      const raw = record.raw;
      if (!object(raw) || raw.seq !== source || text.source_seq !== source || raw.timestamp_ms !== text.timestamp_ms || (raw.gap_bytes ?? null) !== text.gap_bytes || !Array.isArray(raw.bytes) || raw.bytes.length > 4096 || raw.bytes.some(byte => !integer(byte, 0) || byte > 255) || (text.gap_bytes === null ? raw.bytes.length === 0 : raw.bytes.length !== 0 || text.text !== '' || text.decode_error)) throw bad();
      source++;
      if (!integer(source)) throw bad();
      bytes += raw.bytes.length;
    }
  }
  if (bytes > 32768) throw bad();
  return { page: value as unknown as RecoveryPage, source, flushed };
}
export function recoveryStopText(stop: RecoveryStop) {
  return `${reasons[stop.kind]} · 分段 ${stop.segment} · 下一文本游标 ${stop.next_cursor}；仅恢复已验证前缀，不代表日志完整或已同步。`;
}
