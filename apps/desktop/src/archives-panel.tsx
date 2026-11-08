import { useEffect, useState } from 'react';
import { config, type ArchiveInfo, type BackupPreview } from './config-api';
const identity = (entry: ArchiveInfo) => `${entry.kind}:${entry.id}`;
export function ArchivesPanel({ directory, usable, restored }: { directory: string; usable: boolean; restored(): Promise<void> }) {
  const [entries, setEntries] = useState<ArchiveInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<BackupPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('正在读取备份列表');
  const current = entries.find(entry => identity(entry) === selected);
  function apply(all: ArchiveInfo[]) { setEntries(all); setSelected(previous => all.some(entry => identity(entry) === previous) ? previous : all[0] ? identity(all[0]) : ''); }
  async function read() { const reply = await config({ op: 'archives' }); if (reply.result !== 'archives') throw new Error('副本列表响应不匹配。'); apply(reply.entries); }
  useEffect(() => { let disposed = false; void config({ op: 'archives' }).then(reply => { if (!disposed && reply.result === 'archives') { apply(reply.entries); setMessage('备份列表已加载'); } }).catch(error => { if (!disposed) setMessage(error instanceof Error ? error.message : '读取失败。'); }).finally(() => { if (!disposed) setBusy(false); }); return () => { disposed = true; }; }, []);
  async function action(operation: () => Promise<string>) {
    setBusy(true); setMessage('正在处理副本…');
    try { const result = await operation(); await read(); setMessage(result); }
    catch (error) { setMessage(`操作未完成：${error instanceof Error ? error.message : '请求失败，未自动重试。'}`); }
    finally { setBusy(false); setConfirmed(false); setDeleteConfirmed(false); }
  }
  async function create(backup: boolean) {
    await action(async () => {
      const reply = await config({ op: backup ? 'create_backup' : 'export_config' });
      if (reply.result !== 'artifact') throw new Error('副本创建响应不匹配。');
      setSelected(identity(reply.artifact)); setPreview(undefined);
      return `${backup ? '配置备份' : '便携导出'}已保存：${directory}\\artifacts\\${reply.artifact.filename}`;
    });
  }
  async function inspect() {
    if (current?.kind !== 'backup') return;
    await action(async () => { const reply = await config({ op: 'inspect_backup', id: current.id }); if (reply.result !== 'backup_preview') throw new Error('备份预览响应不匹配。'); setPreview(reply); return '备份验证完成，请核对预览后确认。'; });
  }
  async function restore(newDirectory: boolean) {
    if (!preview || !confirmed) return;
    await action(async () => {
      if (newDirectory) {
        const reply = await config({ op: 'recover_backup', id: preview.id, digest: preview.digest });
        if (reply.result !== 'recovered') throw new Error('新目录恢复响应不匹配。');
        setPreview(undefined);
        return `恢复目录已准备：${directory}\\recovered-${reply.directory_id}。原配置文件未修改；新目录未复制凭据，${reply.missing_credentials} 个配置需要重新输入凭据。开发预览版可用 --data-dir 指定此目录启动。`;
      }
      if (!preview.current_revision) throw new Error('当前配置不可用，请恢复到新目录。');
      const reply = await config({ op: 'restore_backup', id: preview.id, digest: preview.digest, current_revision: preview.current_revision });
      if (reply.result !== 'restored') throw new Error('恢复响应不匹配。');
      setPreview(undefined); await restored();
      return `当前配置已恢复；原配置副本为 ${reply.safety_backup.filename}。${reply.missing_credentials} 个配置缺少凭据。已有会话未改变，没有重连或重放输入。`;
    });
  }
  return <fieldset className="archives" disabled={busy}>
    <legend>配置导出与备份恢复</legend>
    <p>便携 JSON 不含凭据引用或主机信任；配置备份含引用、信任记录与桌面偏好，不含密码、私钥或凭据库。恢复不会重新连接或发送输入。</p>
    <div aria-label="备份状态" role="status">{message}</div>
    <div className="config-actions"><button type="button" disabled={!usable} onClick={() => void create(false)}>导出便携配置</button><button type="button" disabled={!usable} onClick={() => void create(true)}>创建配置备份</button><button type="button" onClick={() => void action(async () => { setPreview(undefined); return '备份列表已刷新'; })}>刷新副本列表</button></div>
    <label>已保存副本<select aria-label="已保存副本" value={selected} onChange={event => { setSelected(event.target.value); setPreview(undefined); setConfirmed(false); setDeleteConfirmed(false); }}>
      {!entries.length && <option value="">尚无副本</option>}
      {entries.map(entry => <option key={identity(entry)} value={identity(entry)}>{entry.kind === 'backup' ? '配置备份' : '便携导出'} · {new Date(entry.modified_ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {entry.filename}</option>)}
    </select></label>
    {current && <p className="data-location">文件：{directory}\\artifacts\\{current.filename}（{current.bytes} 字节）</p>}
    <div className="config-actions"><button type="button" disabled={current?.kind !== 'backup'} onClick={() => void inspect()}>预览选中备份</button></div>
    {preview && <div className="backup-preview">
      <p aria-label="备份预览">目录 {preview.folders} · 配置 {preview.profiles} · 主机密钥 {preview.host_keys} · 工作区布局 {preview.workspaces} · 缺少或当前不能核对的凭据引用 {preview.missing_credentials}</p>
      <p aria-label="备份桌面偏好">桌面偏好：主题 {{ dark: '深色', light: '浅色', system: '跟随系统' }[preview.preferences.theme]} · 终端配色 {{ follow_theme: '跟随应用主题', black_green: '黑底绿字', black_white: '黑底白字' }[preview.preferences.terminal_palette]} · 字体 {preview.preferences.terminal_font === 'consolas' ? 'Consolas' : 'Cascadia Mono'} · 字号 {preview.preferences.font_size} · Ctrl+C选区复制 {preview.preferences.ctrl_c_copy ? '开' : '关'} · Ctrl+V粘贴 {preview.preferences.ctrl_v_paste ? '开' : '关'} · 右键粘贴 {preview.preferences.right_click_paste ? '开' : '关'}</p>
      <p>配置样例：{preview.sample_profiles.join('，') || '无'}</p>
      <label className="check"><input aria-label="确认恢复备份" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对上述备份，确认恢复其配置、主机信任、桌面偏好与工作区布局；不恢复凭据文件或自动打开布局</label>
      <div className="config-actions"><button type="button" disabled={!confirmed || !usable || !preview.current_revision} onClick={() => void restore(false)}>替换当前配置</button><button type="button" disabled={!confirmed} onClick={() => void restore(true)}>恢复到新目录</button></div>
      <small>替换前会保存当前库副本。当前库损坏或版本不支持时，只能创建新目录，原文件保持不动。</small>
    </div>}
    <label className="check"><input aria-label="确认删除副本" type="checkbox" disabled={!current} checked={deleteConfirmed} onChange={event => setDeleteConfirmed(event.target.checked)} />确认删除选中的副本文件</label>
    <button type="button" disabled={!current || !deleteConfirmed} onClick={() => void action(async () => { if (!current) return ''; await config({ op: 'delete_archive', id: current.id, kind: current.kind }); setPreview(undefined); return '副本已删除'; })}>删除选中副本</button>
  </fieldset>;
}
