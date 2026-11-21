import { invoke } from '@tauri-apps/api/core';
import type { Auth, HostKeySummary, Settings } from './config-api';
import { requestId } from './request-id';
export type Connection = { connection_id: string; generation: number; protocol: string; state: string };
export type ConnectionRef = Pick<Connection, 'connection_id' | 'generation'>;
export type FixedProfile = { profile_id: string; revision: string };
export type Challenge =
  | { kind: 'host_key'; id: string; review: { candidate: HostKeySummary; known: HostKeySummary[]; status: 'unknown' | 'known' | 'changed'; revision: string } }
  | { kind: 'credentials'; id: string; auth: Auth; stored_available: boolean }
  | { kind: 'interactive'; id: string; name: string; instructions: string; prompts: { text: string; echo: boolean }[] };
export type SshStatus = { connection: Connection; profile_id: string; server_host: string; temporary_settings?: Settings | null; source_settings?: Settings; encoding: 'utf8' | 'gbk' | 'gb18030'; challenge: Challenge | null; failure: string | null; shell_exit_status: number | null; shell_exit_signal: string | null };
export type Receipt = { request_id: string; state: 'PENDING' | 'DISPATCHING' | 'PIPELINE_QUEUED' | 'UNKNOWN' | 'CANCELLED_BEFORE_DISPATCH'; pipeline_bytes: number | null; failure: string | null };
export type ExecSummary = { end: string; exit_status: number | null; exit_signal: string | null; request_accepted: boolean | null; output_truncated: boolean; stdout_bytes: number; stderr_bytes: number };
export type TaskStatus = { task_id: string; connection: ConnectionRef; encoding: 'utf8' | 'gbk' | 'gb18030'; phase: 'QUEUED' | 'RUNNING' | 'CANCELLING' | 'FINISHED'; summary: ExecSummary | null };
export type ExecPage = { events: { seq: number; stderr: boolean; bytes: number[] }[]; next_cursor: number; available_from: number; truncated: boolean; completed: boolean };
type Request =
  | { op: 'quick_start'; settings: Settings; request_id: string; cols: number; rows: number }
  | { op: 'start_status'; request_id: string }
  | { op: 'authenticate_key'; connection: ConnectionRef; challenge_id: string; key_path: string; passphrase: string | null }
  | { op: 'exec'; connection: ConnectionRef; request_id: string; command: string; timeout_ms: number; max_output_bytes: number }
  | { op: 'exec_status' | 'exec_cancel'; connection: ConnectionRef; task_id: string }
  | { op: 'exec_read'; connection: ConnectionRef; task_id: string; cursor: number; max_bytes: number }
  | { op: 'start'; profile_id: string; request_id: string; cols: number; rows: number }
  | { op: 'start_fixed'; profile_id: string; revision: string; request_id: string; cols: number; rows: number }
  | { op: 'connect_status'; profile_id: string; revision: string; request_id: string }
  | { op: 'disconnect'; connection: ConnectionRef; request_id: string }
  | { op: 'disconnect_status' | 'reconnect_status' | 'forget_start' | 'forget_status'; connection: ConnectionRef; request_id: string }
  | { op: 'reconnect'; connection: ConnectionRef; request_id: string; cols: number; rows: number }
  | { op: 'reconnect_fixed'; connection: ConnectionRef; profile: FixedProfile; request_id: string; cols: number; rows: number }
  | { op: 'reconnect_fixed_status'; connection: ConnectionRef; profile: FixedProfile; request_id: string }
  | { op: 'status' | 'close' | 'forget'; connection: ConnectionRef }
  | { op: 'answer_host'; connection: ConnectionRef; challenge_id: string; approve: boolean }
  | { op: 'authenticate'; connection: ConnectionRef; challenge_id: string; use_saved: boolean; password: string | null }
  | { op: 'answer_interactive'; connection: ConnectionRef; challenge_id: string; answers: string[] }
  | { op: 'write_text'; connection: ConnectionRef; request_id: string; text: string }
  | { op: 'write'; connection: ConnectionRef; request_id: string; bytes: number[] }
  | { op: 'resize'; connection: ConnectionRef; request_id: string; cols: number; rows: number }
  | { op: 'input_status'; connection: ConnectionRef; request_id: string };
export type SshReply =
  | ({ result: 'exec' } & TaskStatus)
  | { result: 'exec_output'; connection: ConnectionRef; task_id: string; output: ExecPage }
  | { result: 'started'; connection: Connection }
  | { result: 'connect_receipt'; profile_id: string; revision: string; request_id: string; connection: Connection }
  | { result: 'reconnect_receipt'; previous: ConnectionRef; request_id: string; connection: Connection }
  | { result: 'reconnect_fixed_receipt'; previous: ConnectionRef; profile: FixedProfile; request_id: string; connection: Connection }
  | { result: 'disconnect'; connection: ConnectionRef; request_id: string; state: 'REQUESTED' | 'TRANSPORT_ENDED' }
  | { result: 'forget'; connection: ConnectionRef; request_id: string; state: 'REMOVED' }
  | ({ result: 'status' } & SshStatus)
  | ({ result: 'input' } & Receipt)
  | { result: 'accepted' };
export class SshRequestError extends Error { constructor(readonly code:string,message:string){super(message);} }
export async function ssh(request: Request): Promise<SshReply> {
  try { return await invoke<SshReply>('ssh_request', { request }); }
  catch (error) {
    const code = String(error);
    const messages: Record<string, string> = {
      CapacityExceeded: '队列或去重记录已满；本次请求未接受。',
      RequestExpired: '请求已超出回执保留窗口；原结果可能无法再查询，未重新发送。系统时间回退也可能导致此错误。',
      StaleGeneration: '连接代次已变化；本次操作未转发到新连接。',
      InvalidState: '当前连接状态不允许此操作。',
      NotConnected: '连接不可写，未发送输入。',
      InvalidArgument: '请求参数无效、文本无法用连接编码表示、超过编码字节上限或请求 ID 冲突。',
      INVALID_SSH_REQUEST: 'SSH 请求参数无效。',
      NotFound: '连接、配置或请求已不存在。',
    };
    throw new SshRequestError(code,messages[code] ?? 'SSH 请求失败；结果可能未知，未自动重试或重连。');
  }
}
export function reference(connection: Connection): ConnectionRef {
  return { connection_id: connection.connection_id, generation: connection.generation };
}
export async function disconnectSsh1(connection: ConnectionRef) {
  const request_id = requestId();
  const reply = await ssh({ op: 'disconnect', connection, request_id });
  if (reply.result !== 'disconnect' || reply.request_id !== request_id
    || reply.connection.connection_id !== connection.connection_id || reply.connection.generation !== connection.generation) {
    throw new Error('SSH1 关闭回执与原请求不匹配。');
  }
}
export function dimensions(cols: number, rows: number) {
  return { cols: Math.max(2, Math.min(500, cols)), rows: Math.max(1, Math.min(200, rows)) };
}
