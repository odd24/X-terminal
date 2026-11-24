import { invoke } from '@tauri-apps/api/core';
import { ConfigRequestError } from './config-error';
export { ConfigRequestError, messages } from './config-error';
export type Encoding = 'utf8' | 'gbk' | 'gb18030';
export type Auth = 'password' | 'public_key' | 'keyboard_interactive';
export type Settings =
  | { protocol: 'ssh2'; host: string; port: number; username: string; auth: Auth; encoding: Encoding }
  | { protocol: 'ssh1'; host: string; port: number; username: string; explicitly_enabled: boolean; encoding: Encoding }
  | { protocol: 'serial'; port: string; baud_rate: number; data_bits: number; stop_bits: number; parity: 'none' | 'odd' | 'even'; flow: 'none' | 'software' | 'hardware'; dtr_on_open: boolean; rts_on_open: boolean | null; encoding: Encoding };
export type Folder = { id: string; parent_id: string | null; name: string };
export type PortableProfile = { id: string; folder_id: string | null; name: string; settings: Settings };
export type Profile = PortableProfile & { credential_ref: string | null; credential_missing?: boolean };
export type Workspace={id:string;name:string;groups:{id:string;name:string}[];tabs:{id:string;profile_id:string;group_id:string|null}[];selected_tab:string|null;navigation_open:boolean;split:{direction:'horizontal'|'vertical';tabs:[string,string]}|null};
export type QuickCommand={id:string;name:string;group:string;template:string;ending:'none'|'cr'|'lf'|'crlf'};
export type HostEndpoint = { protocol: 'ssh1' | 'ssh2'; host: string; port: number };
export type HostKeySummary = { endpoint: HostEndpoint; algorithm: string; fingerprint: string };
export type CredentialEdit = { action: 'keep' | 'clear' } | { action: 'replace'; value: { password: string | null; private_key: string | null; passphrase: string | null } };
export type BatchPatch={folder:{kind:'keep'}|{kind:'move';folder_id:string|null};encoding:Encoding|null;ssh_port:number|null;serial_baud:number|null};
export type BatchReceipt={id:string;revision:string;state:'PREVIEW'|'APPLIED'|'CANCELLED'|'REJECTED'|'EXPIRED';reason:string|null;changed_count:number;rows:{before:PortableProfile;after:PortableProfile}[]};
export type ImportPolicy='reject'|'new_ids'|'replace';
export type ImportDiff={folders:{source_id:string;before:Folder|null;after:Folder}[];profiles:{source_id:string;before:PortableProfile|null;after:PortableProfile;credential_preserved:boolean}[]};
export type ImportReceipt={id:string;revision:string;state:BatchReceipt['state'];policy:ImportPolicy;problem:{code:string;row:number|null}|null;reason:string|null;diff:ImportDiff};
export type ConfigRequest = {op:'apply_import'|'import_status'|'cancel_import';id:string}| {op:'preview_batch';id:string;revision:string;ids:string[];patch:BatchPatch}|{op:'apply_batch'|'batch_status'|'cancel_batch';id:string}| {op:'recheck';service_id:string}|{op:'quick_commands'}|{op:'save_quick_command';command:QuickCommand;revision:string}|{op:'delete_quick_command';id:string;revision:string}|{ op: 'preferences' }
  | {op:'workspaces'}
  | {op:'save_workspace';workspace:Workspace;revision:string}
  | {op:'delete_workspace';id:string;revision:string}
  | { op: 'save_preferences'; preferences: DesktopPreferences; revision: string }
  | { op: 'page'; revision: string | null; offset: number; folders: boolean }
  | { op: 'credentials_page'; revision: string | null; offset: number }
  | { op: 'inspect_credential'; id: string }
  | { op: 'forget_credential'; id: string; revision: string }
  | { op: 'archives' | 'create_backup' | 'export_config' }
  | { op: 'inspect_backup'; id: string }
  | { op: 'restore_backup'; id: string; digest: string; current_revision: string }
  | { op: 'recover_backup'; id: string; digest: string }
  | { op: 'delete_archive'; id: string; kind: 'backup' | 'export' }
  | { op: 'host_keys_page'; revision: string | null; offset: number }
  | { op: 'forget_host_key'; endpoint: HostEndpoint; algorithm: string; expected_fingerprint: string }
  | { op: 'save_folder'; folder: Folder } | { op: 'delete_folder' | 'delete_profile'; id: string }
  | { op: 'delete_profile_if_revision'; id: string; revision: string }
  | { op: 'save_profile'; profile: PortableProfile; credential: CredentialEdit }
  | { op: 'save_profile_key_file'; profile: PortableProfile; key_path: string; passphrase: string | null };
