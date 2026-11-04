import { invoke } from '@tauri-apps/api/core';
export type Encoding = 'utf8' | 'gbk' | 'gb18030';
export type Auth = 'password' | 'public_key' | 'keyboard_interactive';
export type Settings =
  | { protocol: 'ssh2'; host: string; port: number; username: string; auth: Auth; encoding: Encoding }
  | { protocol: 'ssh1'; host: string; port: number; username: string; explicitly_enabled: boolean; encoding: Encoding }
  | { protocol: 'serial'; port: string; baud_rate: number; data_bits: number; stop_bits: number; parity: 'none' | 'odd' | 'even'; flow: 'none' | 'software' | 'hardware'; dtr_on_open: boolean; rts_on_open: boolean | null; encoding: Encoding };
export type Folder = { id: string; parent_id: string | null; name: string };
export type PortableProfile = { id: string; folder_id: string | null; name: string; settings: Settings };
export type Profile = PortableProfile & { credential_ref: string | null };
export type CredentialEdit = { action: 'keep' | 'clear' } | { action: 'replace'; value: { password: string | null; private_key: string | null; passphrase: string | null } };
export type ConfigRequest = { op: 'page'; revision: string | null; offset: number; folders: boolean }
  | { op: 'save_folder'; folder: Folder } | { op: 'delete_folder' | 'delete_profile'; id: string }
  | { op: 'save_profile'; profile: PortableProfile; credential: CredentialEdit }
  | { op: 'save_profile_key_file'; profile: PortableProfile; key_path: string; passphrase: string | null };
// File import is Desktop-only; file bytes are read inside the service.
type Page = { result: 'page'; revision: string; folders: Folder[]; profiles: Profile[]; next_offset: number | null };
export type Reply = Page | { result: 'saved_profile'; profile: Profile; revision: string } | { result: 'updated'; revision: string };
export const messages: Record<string, string> = {
  INVALID: '配置无效，或目录仍被引用。请检查参数和目录关系。',
  NOT_FOUND: '配置已不存在，请刷新。', CONFLICT: '配置已变化，请刷新后重试。',
  LOCKED: '该数据目录已被另一服务使用。请退出另一桌面后重新启动。',
  UNSUPPORTED_SCHEMA: '数据库版本不受支持，未覆盖文件。请使用匹配版本或备份，并重新启动。',
  CORRUPT: '配置或凭据库损坏，未重建文件。请保留原文件并使用备份恢复后重新启动。',
  STORAGE: '配置存储不可用。请检查目录权限和磁盘空间。',
  CREDENTIAL_UNAVAILABLE: '保存的凭据不可用。请重新输入或移除该配置的引用。',
  CONFIG_CHANNEL_UNAVAILABLE: '配置通道不可用，未自动重试。请重新启动桌面。',
  INVALID_CONFIGURATION: '配置参数无效，请检查输入。',
  CapacityExceeded: '配置队列已满，此次操作未被接受。',
};
export async function config(request: ConfigRequest): Promise<Reply> {
  let reply: Reply | { result: 'error'; code: string };
  try { reply = await invoke('config_request', { request }); }
  catch (error) { throw new Error(messages[String(error)] ?? '配置请求失败；结果可能未知，未自动重试。'); }
  if (reply.result === 'error') throw new Error(messages[reply.code] ?? '配置请求失败。');
  return reply;
}
export async function readConfiguration(): Promise<{ folders: Folder[]; profiles: Profile[] }> {
  // One revision across both collections. A conflict is surfaced, never silently merged.
  let revision: string | null = null;
  const folders: Folder[] = []; const profiles: Profile[] = [];
  for (const folderPage of [true, false]) {
    let offset = 0;
    for (;;) {
      const reply = await config({ op: 'page', revision, offset, folders: folderPage });
      if (reply.result !== 'page') throw new Error('配置响应不匹配。');
      revision = reply.revision; folders.push(...reply.folders); profiles.push(...reply.profiles);
      if (reply.next_offset === null) break;
      offset = reply.next_offset;
    }
  }
  return { folders, profiles };
}
