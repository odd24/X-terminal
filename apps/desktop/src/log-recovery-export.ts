import type { ExportInfo, ExportScope } from './logging-api';
import type { RecoveryStop } from './log-recovery';
import { checkedExport, restoreExport } from './log-export.ts';

export type RecoveryExportSummary = { recovered_records: number; recovered_raw_bytes: number; recovered_gap_bytes: number; next_cursor: number; stop: RecoveryStop };
export type RecoveryExportInfo = ExportScope & Pick<ExportInfo, 'phase' | 'failure' | 'bytes' | 'sha256'> & { incomplete: true; recovered: RecoveryExportSummary | null };
export type RecoveryExportRequest = { op: 'recovery_export_start' | 'recovery_export_status' | 'recovery_export_cancel' } & ExportScope;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const stops = ['END_OF_AVAILABLE', 'MISSING_PARTNER', 'MISSING_SEGMENT', 'INVALID_HEADER', 'DISCONTINUITY', 'TRUNCATED_RECORD', 'INVALID_RECORD', 'STORAGE'];

// A separate slot and explicit mode prevent a restored ID from selecting the
// ordinary export API. Local storage never supplies a result or permission.
export function restoreRecoveryExport(raw: string | null): ExportScope | undefined {
  if (!raw || raw.length > 2048) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.mode !== 'RECOVERY') return;
    return restoreExport(JSON.stringify(value));
  } catch { return; }
}

export function checkedRecoveryExport(value: unknown, target: ExportScope): RecoveryExportInfo {
  const invalid = () => new Error('恢复导出响应的模式、目标或停止报告不匹配；未接受产物。');
  if (!object(value) || value.result !== 'recovery_export' || value.incomplete !== true || ['retained_records', 'retained_raw_bytes', 'retained_gap_bytes', 'next_cursor'].some(key => key in value)) throw invalid();
  const done = value.phase === 'COMPLETED';
  let summary: RecoveryExportSummary | null = null;
  if (done) {
    const recovered = value.recovered;
    if (!object(recovered) || !integer(recovered.recovered_records) || !integer(recovered.recovered_raw_bytes) || !integer(recovered.recovered_gap_bytes) || !integer(recovered.next_cursor, 1) || !object(recovered.stop) || !stops.includes(recovered.stop.kind as string) || !integer(recovered.stop.segment, 1) || recovered.stop.next_cursor !== recovered.next_cursor || recovered.recovered_records >= recovered.next_cursor) throw invalid();
    summary = recovered as unknown as RecoveryExportSummary;
  } else if (value.recovered !== null) throw invalid();
  // Reuse the ordinary scope/phase/failure/fingerprint checks without ever
  // returning its completion declaration to callers.
  checkedExport({ ...value, result: 'export', retained_records: summary?.recovered_records ?? null, retained_raw_bytes: summary?.recovered_raw_bytes ?? null, retained_gap_bytes: summary?.recovered_gap_bytes ?? null, next_cursor: summary?.next_cursor ?? null }, target);
  return value as unknown as RecoveryExportInfo;
}
