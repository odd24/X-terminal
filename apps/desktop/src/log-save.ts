import type { ExportScope } from './logging-api';
import { restoreExport } from './log-export.ts';
export type SaveScope = { scope: ExportScope; save_id: string };
export type SaveInfo = SaveScope & { phase: 'CHOOSING' | 'AWAITING_CONFIRMATION' | 'COPYING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'RECOVERY_REQUIRED'; cancel_requested: boolean; path: string | null; existing_bytes: string | null; confirmation: string | null; expires_at_ms: number | null; backup: string | null; staging: string | null; failure: string | null; os_code: number | null };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function restoreSave(raw: string | null): SaveScope | undefined {
  if (!raw || raw.length > 4096) return;
  try { const value: unknown = JSON.parse(raw); if (!object(value) || !uuid(value.save_id)) return; const scope = restoreExport(JSON.stringify(value.scope)); if (scope) return { scope, save_id: value.save_id }; } catch { /* no implicit authorization from local storage */ }
}
export function terminalSave(info: SaveInfo) { return !['CHOOSING', 'AWAITING_CONFIRMATION', 'COPYING'].includes(info.phase); }
export function checkedSave(value: unknown, target: SaveScope, previous?: SaveInfo): SaveInfo {
  const invalid = () => new Error('另存响应范围或状态不匹配，请查询原任务；未重新保存。');
  if (!object(value) || !object(value.scope) || !object(value.scope.connection) || value.save_id !== target.save_id || value.scope.log_id !== target.scope.log_id || value.scope.request_id !== target.scope.request_id || value.scope.connection.connection_id !== target.scope.connection.connection_id || value.scope.connection.generation !== target.scope.connection.generation || !['CHOOSING', 'AWAITING_CONFIRMATION', 'COPYING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'RECOVERY_REQUIRED'].includes(value.phase as string) || typeof value.cancel_requested !== 'boolean') throw invalid();
  for (const key of ['path', 'backup', 'staging']) if (value[key] !== null && (typeof value[key] !== 'string' || !(value[key] as string).length || (value[key] as string).length > 32768 || (value[key] as string).includes('\0'))) throw invalid();
  if (['AWAITING_CONFIRMATION', 'COPYING', 'COMPLETED', 'EXPIRED', 'RECOVERY_REQUIRED'].includes(value.phase as string) && value.path === null) throw invalid();
  if (value.existing_bytes !== null && (typeof value.existing_bytes !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value.existing_bytes) || BigInt(value.existing_bytes) > 18446744073709551615n)) throw invalid();
  if (value.phase === 'AWAITING_CONFIRMATION' ? !uuid(value.confirmation) || value.existing_bytes === null || !Number.isSafeInteger(value.expires_at_ms) || (value.expires_at_ms as number) < 1 || (value.expires_at_ms as number) > 8640000000000000 : value.confirmation !== null || value.expires_at_ms !== null) throw invalid();
  if (value.failure !== null && (typeof value.failure !== 'string' || !/^[A-Z_]{1,40}$/.test(value.failure))) throw invalid();
  if (value.os_code !== null && (!Number.isInteger(value.os_code) || (value.os_code as number) < -2147483648 || (value.os_code as number) > 2147483647)) throw invalid();
  if (value.phase === 'COMPLETED' && (value.failure !== null || value.os_code !== null || value.staging !== null)) throw invalid();
  if (value.phase === 'RECOVERY_REQUIRED' && (value.backup === null || value.failure === null)) throw invalid();
  if (previous && ((previous.path !== null && previous.path !== value.path) || (previous.existing_bytes !== null && previous.existing_bytes !== value.existing_bytes) || (previous.phase === 'AWAITING_CONFIRMATION' && value.phase === 'AWAITING_CONFIRMATION' && (previous.confirmation !== value.confirmation || previous.expires_at_ms !== value.expires_at_ms)) || (terminalSave(previous) && (previous.phase !== value.phase || previous.backup !== value.backup || previous.staging !== value.staging || previous.failure !== value.failure || previous.os_code !== value.os_code)))) throw invalid();
  return value as unknown as SaveInfo;
}
