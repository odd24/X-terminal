export type AuditStatus = { state: 'DISABLED' | 'HEALTHY' | 'QUEUE_FULL' | 'STORAGE_FAILURE' | 'CLOSED'; accepted_through: string; synced_through: string; rejected_records: string; incomplete_segments: string; available_from: string; retained_records: string };
export type AuditRow = { seq: string; service_id: string; category: 'RPC' | 'POLICY'; summary: string; metadata: string };
export type AuditInfo = { type: 'info'; service_id: string; status: AuditStatus };
export type AuditPage = { type: 'page'; service_id: string; status: AuditStatus; records: AuditRow[]; next_cursor: string; through_cursor: string; available_from: string; gap: boolean };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, list: string[]) => Object.keys(v).length === list.length && list.every(k => k in v);
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export function checkedHistory(value: unknown, serviceId: string, cursor?: string, through?: string): AuditInfo | AuditPage {
  if (!object(value) || value.service_id !== serviceId || !object(value.status)) throw new Error('审计来源不匹配');
  const status = value.status;
  const integers = ['accepted_through', 'synced_through', 'rejected_records', 'incomplete_segments', 'available_from', 'retained_records'];
  if (!keys(status, ['state', ...integers]) || !['DISABLED', 'HEALTHY', 'QUEUE_FULL', 'STORAGE_FAILURE', 'CLOSED'].includes(String(status.state)) || !integers.every(k => decimal(status[k])) || BigInt(String(status.synced_through)) > BigInt(String(status.accepted_through))) throw new Error('审计状态不匹配');
  if (cursor === undefined) {
    if (value.type !== 'info' || !keys(value, ['type', 'service_id', 'status'])) throw new Error('审计状态回复不匹配');
    return value as AuditInfo;
  }
  if (value.type !== 'page' || !keys(value, ['type', 'service_id', 'status', 'records', 'next_cursor', 'through_cursor', 'available_from', 'gap']) || !decimal(cursor) || !decimal(through) || !decimal(value.next_cursor) || !decimal(value.available_from) || value.through_cursor !== through || BigInt(value.next_cursor) < BigInt(cursor) || BigInt(value.next_cursor) > BigInt(through) || typeof value.gap !== 'boolean' || !Array.isArray(value.records) || value.records.length > 64) throw new Error('审计分页回复不匹配');
  let previous = BigInt(cursor);
  for (const row of value.records) {
    if (!object(row) || !keys(row, ['seq', 'service_id', 'category', 'summary', 'metadata']) || !decimal(row.seq) || BigInt(row.seq) <= previous || BigInt(row.seq) > BigInt(through) || !uuid(row.service_id) || !['RPC', 'POLICY'].includes(String(row.category)) || typeof row.summary !== 'string' || row.summary.length > 512 || typeof row.metadata !== 'string' || row.metadata.length > 16384) throw new Error('审计记录不匹配');
    previous = BigInt(row.seq);
  }
  if (value.records.length && previous !== BigInt(value.next_cursor)) throw new Error('审计游标不匹配');
  return value as AuditPage;
}
export function auditState(state: AuditStatus['state']) { return ({ DISABLED: '未启用持久记录', HEALTHY: '正在记录', QUEUE_FULL: '记录队列已满，新 Agent 动作已阻止', STORAGE_FAILURE: '存储故障，新 Agent 动作已阻止', CLOSED: '记录已停止' })[state]; }
