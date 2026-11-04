import type { CleanupInfo, CleanupKind, CleanupScope } from './logging-api';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function restoreCleanup(raw: string | null): CleanupScope | undefined {
  if (!raw || raw.length > 2048) return;
  try {
    const v: unknown = JSON.parse(raw);
    if (object(v) && (v.kind === 'LOG' || v.kind === 'EXPORT') && uuid(v.id) && uuid(v.preview_id)) return { kind: v.kind, id: v.id, preview_id: v.preview_id };
  } catch { /* Invalid saved scope cannot authorize an action. */ }
}
export function checkedCleanupList(v: unknown, kind: CleanupKind): string[] {
  if (!object(v) || v.result !== 'cleanup_list' || v.kind !== kind || !Array.isArray(v.ids) || v.ids.length > 64 || !v.ids.every(uuid) || new Set(v.ids).size !== v.ids.length) throw new Error('清理目录响应不匹配，未接受目标列表。');
  return v.ids;
}
function filename(name: unknown, kind: CleanupKind): boolean {
  if (typeof name !== 'string') return false;
  if (kind === 'EXPORT') return ['export.jsonl', 'export.partial'].includes(name);
  if (['completion.json', 'completion.partial'].includes(name)) return true;
  const match = /^(\d{16,20})(\.rawlog|\.text\.jsonl)$/.exec(name);
  if (!match) return false;
  const n = BigInt(match[1]);
  return n > 0n && n <= 18446744073709551615n && n.toString().padStart(16, '0') === match[1];
}
export function checkedCleanup(v: unknown, scope: CleanupScope, previous?: CleanupInfo): CleanupInfo {
  const invalid = () => new Error('清理回执的目标、文件清单或删除计数不匹配；保留编号，仅查询结果。');
  if (!object(v) || v.result !== 'cleanup' || v.kind !== scope.kind || v.id !== scope.id || v.preview_id !== scope.preview_id || !['PREVIEW', 'CANCELLED', 'EXPIRED', 'APPLIED'].includes(v.phase as string) || !count(v.expires_at_ms) || v.expires_at_ms < 1 || v.expires_at_ms > 8640000000000000 || !count(v.logical_bytes) || !Array.isArray(v.files) || v.files.length > (scope.kind === 'LOG' ? 34 : 2)) throw invalid();
  let total = 0; const names = new Set<string>(); const prefix = [0];
  for (const file of v.files) {
    if (!object(file) || !filename(file.name, scope.kind) || !count(file.bytes) || names.has(file.name as string)) throw invalid();
    names.add(file.name as string); total += file.bytes; prefix.push(total);
    if (!count(total)) throw invalid();
  }
  if (total !== v.logical_bytes || (v.phase === 'PREVIEW' ? !uuid(v.confirmation) : v.confirmation !== null)) throw invalid();
  if (v.phase === 'APPLIED') {
    const r = v.report;
    if (!object(r) || !count(r.removed_files) || r.removed_files > v.files.length || !count(r.removed_logical_bytes) || r.removed_logical_bytes !== prefix[r.removed_files] || typeof r.directory_removed !== 'boolean' || (r.failure !== null && r.failure !== 'CHANGED' && r.failure !== 'STORAGE') || !(r.os_code === null || (Number.isInteger(r.os_code) && (r.os_code as number) >= -2147483648 && (r.os_code as number) <= 2147483647))) throw invalid();
    if (r.failure === null ? !r.directory_removed || r.removed_files !== v.files.length || r.os_code !== null : r.directory_removed || (r.failure === 'CHANGED' && r.removed_files !== 0)) throw invalid();
  } else if (v.report !== null) throw invalid();
  if (previous && (previous.expires_at_ms !== v.expires_at_ms || JSON.stringify(previous.files) !== JSON.stringify(v.files) || previous.logical_bytes !== v.logical_bytes || (previous.phase === 'PREVIEW' && v.phase === 'PREVIEW' && previous.confirmation !== v.confirmation) || (previous.phase !== 'PREVIEW' && (previous.phase !== v.phase || JSON.stringify(previous.report) !== JSON.stringify(v.report))))) throw invalid();
  return v as unknown as CleanupInfo;
}
export function canCommitCleanup(info: CleanupInfo | undefined, reviewed: boolean, now: number) {
  return !!info && info.phase === 'PREVIEW' && !!info.confirmation && reviewed && now < info.expires_at_ms;
}
