import { invoke } from '@tauri-apps/api/core';
import type { Auth, HostKeySummary } from './config-api';
export type Connection = { connection_id: string; generation: number; protocol: string; state: string };
export type ConnectionRef = Pick<Connection, 'connection_id' | 'generation'>;
export type Challenge =
  | { kind: 'host_key'; id: string; review: { candidate: HostKeySummary; known: HostKeySummary[]; status: 'unknown' | 'known' | 'changed'; revision: string } }
  | { kind: 'credentials'; id: string; auth: Auth; stored_available: boolean }
  | { kind: 'interactive'; id: string; name: string; instructions: string; prompts: { text: string; echo: boolean }[] };
export type SshStatus = { connection: Connection; profile_id: string; challenge: Challenge | null; failure: string | null; shell_exit_status: number | null; shell_exit_signal: string | null };
export type Receipt = { request_id: string; state: 'PENDING' | 'DISPATCHING' | 'PIPELINE_QUEUED' | 'UNKNOWN' | 'CANCELLED_BEFORE_DISPATCH'; pipeline_bytes: number | null; failure: string | null };
type Request =
  | { op: 'start'; profile_id: string; request_id: string; cols: number; rows: number }
  | { op: 'reconnect'; connection: ConnectionRef; request_id: string; cols: number; rows: number }
  | { op: 'status' | 'close'; connection: ConnectionRef }
  | { op: 'answer_host'; connection: ConnectionRef; challenge_id: string; approve: boolean }
  | { op: 'authenticate'; connection: ConnectionRef; challenge_id: string; use_saved: boolean; password: string | null }
  | { op: 'answer_interactive'; connection: ConnectionRef; challenge_id: string; answers: string[] }
  | { op: 'write'; connection: ConnectionRef; request_id: string; bytes: number[] }
  | { op: 'resize'; connection: ConnectionRef; request_id: string; cols: number; rows: number }
  | { op: 'input_status'; connection: ConnectionRef; request_id: string };
export type SshReply = { result: 'started'; connection: Connection } | ({ result: 'status' } & SshStatus) | ({ result: 'input' } & Receipt) | { result: 'accepted' };
export async function ssh(request: Request): Promise<SshReply> {
  try { return await invoke<SshReply>('ssh_request', { request }); }
  catch (error) {
    const code = String(error);
    const messages: Record<string, string> = {
      CapacityExceeded: '队列或去重记录已满；本次请求未接受。',
      StaleGeneration: '连接代次已变化；本次操作未转发到新连接。',
      InvalidState: '当前连接状态不允许此操作。',
      NotConnected: '连接不可写，未发送输入。',
      InvalidArgument: '请求参数无效或请求 ID 冲突。',
      INVALID_SSH_REQUEST: 'SSH 请求参数无效。',
      NotFound: '连接、配置或请求已不存在。',
    };
    throw new Error(messages[code] ?? 'SSH 请求失败；结果可能未知，未自动重试或重连。');
  }
}
export function reference(connection: Connection): ConnectionRef {
  return { connection_id: connection.connection_id, generation: connection.generation };
}
export function dimensions(cols: number, rows: number) {
  return { cols: Math.max(2, Math.min(500, cols)), rows: Math.max(1, Math.min(200, rows)) };
}
