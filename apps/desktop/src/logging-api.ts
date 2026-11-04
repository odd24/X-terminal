import { invoke } from '@tauri-apps/api/core';
import type { ConnectionRef } from './ssh-api';
export type LogInfo = { log_id: string; connection: ConnectionRef; protocol: string; encoding: string; started_at_ms: number; source_cursor: number; text_cursor: number; limits: { segment_bytes: number; segments: number }; phase: 'OPENING' | 'RECORDING' | 'STOPPING' | 'STOPPED' | 'FAILED'; failure: string | null; active: boolean; accepted_records: number; written_records: number; accepted_raw_bytes: number; written_raw_bytes: number; rejected_records: number; rejected_raw_bytes: number; source_gap_bytes: number; first_retained_segment: number; last_segment: number; retired_segments: number; natural_end: boolean; durable: boolean; worker_finished: boolean };
export type ArchiveInfo = Pick<LogInfo, 'log_id' | 'connection' | 'protocol' | 'encoding' | 'started_at_ms' | 'source_cursor' | 'text_cursor' | 'limits' | 'first_retained_segment' | 'last_segment' | 'written_records' | 'written_raw_bytes' | 'natural_end'> & { available_from: number; source_available_from: number; source_gap_bytes: number | null };
export type HistoryEntry = { log_id: string; state: 'HEADER_CHECKED' | 'UNFINISHED' | 'INVALID' | 'UNAVAILABLE'; info: ArchiveInfo | null };
export type HistoryRecord = { raw: { seq: number; timestamp_ms: number; bytes: number[]; gap_bytes?: number } | null; text: { seq: number; source_seq: number | null; timestamp_ms: number; text: string; decode_error: boolean; gap_bytes: number | null } };
export type HistoryPage = { connection: ConnectionRef; log_id: string; read_id: string; cursor: number; next_cursor: number; available_from: number; source_available_from: number; finished: boolean; records: HistoryRecord[] };
type HistoryScope = { connection: ConnectionRef; log_id: string; read_id: string };
type Request = { op: 'start'; connection: ConnectionRef; request_id: string; limits: LogInfo['limits'] } | { op: 'list'; connection: ConnectionRef } | { op: 'status' | 'stop'; connection: ConnectionRef; log_id: string } | { op: 'history_list' } | ({ op: 'history_open' | 'history_close' } & HistoryScope) | ({ op: 'history_read'; cursor: number; max_records: number; max_bytes: number } & HistoryScope);
type Reply = ({ result: 'info' } & LogInfo) | { result: 'list'; logs: LogInfo[] } | { result: 'history_list'; logs: HistoryEntry[] } | { result: 'history_opened'; read_id: string; info: ArchiveInfo } | ({ result: 'history_page' } & HistoryPage) | { result: 'history_closed'; read_id: string };
export async function logging(request: Request): Promise<Reply> {
  try { return await invoke<Reply>('logging_request', { request }); }
  catch (error) {
    if (request.op.startsWith('history_')) {
      const messages: Record<string, string> = { InvalidArgument: '历史日志目标或游标参数不匹配；操作没有转向其他日志。', InvalidState: '日志文件未完成、已损坏、被占用或目录不可访问；不能确认范围完整。', RequestExpired: '读取句柄或游标已过期；需要明确重新打开日志。', NotFound: '日志或读取句柄已不存在。', CapacityExceeded: '日志读取队列或句柄已达上限；可关闭其他历史读取后重试。', PermissionDenied: '当前客户端无持久日志读取权限。', LOG_CHANNEL_UNAVAILABLE: '历史日志通道不可用；未自动重开或重试。' };
      throw new Error(messages[String(error)] ?? '历史日志请求失败，未自动重新读取。');
    }
    const messages: Record<string, string> = { InvalidArgument: '日志参数无效或请求 ID 冲突，未启动新记录。', InvalidState: '连接已有日志，或配置/日志目录不可用；未自动恢复记录。', NotConnected: '当前连接尚未就绪，未开始记录。', StaleGeneration: '连接代次已变化，操作未转发到新连接。', NotFound: '该日志与目标连接不匹配或已不存在。', CapacityExceeded: '日志目录或服务记录已达上限；未删除历史，未开始新记录。', PermissionDenied: '当前客户端无日志管理权限。', LOG_CHANNEL_UNAVAILABLE: '日志通道不可用；结果可能未知，未自动重试。' };
    throw new Error(messages[String(error)] ?? '日志请求失败，未自动重试或重放。');
  }
}