// File import is Desktop-only; file bytes are read inside the service.
type Page = { result: 'page'; revision: string; folders: Folder[]; profiles: Profile[]; next_offset: number | null; missing_credential_profiles: string[] };
export type ArchiveInfo = { id: string; kind: 'backup' | 'export'; filename: string; bytes: number; modified_ms: number };
export type DesktopPreferences = { theme: 'dark' | 'light' | 'system'; terminal_font: 'consolas' | 'cascadia'; terminal_palette: 'follow_theme' | 'black_green' | 'black_white' | 'x'; font_size: number; terminal_text_brightness?: number; ctrl_c_copy: boolean; ctrl_v_paste: boolean; right_click_paste: boolean };
export type BackupPreview = { result: 'backup_preview'; id: string; digest: string; folders: number; profiles: number; host_keys: number; workspaces:number; quick_commands:number; missing_credentials: number; current_revision: string | null; sample_profiles: string[]; preferences: DesktopPreferences };
export type Reply = {result:'import';receipt:ImportReceipt}| {result:'batch';receipt:BatchReceipt}| {result:'rechecked';service_id:string}|{result:'quick_commands';commands:QuickCommand[];revision:string}|{result:'workspaces';workspaces:Workspace[];revision:string} | { result: 'preferences'; preferences: DesktopPreferences; revision: string } | Page | { result: 'saved_profile'; profile: Profile; revision: string } | { result: 'updated'; revision: string } | { result: 'host_keys_page'; revision: string; keys: HostKeySummary[]; next_offset: number | null }
  | { result: 'credentials_page'; revision: string; entries: CredentialInfo[]; next_offset: number | null }
  | CredentialPreview
  | { result: 'archives'; entries: ArchiveInfo[] } | { result: 'artifact'; artifact: ArchiveInfo } | BackupPreview
  | { result: 'restored'; revision: string; safety_backup: ArchiveInfo; missing_credentials: number }
  | { result: 'recovered'; directory_id: string; missing_credentials: number };
export type CredentialInfo = { id: string; current_profiles: number };
export type CredentialPreview = { result: 'credential_preview'; id: string; revision: string; current_profiles: number; backup_profiles: number };
export async function config(request: ConfigRequest): Promise<Reply> {
  let reply: Reply | { result: 'error'; code: string };
  try { reply = await invoke('config_request', { request }); }
  catch (error) { throw new ConfigRequestError(error,error!=='INVALID_CONFIGURATION'); }
  if (reply.result === 'error') throw new ConfigRequestError(reply.code);
  return reply;
}
export async function readConfiguration(): Promise<{ folders: Folder[]; profiles: Profile[]; revision: string }> {
  // One revision across both collections. A conflict is surfaced, never silently merged.
  let revision: string | null = null;
  const folders: Folder[] = []; const profiles: Profile[] = [];
  for (const folderPage of [true, false]) {
    let offset = 0;
    for (;;) {
      const reply = await config({ op: 'page', revision, offset, folders: folderPage });
      if (reply.result !== 'page') throw new ConfigRequestError('INVALID_CONFIGURATION_REPLY',true);
      revision = reply.revision; folders.push(...reply.folders); profiles.push(...reply.profiles.map(profile => ({...profile,credential_missing:reply.missing_credential_profiles.includes(profile.id)})));
      if (reply.next_offset === null) break;
      offset = reply.next_offset;
    }
  }
  if (!revision) throw new ConfigRequestError('INVALID_CONFIGURATION_REPLY',true);
  return { folders, profiles, revision };
}
