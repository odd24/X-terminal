import type { Connection, ConnectionRef } from './ssh-api';
import type { Profile } from './config-api';
import { profileDescription } from './profile-grant.ts';
import { uuid, type GrantView, type Scope, type Action } from './agent-management.ts';

export type SingleAction = 'start' | 'reconnect' | 'write' | 'write_text' | 'send' | 'exec' | 'resize' | 'control' | 'disconnect' | 'forget_start';
export type Draft = { action: '' | SingleAction; text: string; hex: string; cols: number; rows: number; timeout_ms: number; max_output_bytes: number; format: 'text' | 'hex'; ending: 'none' | 'cr' | 'lf' | 'cr_lf'; chunk_bytes: number; interval_ms: number; line: 'DTR' | 'RTS' | 'BREAK'; asserted: boolean };
export const emptyDraft = (): Draft => ({ action: '', text: '', hex: '', cols: 80, rows: 24, timeout_ms: 30000, max_output_bytes: 65536, format: 'text', ending: 'none', chunk_bytes: 1024, interval_ms: 0, line: 'DTR', asserted: false });
export type Operation = { protocol: 'SSH2' | 'SERIAL'; request: { op: SingleAction; request_id: string } & Record<string, unknown> };
export type OperationContext = { service_id: string; target?: Connection; original_profile_id?: string; encoding?: string; profile?: Profile; revision?: string; device?: { revision: string; device_id: string; port: string } };
export type OperationProposal = { context_key: string; draft_key: string; operation: Operation; scopes: Scope[]; lifetime_ms: number; description: [string, string][]; profile_id?: string; revision?: string };
export const singleName: Record<SingleAction, string> = { start: '按固定配置建连', reconnect: '重连旧SSH代次', write: '发送原始HEX字节', write_text: 'SSH文本输入', send: '串口文本或HEX发送', exec: '独立SSH exec', resize: '调整SSH尺寸', control: '串口控制线', disconnect: '断开固定代次', forget_start: '移除已回收记录' };
export function singleActions(target?: Connection): SingleAction[] {
  const result: SingleAction[] = ['start'];
  if (target?.state === 'CONNECTED') {
    if (target.protocol === 'SSH2') result.push('write_text', 'write', 'exec', 'resize', 'disconnect');
    if (target.protocol === 'SERIAL') result.push('send', 'write', 'control', 'disconnect');
  } else if (target && ['FAILED', 'DISCONNECTED'].includes(target.state)) {
    if (target.protocol === 'SSH2') result.push('reconnect', 'forget_start');
    if (target.protocol === 'SERIAL') result.push('forget_start');
  }
  return result;
}
const number = (v: number, min: number, max: number) => Number.isSafeInteger(v) && v >= min && v <= max;
const utf8 = (v: string) => new TextEncoder().encode(v).length;
export function hexBytes(text: string): number[] {
  const compact = text.replace(/[ \t\r\n]/g, '');
  if (!compact.length || compact.length % 2 || !/^[0-9a-f]+$/i.test(compact) || compact.length > 131072) throw new Error('HEX须为完整字节对，最多65536字节，仅允许空格/Tab/换行分隔。');
  return compact.match(/../g)!.map(byte => parseInt(byte, 16));
}
function contextKey(c: OperationContext, action: SingleAction | '') {
  return JSON.stringify([c.service_id, action === 'start' ? undefined : c.target, action === 'reconnect' ? c.original_profile_id : undefined, ['write_text', 'exec', 'send'].includes(action) ? c.encoding : undefined, ['start', 'reconnect'].includes(action) ? [c.revision, c.profile?.id, c.profile?.name, c.profile?.settings, c.device] : undefined]);
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
export class OperationApproval {
  private current?: OperationProposal;
  invalidate() { this.current = undefined; }
  prepare(c: OperationContext, draft: Draft, seconds: number, request_id: string): OperationProposal {
    this.invalidate();
    if (!uuid(c.service_id) || !uuid(request_id) || !number(seconds, 1, 1800) || !draft.action || !singleActions(c.target).includes(draft.action)) throw new Error('请选择当前状态支持的单次动作及1–1800秒期限。');
    const action = draft.action;
    let protocol: 'SSH2' | 'SERIAL';
    let connection: ConnectionRef | undefined;
    if (action === 'start') {
      if (!c.profile || !['ssh2', 'serial'].includes(c.profile.settings.protocol)) throw new Error('请显式选择固定版本的SSH2或串口配置。');
      protocol = c.profile.settings.protocol === 'ssh2' ? 'SSH2' : 'SERIAL';
    } else {
      if (!c.target || !uuid(c.target.connection_id) || !number(c.target.generation, 1, Number.MAX_SAFE_INTEGER) || !['SSH2', 'SERIAL'].includes(c.target.protocol)) throw new Error('当前连接代次无效。');
      protocol = c.target.protocol as 'SSH2' | 'SERIAL';
      connection = { connection_id: c.target.connection_id, generation: c.target.generation };
    }
    const description: [string, string][] = [['动作', singleName[action]], ['协议', protocol], ['原操作编号', request_id]];
    if (connection) description.push(['连接', `${connection.connection_id} / 代次 ${connection.generation}`]);
    if (['write_text', 'exec', 'send'].includes(action)) {
      if (!['utf8', 'gbk', 'gb18030'].includes(c.encoding ?? '')) throw new Error('请等待当前连接固定编码读取完成后再预览。');
      description.push(['连接固定编码', c.encoding === 'utf8' ? 'UTF-8' : c.encoding!.toUpperCase()]);
    }
    let scopes: Scope[] = [];
    if (action === 'start' || action === 'reconnect') {
      if (!c.profile || !uuid(c.profile.id) || !uuid(c.revision) || (action === 'reconnect' && (c.profile.settings.protocol !== 'ssh2' || c.original_profile_id !== c.profile.id))) throw new Error('必须使用原SSH配置或所选建连配置的固定版本。');
      scopes = [{ target: { kind: 'profile_revision', profile_id: c.profile.id, revision: c.revision }, action: 'CONNECT' }];
      if (connection) scopes.unshift({ target: { kind: 'connection', connection }, action: 'RECONNECT' });
      description.push(['配置', `${c.profile.name} · ${c.profile.id}`], ['配置版本', c.revision], ['配置参数', profileDescription(c.profile)]);
    } else {
      const permission: Partial<Record<SingleAction, Action>> = { write: 'WRITE', write_text: 'WRITE', send: 'WRITE', exec: 'EXEC', resize: 'CONTROL', control: 'CONTROL', disconnect: 'DISCONNECT', forget_start: 'FORGET' };
      scopes = [{ target: { kind: 'connection', connection: connection! }, action: permission[action]! }];
    }
    let request: Operation['request'];
    if (action === 'start' && protocol === 'SERIAL') {
      if (!c.device || !uuid(c.device.revision) || !uuid(c.device.device_id) || c.profile?.settings.protocol !== 'serial' || c.device.port !== c.profile.settings.port) throw new Error('请显式刷新串口库存并选择与配置端口匹配的设备。');
      request = { op: 'start', profile_id: c.profile.id, request_id, revision: c.device.revision, device_id: c.device.device_id };
      description.push(['库存版本', c.device.revision], ['固定设备', `${c.device.port} · ${c.device.device_id}`]);
    } else if (action === 'start' || action === 'reconnect' || action === 'resize') {
      if (!number(draft.cols, 2, 500) || !number(draft.rows, 1, 200)) throw new Error('SSH尺寸须为2–500列、1–200行；不自动修正。');
      request = action === 'start' ? { op: action, profile_id: c.profile!.id, request_id, cols: draft.cols, rows: draft.rows } : { op: action, connection, request_id, cols: draft.cols, rows: draft.rows };
      description.push(['SSH尺寸', `${draft.cols} 列 × ${draft.rows} 行`]);
    } else if (action === 'write') {
      const bytes = hexBytes(draft.hex);
      request = { op: action, connection, request_id, bytes };
      description.push(['完整字节（HEX）', bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ')], ['字节数', String(bytes.length)]);
    } else if (action === 'write_text') {
      if (!draft.text.length || utf8(draft.text) > 196608) throw new Error('请输入不超过196608 UTF-8字节的SSH文本。');
      request = { op: action, connection, request_id, text: draft.text };
      description.push(['完整文本（换行/控制符以转义显示）', JSON.stringify(draft.text)]);
    } else if (action === 'exec') {
      if (!draft.text.length || utf8(draft.text) > 65536 || draft.text.includes('\0') || !number(draft.timeout_ms, 1, 86400000) || !number(draft.max_output_bytes, 1, 1048576)) throw new Error('请核对exec命令（最多65536字节且无NUL）、1–86400000毫秒和1–1048576输出字节。');
      request = { op: action, connection, request_id, command: draft.text, timeout_ms: draft.timeout_ms, max_output_bytes: draft.max_output_bytes };
      description.push(['完整命令（转义显示）', JSON.stringify(draft.text)], ['超时', `${draft.timeout_ms} 毫秒`], ['输出上限', `${draft.max_output_bytes} 字节`]);
    } else if (action === 'send') {
      if (!['text', 'hex'].includes(draft.format) || !['none', 'cr', 'lf', 'cr_lf'].includes(draft.ending) || utf8(draft.text) > 196608 || !number(draft.chunk_bytes, 1, 1024) || !number(draft.interval_ms, 0, 1000)) throw new Error('请核对串口正文、格式、结尾及发送节奏。');
      if (draft.format === 'hex' && draft.text.trim()) hexBytes(draft.text);
      if (!draft.text.length && draft.ending === 'none') throw new Error('本次没有待发送的字节。');
      const endingBytes = draft.ending === 'none' ? 0 : draft.ending === 'cr_lf' ? 2 : 1;
      const knownBytes = draft.format === 'hex' ? (draft.text.trim() ? hexBytes(draft.text).length : 0) : c.encoding === 'utf8' ? utf8(draft.text) : undefined;
      if (knownBytes !== undefined && (knownBytes + endingBytes === 0 || knownBytes + endingBytes > 65536 || draft.interval_ms * Math.max(0, Math.ceil((knownBytes + endingBytes) / draft.chunk_bytes) - 1) > 60000)) throw new Error('串口编码后字节须为1–65536，节奏总等待不能超过60秒。');
      request = { op: action, connection, request_id, content: draft.text, format: draft.format, ending: draft.ending, pace: { chunk_bytes: draft.chunk_bytes, interval_ms: draft.interval_ms } };
      description.push(['完整正文（转义显示）', JSON.stringify(draft.text)], ['发送格式', draft.format === 'text' ? '文本（连接编码）' : 'HEX 原始字节'], ['结尾', draft.ending === 'none' ? '不追加' : draft.ending === 'cr_lf' ? 'CRLF' : draft.ending.toUpperCase()], ['节奏', `每片最多 ${draft.chunk_bytes} 字节 / 间隔 ${draft.interval_ms} 毫秒`]);
    } else if (action === 'control') {
      if (!['DTR', 'RTS', 'BREAK'].includes(draft.line) || typeof draft.asserted !== 'boolean') throw new Error('请选择串口控制线及明确电平。');
      request = { op: action, connection, request_id, line: draft.line, asserted: draft.asserted };
      description.push(['控制线', draft.line], ['电平', draft.asserted ? '开启' : '关闭']);
    } else request = { op: action, connection, request_id };
    const proposal: OperationProposal = { context_key: contextKey(c, action), draft_key: JSON.stringify(draft), operation: { protocol, request }, scopes, lifetime_ms: seconds * 1000, description, ...(['start', 'reconnect'].includes(action) ? { profile_id: c.profile!.id, revision: c.revision } : {}) };
    if (utf8(JSON.stringify(proposal.operation)) > 500000) throw new Error('规范操作数据过大，请缩小本次正文。');
    this.current = freeze(proposal);
    return proposal;
  }
  consume(c: OperationContext, draft: Draft, proposal: OperationProposal): OperationProposal {
    const valid = this.current === proposal && proposal.context_key === contextKey(c, draft.action) && proposal.draft_key === JSON.stringify(draft);
    this.invalidate();
    if (!valid) throw new Error('操作、配置、设备或连接预览已失效，请重新核对。');
    return proposal;
  }
}
export async function operationFingerprint(operation: Operation): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(operation));
  try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join(''); }
  finally { data.fill(0); }
}
export function checkedOperationReply(view: GrantView, proposal: OperationProposal, fingerprint: string): GrantView {
  const key = (scope: Scope) => JSON.stringify(scope);
  if (view.form?.kind !== 'single_operation' || view.form.operation.request_id !== proposal.operation.request.request_id || view.form.operation.fingerprint !== fingerprint || view.approved_scopes.length !== proposal.scopes.length || view.approved_scopes.some(scope => !proposal.scopes.some(original => key(scope) === key(original)))) throw new Error('单次授权回执与已批准参数不一致；请只查询原签发编号。');
  return view;
}
