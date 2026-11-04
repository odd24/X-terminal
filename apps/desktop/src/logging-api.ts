import { invoke } from '@tauri-apps/api/core';
import type { ConnectionRef } from './ssh-api';
export type LogInfo = { log_id: string; connection: ConnectionRef; protocol: string; encoding: string; started_at_ms: number; source_cursor: number; text_cursor: number; limits: { segment_bytes: number; segments: number }; phase: 'OPENING' | 'RECORDING' | 'STOPPING' | 'STOPPED' | 'FAILED'; failure: string | null; active: boolean; accepted_records: number; written_records: number; accepted_raw_bytes: number; written_raw_bytes: number; rejected_records: number; rejected_raw_bytes: number; source_gap_bytes: number; first_retained_segment: number; last_segment: number; retired_segments: number; natural_end: boolean; durable: boolean; worker_finished: boolean };
type Request = { op: 'start'; connection: ConnectionRef; request_id: string; limits: LogInfo['limits'] } | { op: 'list'; connection: ConnectionRef } | { op: 'status' | 'stop'; connection: ConnectionRef; log_id: string };
type Reply = ({ result: 'info' } & LogInfo) | { result: 'list'; logs: LogInfo[] };
export async function logging(request: Request): Promise<Reply> {
  try { return await invoke<Reply>('logging_request', { request }); }
  catch (error) {
    const messages: Record<string, string> = { InvalidArgument: '日志参数无效或请求 ID 冲突，未启动新记录。', InvalidState: '连接已有日志，或配置/日志目录不可用；未自动恢复记录。', NotConnected: '当前连接尚未就绪，未开始记录。', StaleGeneration: '连接代次已变化，操作未转发到新连接。', NotFound: '该日志与目标连接不匹配或已不存在。', CapacityExceeded: '日志目录或服务记录已达上限；未删除历史，未开始新记录。', PermissionDenied: '当前客户端无日志管理权限。', LOG_CHANNEL_UNAVAILABLE: '日志通道不可用；结果可能未知，未自动重试。' };
    throw new Error(messages[String(error)] ?? '日志请求失败，未自动重试或重放。');
  }
}
