import type { ExportInfo, ExportScope } from './logging-api';

const phases = ['QUEUED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'CANCELLED', 'FAILED'];
const failures = ['INVALID_SOURCE', 'CAPACITY', 'TOO_LARGE', 'STORAGE', 'WORKER_FAILED'];
const counters = ['bytes', 'retained_records', 'retained_raw_bytes', 'retained_gap_bytes', 'next_cursor'] as const;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function restoreExport(value: string | null): ExportScope | undefined {
  if (!value || value.length > 2048) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!object(parsed) || !object(parsed.connection) || !uuid(parsed.log_id) || !uuid(parsed.request_id) || !uuid(parsed.connection.connection_id) || !Number.isSafeInteger(parsed.connection.generation) || (parsed.connection.generation as number) < 1) return;
    return { log_id: parsed.log_id, request_id: parsed.request_id, connection: { connection_id: parsed.connection.connection_id, generation: parsed.connection.generation as number } };
  } catch { return; }
}

export function terminalExport(info: ExportInfo) { return ['COMPLETED', 'CANCELLED', 'FAILED'].includes(info.phase); }

// Never display a path or success counters for a mismatched/unsafe reply. A
// completed source declaration cannot stand in for a completed export job.
export function checkedExport(value: unknown, target: ExportScope): ExportInfo {
  const invalid = () => new Error('导出响应目标、状态或计数不匹配；未接受成功结果。');
  if (!object(value) || value.result !== 'export' || value.log_id !== target.log_id || value.request_id !== target.request_id || !object(value.connection) || value.connection.connection_id !== target.connection.connection_id || value.connection.generation !== target.connection.generation || !phases.includes(value.phase as string)) throw invalid();
  if (value.phase === 'FAILED' ? !failures.includes(value.failure as string) : value.failure !== null) throw invalid();
  for (const key of counters) {
    if (value.phase === 'COMPLETED' ? !Number.isSafeInteger(value[key]) || (value[key] as number) < 0 : value[key] !== null) throw invalid();
  }
  if (value.phase === 'COMPLETED' && ((value.bytes as number) < 1 || (value.bytes as number) > 256 * 1024 * 1024 || (value.next_cursor as number) < 1)) throw invalid();
  return value as unknown as ExportInfo;
}
