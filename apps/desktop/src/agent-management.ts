import type { Connection, ConnectionRef } from './ssh-api';
import { checkedRedaction, checkedProtectionReply, sameRedaction, type Redaction, type ProtectionInfo } from './output-protection.ts';

export type Action = 'READ' | 'WRITE' | 'EXEC' | 'CONTROL' | 'CONNECT' | 'DISCONNECT' | 'RECONNECT' | 'FORGET' | 'BROADCAST' | 'EXPORT';
export type ReadWindow = { from_ms: number; until_ms: number };
export type Scope = { target: { kind: 'connection'; connection: ConnectionRef } | { kind: 'output_window'; connection: ConnectionRef; window: ReadWindow } | { kind: 'profile'; profile_id: string } | { kind: 'profile_revision'; profile_id: string; revision: string }; action: Action };
export type Summary = { request_id: string; ticket_id: string; expires_at_ms: number; state: 'ACTIVE' | 'EXPIRED' | 'REVOKED'; effective_scope_count: number };
export type TaskContext = { task_id: string; label: string };
export type GrantForm = ({ kind: 'timed_task' } & TaskContext) | { kind: 'single_operation'; operation: { request_id: string; fingerprint: string } };
export type GrantView = { summary: Summary; approved_scopes: Scope[]; effective_scopes: Scope[]; form?: GrantForm; protection?: ProtectionInfo };
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
const actions: Action[] = ['READ', 'WRITE', 'EXEC', 'CONTROL', 'CONNECT', 'DISCONNECT', 'RECONNECT', 'FORGET', 'BROADCAST', 'EXPORT'];
const validWindow = (v: unknown): v is ReadWindow => exact(v, ['from_ms', 'until_ms']) && integer(v.from_ms) && integer(v.until_ms, 1) && v.until_ms <= 253402300799999 && v.from_ms < v.until_ms;
export function parseReadWindow(from: string, until: string): ReadWindow {
  const parse = (input: string) => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(input);
    if (!match) return NaN;
    const normalized = `${match[1]}:${match[2] ?? '00'}.${(match[3] ?? '').padEnd(3, '0')}`;
    const ms = Date.parse(`${normalized}+08:00`);
    if (!Number.isFinite(ms) || new Date(ms + 8 * 3600000).toISOString().slice(0, 23) !== normalized) return NaN;
    return ms;
  };
  const window = { from_ms: parse(from), until_ms: parse(until) };
  if (!validWindow(window)) throw new Error('请填写有效北京时间（UTC+08）起止时间，结束必须晚于开始；不自动补范围。');
  return window;
}
const fail = () => new Error('授权管理响应不匹配；未接受范围或恢复批准。');
export function checkedTask(task: TaskContext): TaskContext {
  if (!exact(task, ['task_id', 'label']) || !uuid(task.task_id) || typeof task.label !== 'string' || !task.label.length || task.label.trim() !== task.label || new TextEncoder().encode(task.label).length > 256 || /[\p{Cc}]/u.test(task.label)) throw new Error('请填写1–256 UTF-8字节的任务说明，不含首尾空白或控制字符。');
  return Object.freeze({ task_id: task.task_id, label: task.label });
}
export const sameTask = (a?: TaskContext, b?: TaskContext) => a?.task_id === b?.task_id && a?.label === b?.label;
export function grantRequest(request_id: string, proposal: { scopes: Scope[]; lifetime_ms: number; task?: TaskContext; redaction?: Redaction }) {
  if (proposal.redaction) return { op: 'grant_protected', request_id, scopes: proposal.scopes, lifetime_ms: proposal.lifetime_ms, form: proposal.task ? { kind: 'timed_task', ...proposal.task } : { kind: 'scoped' }, redaction: proposal.redaction };
  return proposal.task ? { op: 'grant_task', request_id, scopes: proposal.scopes, lifetime_ms: proposal.lifetime_ms, ...proposal.task } : { op: 'grant', request_id, scopes: proposal.scopes, lifetime_ms: proposal.lifetime_ms };
}
export function checkedTaskReply(view: GrantView, task?: TaskContext, approved?: Scope[], redaction?: Redaction): GrantView {
  if (task ? view.form?.kind !== 'timed_task' || !sameTask(view.form, task) : view.form !== undefined) throw fail();
  if (approved && (approved.length !== view.approved_scopes.length || view.approved_scopes.some(scope => !approved.some(original => scopeKey(scope) === scopeKey(original))))) throw fail();
  return checkedProtectionReply(view, redaction);
}
function checkedScope(v: unknown): Scope {
  if (!exact(v, ['target', 'action']) || !actions.includes(v.action as Action) || !object(v.target)) throw fail();
  if (v.target.kind === 'output_window') {
    if (!exact(v.target, ['kind', 'connection', 'window']) || !connection(v.target.connection) || !validWindow(v.target.window) || v.action !== 'READ') throw fail();
  } else if (v.target.kind === 'connection') {
    if (!exact(v.target, ['kind', 'connection']) || !connection(v.target.connection) || v.action === 'CONNECT') throw fail();
  } else if (v.target.kind === 'profile_revision') {
    if (!exact(v.target, ['kind', 'profile_id', 'revision']) || !uuid(v.target.profile_id) || !uuid(v.target.revision) || v.action !== 'CONNECT') throw fail();
  } else if (v.target.kind !== 'profile' || !exact(v.target, ['kind', 'profile_id']) || !uuid(v.target.profile_id) || v.action !== 'CONNECT') throw fail();
  return v as Scope;
}
const scopeKey = (s: Scope) => s.target.kind === 'profile' || s.target.kind === 'profile_revision' ? `p:${s.target.profile_id}:${s.target.kind === 'profile_revision' ? s.target.revision : 'id'}:${s.action}` : `c:${s.target.connection.connection_id}:${s.target.connection.generation}:${s.action}:${s.target.kind === 'output_window' ? `${s.target.window.from_ms}:${s.target.window.until_ms}` : 'full'}`;
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
  if (!object(view) || !exact(view, ['summary', 'approved_scopes', 'effective_scopes', ...('form' in view ? ['form'] : []), ...('protection' in view ? ['protection'] : [])])) throw fail();
  const summary = checkedSummary(view.summary);
  if (summary.request_id !== request_id || !Array.isArray(view.approved_scopes) || !view.approved_scopes.length || view.approved_scopes.length > 64 || !Array.isArray(view.effective_scopes) || view.effective_scopes.length !== summary.effective_scope_count) throw fail();
  const approved = view.approved_scopes.map(checkedScope), effective = view.effective_scopes.map(checkedScope);
  const keys = new Set(approved.map(scopeKey));
  if (keys.size !== approved.length || new Set(effective.map(scopeKey)).size !== effective.length || effective.some(s => !keys.has(scopeKey(s)))) throw fail();
  if ('protection' in view) {
    const p = view.protection;
    if (!exact(p, ['policy_id', 'sensitive_fields', 'literal_count']) || !uuid(p.policy_id) || typeof p.sensitive_fields !== 'boolean' || !integer(p.literal_count) || p.literal_count > 32 || (!p.sensitive_fields && !p.literal_count) || !approved.some(s => ['READ', 'EXEC', 'EXPORT'].includes(s.action))) throw fail();
  }
  if ('form' in view) {
    const form = view.form;
    if (!object(form)) throw fail();
    if (form.kind === 'timed_task') {
      if (!exact(form, ['kind', 'task_id', 'label'])) throw fail();
      checkedTask({ task_id: form.task_id as string, label: form.label as string });
    } else if (form.kind === 'single_operation') {
      if (!exact(form, ['kind', 'operation']) || !exact(form.operation, ['request_id', 'fingerprint']) || !uuid(form.operation.request_id) || typeof form.operation.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(form.operation.fingerprint) || approved.length > 2 || approved.some(s => !['WRITE', 'EXEC', 'CONTROL', 'CONNECT', 'DISCONNECT', 'RECONNECT', 'FORGET', 'EXPORT'].includes(s.action) || s.target.kind === 'profile' || s.target.kind === 'output_window') || (approved.length === 1 && approved[0].action === 'RECONNECT') || (approved.length === 2 && (approved.filter(s => s.action === 'RECONNECT').length !== 1 || approved.filter(s => s.action === 'CONNECT').length !== 1))) throw fail();
    } else throw fail();
  }
  if (approved.some(s => s.action === 'EXPORT') && (approved.length !== 1 || !('protection' in view) || (view as GrantView).form?.kind !== 'single_operation')) throw fail();
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
  if (['DISCONNECTED', 'FAILED'].includes(target.state) && ['SSH2', 'SERIAL'].includes(target.protocol)) return ['READ', 'FORGET'];
  if (target.state !== 'CONNECTED') return [];
  if (target.protocol === 'SSH2') return ['READ', 'WRITE', 'EXEC', 'CONTROL', 'DISCONNECT'];
  if (target.protocol === 'SERIAL') return ['READ', 'WRITE', 'CONTROL', 'DISCONNECT'];
  if (target.protocol === 'FIXTURE') return ['READ'];
  return [];
}
export type Proposal = { service_id: string; connection: ConnectionRef; protocol: string; state: string; scopes: Scope[]; lifetime_ms: number; task?: TaskContext; redaction?: Redaction };
export class GrantApproval {
  private current?: Proposal;
  invalidate() { this.current = undefined; }
  prepare(service_id: string, target: Connection, selected: Action[], seconds: number, window?: ReadWindow, task?: TaskContext, redaction?: Redaction): Proposal {
    this.invalidate();
    if (!uuid(service_id) || !connection({ connection_id: target.connection_id, generation: target.generation }) || !selected.length || new Set(selected).size !== selected.length || selected.some(a => !supportedActions(target).includes(a)) || !integer(seconds, 1) || seconds > 1800) throw new Error('请选择状态匹配的精确目标、独立能力及1–1800秒期限。');
    if (window && (!validWindow(window) || !selected.includes('READ'))) throw new Error('时间窗仅适用于独立Read范围。');
    if (redaction && !selected.some(a => a === 'READ' || a === 'EXEC')) throw new Error('输出保护仅适用于Read或本人exec输出，不增加任何权限。');
    const ref = Object.freeze({ connection_id: target.connection_id, generation: target.generation });
    const scopes: Scope[] = selected.map(action => Object.freeze({ target: window && action === 'READ' ? Object.freeze({ kind: 'output_window' as const, connection: ref, window: Object.freeze({ ...window }) }) : Object.freeze({ kind: 'connection' as const, connection: ref }), action }));
    Object.freeze(scopes);
    this.current = Object.freeze({ service_id, connection: ref, protocol: target.protocol, state: target.state, scopes, lifetime_ms: seconds * 1000, ...(task ? { task: checkedTask(task) } : {}), ...(redaction ? { redaction: checkedRedaction(redaction) } : {}) });
    return this.current;
  }
  consume(service_id: string, target: Connection | undefined, proposal: Proposal, task?: TaskContext, redaction?: Redaction): Proposal {
    const valid = this.current === proposal && sameTask(task, proposal.task) && sameRedaction(redaction, proposal.redaction) && service_id === proposal.service_id && !!target && sameConnection(target, proposal.connection) && target.protocol === proposal.protocol && target.state === proposal.state && proposal.scopes.every(scope => supportedActions(target).includes(scope.action));
    this.invalidate();
    if (!valid) throw new Error('预览已失效；未签发授权，请重新核对。');
    return proposal;
  }
}
export const actionName: Record<Action, string> = { READ: '读取终端', WRITE: '写入终端', EXEC: '独立 exec', CONTROL: '协议控制（SSH尺寸/串口控制线）', CONNECT: '建立配置连接', DISCONNECT: '断开连接', RECONNECT: '重连旧SSH代次（另需配置建连批准）', FORGET: '移除已回收连接记录', BROADCAST: '广播', EXPORT: '导出已结束会话的保护文本' };
export function scopeText(scope: Scope): string {
  const target = scope.target;
  if (target.kind === 'profile' || target.kind === 'profile_revision') return `${actionName[scope.action]} · 配置 ${target.profile_id} / ${target.kind === 'profile_revision' ? `配置版本 ${target.revision}` : '仅ID范围（不固定配置）'}`;
  const fixed = `${actionName[scope.action]} · ${target.connection.connection_id} / 代次 ${target.connection.generation}`;
  if (target.kind === 'connection') return `${fixed}${scope.action === 'READ' ? ' · 当前有界保留输出与授权期间后续输出（完整Read）' : ''}`;
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' });
  return `${fixed} · 北京时间 [${date.format(target.window.from_ms)}, ${date.format(target.window.until_ms)}) · 时间窗重建（不含窗外正文）`;
}
