import type { Connection, ConnectionRef } from './ssh-api';

export type Action = 'READ' | 'WRITE' | 'EXEC' | 'CONTROL' | 'CONNECT' | 'DISCONNECT' | 'BROADCAST';
export type Scope = { target: { kind: 'connection'; connection: ConnectionRef } | { kind: 'profile'; profile_id: string }; action: Action };
export type Summary = { request_id: string; ticket_id: string; expires_at_ms: number; state: 'ACTIVE' | 'EXPIRED' | 'REVOKED'; effective_scope_count: number };
export type GrantView = { summary: Summary; approved_scopes: Scope[]; effective_scopes: Scope[] };
export type Slot = { service_id: string; request_id: string };
export type Lease = { lease_id: string; client_id: string; connection: ConnectionRef; expires_at_ms: number };
export type AuditEvent = { seq: number; timestamp_ms: number; kind: string; client_id: string | null; scope: Scope | null; request_id: string | null; denial: string | null };
export type AuditPage = { events: AuditEvent[]; available_from: number; next_cursor: number; gap: boolean };
export const slotKey = 'shared-terminal-agent-grant';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every(k => k in v);
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
export const sameConnection = (a: ConnectionRef, b: ConnectionRef) => a.connection_id === b.connection_id && a.generation === b.generation;
const connection = (v: unknown): v is ConnectionRef => exact(v, ['connection_id', 'generation']) && uuid(v.connection_id) && integer(v.generation, 1);
const actions: Action[] = ['READ', 'WRITE', 'EXEC', 'CONTROL', 'CONNECT', 'DISCONNECT', 'BROADCAST'];
const fail = () => new Error('授权管理响应不匹配；未接受范围或恢复批准。');
function checkedScope(v: unknown): Scope {
  if (!exact(v, ['target', 'action']) || !actions.includes(v.action as Action) || !object(v.target)) throw fail();
  if (v.target.kind === 'connection') {
    if (!exact(v.target, ['kind', 'connection']) || !connection(v.target.connection) || v.action === 'CONNECT') throw fail();
  } else if (v.target.kind !== 'profile' || !exact(v.target, ['kind', 'profile_id']) || !uuid(v.target.profile_id) || v.action !== 'CONNECT') throw fail();
  return v as Scope;
}
const scopeKey = (s: Scope) => s.target.kind === 'profile' ? `p:${s.target.profile_id}:${s.action}` : `c:${s.target.connection.connection_id}:${s.target.connection.generation}:${s.action}`;
function checkedSummary(v: unknown): Summary {
  if (!exact(v, ['request_id', 'ticket_id', 'expires_at_ms', 'state', 'effective_scope_count']) || !uuid(v.request_id) || !uuid(v.ticket_id) || !integer(v.expires_at_ms, 1) || !['ACTIVE', 'EXPIRED', 'REVOKED'].includes(v.state as string) || !integer(v.effective_scope_count) || v.effective_scope_count > 64 || (v.state !== 'ACTIVE' && v.effective_scope_count !== 0)) throw fail();
  return v as Summary;
}
function data(value: unknown, type: string): unknown {
  if (!exact(value, ['type', 'data']) || value.type !== type) throw fail();
  return value.data;
}
export function checkedGrant(value: unknown, request_id: string): GrantView {
  const view = data(value, 'grant');
  if (!exact(view, ['summary', 'approved_scopes', 'effective_scopes'])) throw fail();
  const summary = checkedSummary(view.summary);
  if (summary.request_id !== request_id || !Array.isArray(view.approved_scopes) || !view.approved_scopes.length || view.approved_scopes.length > 64 || !Array.isArray(view.effective_scopes) || view.effective_scopes.length !== summary.effective_scope_count) throw fail();
  const approved = view.approved_scopes.map(checkedScope), effective = view.effective_scopes.map(checkedScope);
  const keys = new Set(approved.map(scopeKey));
  if (keys.size !== approved.length || new Set(effective.map(scopeKey)).size !== effective.length || effective.some(s => !keys.has(scopeKey(s)))) throw fail();
  return view as GrantView;
}
export function checkedList(value: unknown): Summary[] {
  const list = data(value, 'grant_list');
  if (!Array.isArray(list) || list.length > 128) throw fail();
  const result = list.map(checkedSummary);
  if (new Set(result.map(s => s.request_id)).size !== result.length || new Set(result.map(s => s.ticket_id)).size !== result.length) throw fail();
  return result;
}
export function checkedLease(value: unknown, target: ConnectionRef): Lease | null {
  const lease = data(value, 'lease');
  if (lease === null) return null;
  if (!exact(lease, ['lease_id', 'client_id', 'connection', 'expires_at_ms']) || !uuid(lease.lease_id) || !uuid(lease.client_id) || !connection(lease.connection) || !sameConnection(lease.connection, target) || !integer(lease.expires_at_ms, 1)) throw fail();
  return lease as Lease;
}
export function checkedAudit(value: unknown, cursor: number): AuditPage {
  const page = data(value, 'audit');
  if (!exact(page, ['events', 'available_from', 'next_cursor', 'gap']) || !Array.isArray(page.events) || page.events.length > 128 || !integer(page.available_from) || !integer(page.next_cursor) || page.next_cursor < Math.max(cursor, page.available_from) || page.gap !== (cursor < page.available_from)) throw fail();
  let previous = Math.max(cursor, page.available_from);
  for (const e of page.events) {
    if (!exact(e, ['seq', 'timestamp_ms', 'kind', 'client_id', 'scope', 'request_id', 'denial']) || !integer(e.seq, 1) || e.seq !== previous + 1 || !integer(e.timestamp_ms) || !['GRANTED', 'REVOKED', 'LEASE_ACQUIRED', 'LEASE_RELEASED', 'TAKEOVER', 'ADMITTED', 'DISPATCHED', 'DENIED', 'GENERATION_RETIRED'].includes(e.kind as string) || (e.client_id !== null && !uuid(e.client_id)) || (e.request_id !== null && !uuid(e.request_id)) || (e.denial !== null && !['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'INPUT_BUSY', 'CAPACITY_EXCEEDED'].includes(e.denial as string))) throw fail();
    if (e.scope !== null) checkedScope(e.scope);
    previous = e.seq;
  }
  if (page.next_cursor !== previous) throw fail();
  return page as AuditPage;
}
export function restoreSlot(raw: string | null): Slot | undefined {
  if (!raw || raw.length > 200) return;
  try { const v: unknown = JSON.parse(raw); if (exact(v, ['service_id', 'request_id']) && uuid(v.service_id) && uuid(v.request_id)) return v as Slot; } catch { /* untrusted storage */ }
}
export function supportedActions(target: Connection): Action[] {
  if (target.state !== 'CONNECTED') return [];
  if (target.protocol === 'SSH2') return ['READ', 'WRITE', 'EXEC', 'CONTROL'];
  if (target.protocol === 'SERIAL') return ['READ', 'WRITE', 'CONTROL'];
  if (target.protocol === 'FIXTURE') return ['READ'];
  return [];
}
export type Proposal = { service_id: string; connection: ConnectionRef; protocol: string; scopes: Scope[]; lifetime_ms: number };
export class GrantApproval {
  private current?: Proposal;
  invalidate() { this.current = undefined; }
  prepare(service_id: string, target: Connection, selected: Action[], seconds: number): Proposal {
    this.invalidate();
    if (!uuid(service_id) || !connection({ connection_id: target.connection_id, generation: target.generation }) || !selected.length || new Set(selected).size !== selected.length || selected.some(a => !supportedActions(target).includes(a)) || !integer(seconds, 1) || seconds > 1800) throw new Error('请选择已连接的精确目标、独立能力及1–1800秒期限。');
    const ref = Object.freeze({ connection_id: target.connection_id, generation: target.generation });
    const scopes = selected.map(action => Object.freeze({ target: Object.freeze({ kind: 'connection' as const, connection: ref }), action }));
    Object.freeze(scopes);
    this.current = Object.freeze({ service_id, connection: ref, protocol: target.protocol, scopes, lifetime_ms: seconds * 1000 });
    return this.current;
  }
  consume(service_id: string, target: Connection | undefined, proposal: Proposal): Proposal {
    const valid = this.current === proposal && service_id === proposal.service_id && !!target && sameConnection(target, proposal.connection) && target.protocol === proposal.protocol && target.state === 'CONNECTED';
    this.invalidate();
    if (!valid) throw new Error('预览已失效；未签发授权，请重新核对。');
    return proposal;
  }
}
export const actionName: Record<Action, string> = { READ: '读取终端', WRITE: '写入终端', EXEC: '独立 exec', CONTROL: '协议控制（SSH尺寸/串口控制线）', CONNECT: '建立配置连接', DISCONNECT: '断开连接', BROADCAST: '广播' };
export function scopeText(scope: Scope): string { return `${actionName[scope.action]} · ${scope.target.kind === 'profile' ? `配置 ${scope.target.profile_id}` : `${scope.target.connection.connection_id} / 代次 ${scope.target.connection.generation}`}`; }
