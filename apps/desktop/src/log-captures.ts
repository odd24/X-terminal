import type { LogInfo } from './logging-api';
import type { ConnectionRef } from './ssh-api';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const capturePhases: Record<LogInfo['phase'], string> = { OPENING: '正在打开文件', RECORDING: '正在记录', STOPPING: '正在排空并同步', STOPPED: '记录已停止', FAILED: '记录失败', REMOVED: '文件已整理，计数为捕获历史', RELEASED: '失败记录关联已解除，文件未删除' };
const failures = ['QUEUE_FULL', 'DISK_FULL', 'STORAGE', 'INVALID_RECORD', 'COUNTER_EXHAUSTED', 'WORKER_PANICKED'];
const counters = ['started_at_ms', 'source_cursor', 'text_cursor', 'accepted_records', 'written_records', 'accepted_raw_bytes', 'written_raw_bytes', 'rejected_records', 'rejected_raw_bytes', 'source_gap_bytes', 'first_retained_segment', 'last_segment', 'retired_segments'] as const;
function checked(v: unknown): LogInfo {
  const invalid = () => new Error('捕获清单的目标、状态或计数无效，未接受维护目标。');
  if (!object(v) || !uuid(v.log_id) || !object(v.connection) || !uuid(v.connection.connection_id) || !count(v.connection.generation) || v.connection.generation < 1 || !['SSH1', 'SSH2', 'SERIAL', 'FIXTURE'].includes(v.protocol as string) || !['utf-8', 'gbk', 'gb18030'].includes(v.encoding as string) || !Object.hasOwn(capturePhases, v.phase as string) || (v.failure !== null && !failures.includes(v.failure as string))) throw invalid();
  if (!counters.every(key => count(v[key])) || (v.source_cursor as number) < 1 || (v.text_cursor as number) < 1 || (v.started_at_ms as number) > 8640000000000000 || !['active', 'durable', 'worker_finished', 'natural_end'].every(key => typeof v[key] === 'boolean') || !object(v.limits) || !count(v.limits.segment_bytes) || v.limits.segment_bytes < 131072 || v.limits.segment_bytes > 104857600 || !count(v.limits.segments) || v.limits.segments < 1 || v.limits.segments > 16) throw invalid();
  if (['FAILED', 'RELEASED'].includes(v.phase as string) && v.failure === null) throw invalid();
  if ((v.phase === 'RELEASED' || v.phase === 'REMOVED') && (v.active || v.durable)) throw invalid();
  if (v.phase === 'RELEASED' && !v.worker_finished) throw invalid();
  return v as unknown as LogInfo;
}
export function checkedCaptures(v: unknown, previous: LogInfo[] = []): LogInfo[] {
  if (!object(v) || v.result !== 'list' || !Array.isArray(v.logs) || v.logs.length > 64) throw new Error('捕获清单响应不匹配或超出上限。');
  const logs = v.logs.map(checked);
  if (new Set(logs.map(log => log.log_id)).size !== logs.length) throw new Error('捕获清单包含重复编号，未接受维护目标。');
  for (const log of logs) {
    const old = previous.find(item => item.log_id === log.log_id);
    if (old && (old.connection.connection_id !== log.connection.connection_id || old.connection.generation !== log.connection.generation)) throw new Error('捕获编号的原连接代次发生变化，未接受维护目标。');
  }
  return logs;
}
export function checkedCapture(v: unknown, connection: ConnectionRef, id: string): LogInfo {
  if (!object(v) || v.result !== 'info') throw new Error('维护响应类型不匹配。');
  const info = checked(v);
  if (info.log_id !== id || info.connection.connection_id !== connection.connection_id || info.connection.generation !== connection.generation) throw new Error('维护响应不是原固定目标，未接受结果。');
  return info;
}
