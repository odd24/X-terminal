import { useEffect, useState } from 'react';
import { config, type CredentialInfo, type CredentialPreview } from './config-api';
export function CredentialsPanel() {
  const [entries, setEntries] = useState<CredentialInfo[]>([]);
  const [id, setId] = useState('');
  const [preview, setPreview] = useState<CredentialPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('正在读取凭据元数据');
  async function read() {
    const all: CredentialInfo[] = []; let revision: string | null = null; let offset = 0;
    for (;;) {
      const reply = await config({ op: 'credentials_page', revision, offset });
      if (reply.result !== 'credentials_page') throw new Error('凭据列表响应不匹配。');
      all.push(...reply.entries); revision = reply.revision;
      if (reply.next_offset === null) return all;
      offset = reply.next_offset;
    }
  }
  function apply(all: CredentialInfo[]) { setEntries(all); setId(previous => all.some(entry => entry.id === previous) ? previous : all[0]?.id ?? ''); setPreview(undefined); setConfirmed(false); }
  useEffect(() => { let disposed = false; void read().then(all => { if (!disposed) { apply(all); setMessage('凭据元数据已加载'); } }).catch(error => { if (!disposed) setMessage(error instanceof Error ? error.message : '读取失败。'); }).finally(() => { if (!disposed) setBusy(false); }); return () => { disposed = true; }; }, []);
  async function action(operation: () => Promise<string>) {
    setBusy(true); setMessage('正在核对凭据引用');
    try { setMessage(await operation()); }
    catch (error) { setPreview(undefined); setMessage(error instanceof Error ? error.message : '操作失败，未自动重试。'); }
    finally { setBusy(false); setConfirmed(false); }
  }
  return <fieldset disabled={busy}>
    <legend>保存凭据与孤立项整理</legend>
    <p>只列引用，不显示密码或私钥。替换、移除引用和删除配置会保留原凭据。可逐项检查并遗忘没有当前配置或受管理备份引用的记录。</p>
    <div aria-label="凭据整理状态" role="status">{message}</div>
    <label>保存的凭据<select aria-label="保存的凭据" value={id} onChange={event => { setId(event.target.value); setPreview(undefined); setConfirmed(false); }}>
      {!entries.length && <option value="">尚无保存凭据</option>}
      {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.id} · 当前配置引用 {entry.current_profiles}</option>)}
    </select></label>
    <div className="config-actions"><button type="button" onClick={() => void action(async () => { apply(await read()); return '凭据元数据已加载'; })}>刷新凭据列表</button><button type="button" disabled={!id} onClick={() => void action(async () => { const reply = await config({ op: 'inspect_credential', id }); if (reply.result !== 'credential_preview') throw new Error('凭据检查响应不匹配。'); setPreview(reply); setEntries(previous => previous.map(entry => entry.id === reply.id ? { ...entry, current_profiles: reply.current_profiles } : entry)); return '凭据引用已核对'; })}>检查选中凭据</button></div>
    {preview && <>
      <p aria-label="凭据引用预览">当前配置引用 {preview.current_profiles} · 受管理备份引用 {preview.backup_profiles}</p>
      <p>仍有引用时不能遗忘，请先在配置中移除引用，或在确认无需保留后删除对应备份。检查仅覆盖此目录的当前配置及 artifacts 内配置备份；其他副本不在核对范围。遗忘后无法从配置备份找回秘密，不影响已执行的远程动作。</p>
      <label className="check"><input aria-label="确认遗忘凭据" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />确认遗忘选中凭据，不再用于其他副本</label>
      <button type="button" disabled={!confirmed || preview.current_profiles !== 0 || preview.backup_profiles !== 0} onClick={() => void action(async () => { await config({ op: 'forget_credential', id: preview.id, revision: preview.revision }); apply(await read()); return '选中凭据已遗忘'; })}>遗忘选中凭据</button>
    </>}
  </fieldset>;
}
