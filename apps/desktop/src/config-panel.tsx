import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { HostKeysPanel } from './host-keys-panel';
import { ArchivesPanel } from './archives-panel';
import { CredentialsPanel } from './credentials-panel';
import { config, ConfigRequestError, readConfiguration, type Auth, type CredentialEdit, type Encoding, type Folder, type Profile, type Settings } from './config-api';

type Draft = {
  id: string; name: string; folder: string; protocol: Settings['protocol']; encoding: Encoding;
  host: string; port: number; username: string; auth: Auth; ssh1: boolean;
  serialPort: string; baud: number; bits: number; stopBits: number; parity: 'none' | 'odd' | 'even'; flow: 'none' | 'software' | 'hardware'; dtr: boolean; rts: boolean;
};
const blank = (): Draft => ({ id: crypto.randomUUID(), name: '', folder: '', protocol: 'ssh2', encoding: 'utf8', host: '', port: 22, username: '', auth: 'password', ssh1: false, serialPort: '', baud: 115200, bits: 8, stopBits: 1, parity: 'none', flow: 'none', dtr: false, rts: false });
function edit(profile: Profile): Draft {
  const base = { ...blank(), id: profile.id, name: profile.name, folder: profile.folder_id ?? '', protocol: profile.settings.protocol, encoding: profile.settings.encoding };
  const settings = profile.settings;
  if (settings.protocol === 'serial') return { ...base, serialPort: settings.port, baud: settings.baud_rate, bits: settings.data_bits, stopBits: settings.stop_bits, parity: settings.parity, flow: settings.flow, dtr: settings.dtr_on_open, rts: settings.rts_on_open ?? false };
  return { ...base, host: settings.host, port: settings.port, username: settings.username, auth: settings.protocol === 'ssh2' ? settings.auth : 'password', ssh1: settings.protocol === 'ssh1' && settings.explicitly_enabled };
}
function settings(draft: Draft): Settings {
  if (draft.protocol === 'serial') return { protocol: 'serial', port: draft.serialPort.trim().toUpperCase(), baud_rate: draft.baud, data_bits: draft.bits, stop_bits: draft.stopBits, parity: draft.parity, flow: draft.flow, dtr_on_open: draft.dtr, rts_on_open: draft.flow === 'hardware' ? null : draft.rts, encoding: draft.encoding };
  const common = { host: draft.host.trim(), port: draft.port, username: draft.username, encoding: draft.encoding };
  return draft.protocol === 'ssh2' ? { ...common, protocol: 'ssh2', auth: draft.auth } : { ...common, protocol: 'ssh1', explicitly_enabled: draft.ssh1 };
}
export function ConfigPanel({ close, onRestored, initialProfileId, initialAction, onChanged }: { close(): void; onRestored(): Promise<void>; initialProfileId?:string; initialAction?:'edit'|'delete'; onChanged?():void }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [filter, setFilter] = useState('*');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft>(blank);
  const [folderDraft, setFolderDraft] = useState<Folder>({ id: crypto.randomUUID(), parent_id: null, name: '' });
  const [credential, setCredential] = useState<'keep' | 'clear' | 'replace'>('keep');
  const [password, setPassword] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('正在读取配置');
  const [location, setLocation] = useState('');
  const [ready, setReady] = useState(false);
  const [managementEpoch,setManagementEpoch]=useState(0);
  const [deletion,setDeletion]=useState<{profile:Profile;uncertain:boolean}>();
  const deleteFlight=useRef(false),deleteControl=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(deletion&&!busy)deleteControl.current?.focus();},[deletion,busy]);
  const current = profiles.find(profile => profile.id === draft.id);
  const clearSecrets = () => { setPassword(''); setKeyPath(''); setPassphrase(''); setCredential('keep'); };
  const change = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [field]: value }));
  const folderName = (folder: Folder): string => {
    const path = [folder.name]; let parent = folder.parent_id; const seen = new Set([folder.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); const item = folders.find(f => f.id === parent); if (!item) break; path.unshift(item.name); parent = item.parent_id; }
    return path.join(' / ');
  };
  const options = <><option value="">根目录</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folderName(folder)}</option>)}</>;
  async function reload() {
    const data = await readConfiguration(); setFolders(data.folders); setProfiles(data.profiles); setFilter(previous => previous !== '*' && previous !== '' && !data.folders.some(folder => folder.id === previous) ? '*' : previous); setReady(true);
  }
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setMessage('正在处理配置…');
    try { await action(); await reload(); onChanged?.(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败，未自动重试。'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let disposed = false;
    void invoke<string>('config_directory').then(directory => { if (!disposed) setLocation(directory); }).catch(() => {});
    void readConfiguration().then(data => {
      if (!disposed) { setFolders(data.folders); setProfiles(data.profiles); setFilter(previous => previous !== '*' && previous !== '' && !data.folders.some(folder => folder.id === previous) ? '*' : previous); setReady(true); setMessage('配置已加载');if(initialProfileId){const target=data.profiles.find(p=>p.id===initialProfileId);if(target){setDraft(edit(target));if(initialAction==='delete')setDeletion({profile:target,uncertain:false});}else{setReady(false);setMessage('所选配置已不存在，请关闭后刷新会话树。');}} }
    }).catch(error => { if (!disposed) setMessage(error instanceof Error ? error.message : '读取配置失败。'); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const value = settings(draft);
    const editCredential: CredentialEdit = value.protocol === 'serial' ? { action: 'clear' } : credential === 'replace'
      ? { action: 'replace', value: { password: value.protocol === 'ssh2' && value.auth === 'public_key' ? null : password, private_key: null, passphrase: value.protocol === 'ssh2' && value.auth === 'public_key' ? passphrase : null } }
      : { action: credential };
    try { await run(async () => { const profile = { id: draft.id, folder_id: draft.folder || null, name: draft.name, settings: value }; await config(value.protocol === 'ssh2' && value.auth === 'public_key' && credential === 'replace' ? { op: 'save_profile_key_file', profile, key_path: keyPath, passphrase } : { op: 'save_profile', profile, credential: editCredential }); }, '配置已保存；未连接设备'); }
    finally { clearSecrets(); }
  }
  async function deleteSelected(){
    if(!deletion||deletion.uncertain||deleteFlight.current)return;
    const target=deletion.profile;deleteFlight.current=true;setBusy(true);let dispatched=false;
    try{const latest=(await readConfiguration()).profiles.find(p=>p.id===target.id);if(!latest||JSON.stringify(latest)!==JSON.stringify(target))throw new ConfigRequestError('CONFLICT');
      dispatched=true;await config({op:'delete_profile',id:target.id});setDeletion(undefined);setDraft(blank());clearSecrets();await reload();onChanged?.();setMessage('所选保存配置已删除；现有连接和日志保持。');
    }catch(error){const uncertain=dispatched&&(!(error instanceof ConfigRequestError)||error.uncertain);setDeletion({profile:target,uncertain});setMessage(uncertain?'删除结果不明，请只读核对；未自动重试。':error instanceof Error?error.message:'删除未完成，请刷新后核对。');}
    finally{deleteFlight.current=false;setBusy(false);}
  }
  async function checkDeletion(){if(!deletion||deleteFlight.current)return;deleteFlight.current=true;setBusy(true);try{const data=await readConfiguration();const exists=data.profiles.some(p=>p.id===deletion.profile.id);setFolders(data.folders);setProfiles(data.profiles);setDeletion(undefined);if(!exists)setDraft(blank());onChanged?.();setMessage(exists?'原配置仍存在；未重放删除。请核对后重新选择操作。':'原配置已不存在；未重放删除。');}catch{setMessage('读取配置失败，请稍后只读核对；未重试删除。');}finally{deleteFlight.current=false;setBusy(false);}}
  const filtered = profiles.filter(profile => (filter === '*' || (profile.folder_id ?? '') === filter) && profile.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="config-panel" aria-label="连接配置">
    <div className="config-heading"><h2>连接配置</h2><button onClick={() => { clearSecrets(); close(); }}>关闭配置</button></div>
    <p className="config-notice">保存配置不会建立连接。已保存的 UTF-8 SSH2 配置可在“SSH2 连接”面板手动连接。SSH1/串口入口继续实施。</p>
    <div className="config-message" role="status" aria-label="配置状态">{message}</div>
    {deletion&&<section className="notice-error" aria-label="删除保存配置确认"><strong>删除保存配置“{deletion.profile.name}”？</strong><p>{deletion.profile.settings.protocol.toUpperCase()} · {'host' in deletion.profile.settings?`${deletion.profile.settings.host}:${deletion.profile.settings.port}`:deletion.profile.settings.port}</p><small>仅删除此配置（ID：{deletion.profile.id}）。不关闭现有连接，不删除日志或共享凭据记录。</small><div className="config-actions">{deletion.uncertain?<button ref={deleteControl} disabled={busy} onClick={()=>void checkDeletion()}>只读核对删除结果</button>:<button ref={deleteControl} disabled={busy} onClick={()=>void deleteSelected()}>确认删除此配置</button>}<button disabled={busy} onClick={()=>setDeletion(undefined)}>取消删除</button></div></section>}
    <div hidden={!!deletion}><div className="config-layout">
      <aside>
        <label>目录筛选<select aria-label="目录筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="*">全部目录</option>{options}</select></label>
        <label>搜索配置<input aria-label="搜索配置" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <ul className="profile-list">{filtered.map(profile => <li key={profile.id}><button className={draft.id === profile.id ? 'selected' : ''} onClick={() => { clearSecrets(); setDraft(edit(profile)); }}>{profile.name}<small>{profile.settings.protocol.toUpperCase()} · {profile.credential_missing ? '凭据引用缺失' : profile.credential_ref ? '有凭据引用' : '无凭据引用'}</small></button></li>)}</ul>
        <div className="config-actions"><button disabled={busy || !ready} onClick={() => { clearSecrets(); setDraft({ ...blank(), folder: filter === '*' ? '' : filter }); }}>新建配置</button><button disabled={busy} onClick={() => void run(async () => {}, '配置已刷新')}>刷新配置</button></div>
        <form aria-label="目录编辑" onSubmit={event => { event.preventDefault(); void run(async () => { await config({ op: 'save_folder', folder: folderDraft }); }, '目录已保存'); }}>
          <fieldset disabled={busy || !ready}><legend>目录管理</legend>
            <label>编辑目录<select aria-label="编辑目录" value={folders.some(f => f.id === folderDraft.id) ? folderDraft.id : ''} onChange={event => setFolderDraft(folders.find(folder => folder.id === event.target.value) ?? { id: crypto.randomUUID(), parent_id: null, name: '' })}><option value="">新目录</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folderName(folder)}</option>)}</select></label>
            <label>目录名称<input aria-label="目录名称" required maxLength={128} value={folderDraft.name} onChange={event => setFolderDraft({ ...folderDraft, name: event.target.value })} /></label>
            <label>父目录<select aria-label="父目录" value={folderDraft.parent_id ?? ''} onChange={event => setFolderDraft({ ...folderDraft, parent_id: event.target.value || null })}>{options}</select></label>
            <div className="config-actions"><button type="submit">保存目录</button><button type="button" disabled={!folders.some(f => f.id === folderDraft.id)} onClick={() => void run(async () => { await config({ op: 'delete_folder', id: folderDraft.id }); setFolderDraft({ id: crypto.randomUUID(), parent_id: null, name: '' }); }, '目录已删除')}>删除目录</button></div>
          </fieldset>
        </form>
      </aside>
      <form className="profile-form" aria-label="配置编辑" onSubmit={event => void save(event)}>
        <fieldset disabled={busy || !ready}><legend>{current ? '编辑配置' : '新建配置'}</legend>
          <div className="form-grid">
            <label>配置名称<input aria-label="配置名称" required maxLength={128} value={draft.name} onChange={event => change('name', event.target.value)} /></label>
            <label>所属目录<select aria-label="所属目录" value={draft.folder} onChange={event => change('folder', event.target.value)}>{options}</select></label>
            <label>协议<select aria-label="协议" value={draft.protocol} onChange={event => { clearSecrets(); change('protocol', event.target.value as Draft['protocol']); }}><option value="ssh2">SSH2</option><option value="ssh1">SSH1（显式开启）</option><option value="serial">SERIAL</option></select></label>
            <label>编码<select aria-label="编码" value={draft.encoding} onChange={event => change('encoding', event.target.value as Encoding)}><option value="utf8">UTF-8</option><option value="gbk">GBK</option><option value="gb18030">GB18030</option></select></label>
            {draft.protocol !== 'serial' ? <>
              <label>主机<input aria-label="主机" required maxLength={253} value={draft.host} onChange={event => change('host', event.target.value)} /></label>
              <label>端口<input aria-label="端口" type="number" required min={1} max={65535} value={draft.port} onChange={event => change('port', Number(event.target.value))} /></label>
              <label>用户名<input aria-label="用户名" required maxLength={128} autoComplete="off" value={draft.username} onChange={event => change('username', event.target.value)} /></label>
              {draft.protocol === 'ssh2' && <label>认证方式<select aria-label="认证方式" value={draft.auth} onChange={event => { clearSecrets(); change('auth', event.target.value as Auth); }}><option value="password">密码</option><option value="public_key">私钥与口令</option><option value="keyboard_interactive">交互认证</option></select></label>}
              {draft.protocol === 'ssh1' && <label className="check"><input aria-label="显式开启SSH1" type="checkbox" required checked={draft.ssh1} onChange={event => change('ssh1', event.target.checked)} />明确启用 SSH1；不从 SSH2 自动降级</label>}
            </> : <>
              <label>串口标识<input aria-label="串口标识" required pattern="[Cc][Oo][Mm][0-9]+" value={draft.serialPort} placeholder="COM89" onChange={event => change('serialPort', event.target.value)} /></label>
              <label>波特率<input aria-label="波特率" required type="number" min={1} max={4294967295} value={draft.baud} onChange={event => change('baud', Number(event.target.value))} /></label>
              <label>数据位<select aria-label="数据位" value={draft.bits} onChange={event => change('bits', Number(event.target.value))}>{[5, 6, 7, 8].map(bits => <option key={bits}>{bits}</option>)}</select></label>
              <label>停止位<select aria-label="停止位" value={draft.stopBits} onChange={event => change('stopBits', Number(event.target.value))}><option>1</option><option>2</option></select></label>
              <label>校验<select aria-label="校验" value={draft.parity} onChange={event => change('parity', event.target.value as Draft['parity'])}><option value="none">无</option><option value="odd">奇</option><option value="even">偶</option></select></label>
              <label>流控<select aria-label="流控" value={draft.flow} onChange={event => change('flow', event.target.value as Draft['flow'])}><option value="none">无</option><option value="software">软件</option><option value="hardware">硬件</option></select></label>
              <label className="check"><input aria-label="打开时DTR" type="checkbox" checked={draft.dtr} onChange={event => change('dtr', event.target.checked)} />打开时 DTR</label>
              {draft.flow !== 'hardware' ? <label className="check"><input aria-label="打开时RTS" type="checkbox" checked={draft.rts} onChange={event => change('rts', event.target.checked)} />打开时 RTS</label> : <p>RTS 将由硬件流控驱动管理。</p>}
            </>}
          </div>
          {draft.protocol !== 'serial' && <fieldset><legend>凭据</legend><p>{current?.credential_missing ? '此配置的凭据记录缺失，请重新输入或移除引用。恢复配置不会恢复密码或私钥。' : current?.credential_ref ? '此配置有保存的凭据引用；不会回填秘密。' : '此配置没有保存的凭据引用。'}</p>
            <label>凭据操作<select aria-label="凭据操作" value={credential} onChange={event => { setPassword(''); setKeyPath(''); setPassphrase(''); setCredential(event.target.value as typeof credential); }}><option value="keep">保留现有引用 / 暂不保存</option><option value="clear">移除此配置的凭据引用</option><option value="replace">保存新凭据</option></select></label>
            {credential === 'replace' && (draft.protocol === 'ssh2' && draft.auth === 'public_key' ? <><label>本地私钥文件<input aria-label="本地私钥文件" required autoComplete="off" placeholder="C:\keys\id_ed25519" value={keyPath} onChange={event => setKeyPath(event.target.value)} /><small>仅本地盘的普通文件，服务读取并加密保存；文件内容不进入页面。</small></label><label>私钥口令<input aria-label="私钥口令" type="password" autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label></> : <label>新密码<input aria-label="新密码" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /><small>允许显式保存空密码。</small></label>)}
            <small>移除引用不删除其他配置或备份可能使用的密文。保存、切换或关闭后清空新输入。</small>
          </fieldset>}
          <div className="config-actions"><button type="submit">保存配置</button><button type="button" disabled={!current} onClick={() => { clearSecrets(); setDraft({ ...draft, id: crypto.randomUUID(), name: `${draft.name} 副本` }); setMessage('已准备副本，不携带凭据；按需重新输入后保存。'); }}>复制配置</button><button type="button" disabled={!current} onClick={() => {if(current){clearSecrets();setDeletion({profile:current,uncertain:false});}}}>删除配置</button></div>
        </fieldset>
      </form>
    </div>
    <HostKeysPanel key={managementEpoch} />
    <CredentialsPanel key={`credentials-${managementEpoch}`} />
    <ArchivesPanel directory={location} usable={ready} restored={async () => { clearSecrets();setDraft(blank());setFolderDraft({id:crypto.randomUUID(),parent_id:null,name:''});await reload();setManagementEpoch(value=>value+1);setMessage('配置已从备份恢复；没有连接或重放输入。');await onRestored(); }} />
    <p className="data-location">数据目录：{location || '读取失败时请重新启动检查启动目录'}</p></div>
  </section>;
}
