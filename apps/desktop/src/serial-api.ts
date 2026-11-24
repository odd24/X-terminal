import { invoke } from '@tauri-apps/api/core';
import { reference, type Connection, type ConnectionRef } from './ssh-api';
import type { Settings } from './config-api';
export { reference };
export type Device = { device_id: string; port: string; instance_id: string; friendly_name?: string };
export type Inventory = { result: 'inventory'; revision: string; devices: Device[]; unidentified_ports: string[]; metadata_failures: number };
export type SerialStatus = { result: 'status'; connection: Connection; profile_id: string; port: string; source_settings?: Settings; encoding: string; hardware_rts: boolean; cleanup_pending: boolean; failure: string | null; read_bytes: number; dropped_bytes: number; break_cleanup_failure: string | null };
export type SerialReceipt = { result: 'input'; request_id: string; state: 'PENDING' | 'DRIVER_ACCEPTED' | 'CONTROL_APPLIED' | 'CANCELLED_BEFORE_DISPATCH' | 'UNKNOWN'; driver_accepted: number | null; failure: string | null };
type Request =
  | { op: 'inventory' }
  | { op: 'quick_start'; settings: Settings; request_id: string; revision: string; device_id: string }
  | { op: 'start_status'; request_id: string }
  | { op: 'start'; profile_id: string; request_id: string; revision: string; device_id: string }
  | { op: 'status' | 'close' | 'forget'; connection: ConnectionRef }
  | { op: 'control'; connection: ConnectionRef; request_id: string; line: 'DTR' | 'RTS' | 'BREAK'; asserted: boolean }
  | { op: 'send'; connection: ConnectionRef; request_id: string; content: string; format: 'text' | 'hex'; ending: 'none' | 'cr' | 'lf' | 'cr_lf'; pace: { chunk_bytes: number; interval_ms: number } }
  | { op: 'input_status'; connection: ConnectionRef; request_id: string };
export type SerialReply = Inventory | SerialStatus | SerialReceipt | { result: 'started'; connection: Connection } | { result: 'accepted' };
export class SerialRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export async function serial(request: Request): Promise<SerialReply> {
  try { return await invoke<SerialReply>('serial_request', { request }); }
  catch (error) {
    const messages: Record<string,string> = {
      InvalidState: '状态或设备目录已变化；请等待清理完成并刷新设备，未自动重连。',
      InvalidArgument: '发送格式、编码、字节数、节奏或请求 ID 无效；未自动重发。',
      INVALID_SERIAL_REQUEST: '串口请求参数无效。',
      NotFound: '设备选择、连接或请求已不存在，请刷新设备目录。',
      NotConnected: '串口当前不可写，未接受新输入。',
      CapacityExceeded: '串口队列或回执容量已满，未接受本次新请求。',
      RequestExpired: '请求超出保留窗口；结果可能已不可查询，不能据此重发。',
      StaleGeneration: '连接代次已变化，本次操作未转发到新连接。',
      PermissionDenied: '当前客户端没有串口控制权限。',
    };
    const code=typeof error==='string'&&Object.hasOwn(messages,error)?error:'UNKNOWN';
    throw new SerialRequestError(code,messages[code] ?? '串口请求失败，结果可能未知；未自动重试或重连。');
  }
}
export async function readSerialInventory(): Promise<Inventory> {
  const reply=await serial({op:'inventory'});
  if(reply.result!=='inventory')throw new SerialRequestError('INVALID_INVENTORY','端口清单回复无效，请重新读取。');
  return reply;
}
export function findSerialDevice(devices: readonly Device[], id: string, port?: string) {
  return devices.find(device=>device.device_id===id&&(port===undefined||device.port===port));
}
export async function serialResult(target: ConnectionRef, initial: SerialReply, alive: () => boolean = () => true): Promise<SerialReceipt> {
  if (initial.result !== 'input') throw new Error('串口回执响应不匹配。');
  let receipt: SerialReceipt = initial;
  const deadline = performance.now() + 75000;
  while (receipt.state === 'PENDING') {
    if (!alive()) throw new Error(`已停止查询 ${target.connection_id}/${target.generation}；原请求可能仍在执行，可切回原连接关闭。`);
    if (performance.now() > deadline) throw new Error('等待回执超时，结果可能未知；未重发。');
    await new Promise(resolve => setTimeout(resolve, 50));
    const reply = await serial({ op: 'input_status', connection: target, request_id: initial.request_id });
    if (reply.result !== 'input' || reply.request_id !== initial.request_id) throw new Error('串口回执响应不匹配。');
    receipt = reply;
  }
  return receipt;
}
