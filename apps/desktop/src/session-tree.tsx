import { useEffect, useRef, useState } from 'react';
import { readConfiguration, type Folder, type Profile } from './config-api';
import { ContextMenu } from './ui';

export function revealProfileConnectionFocus(target: HTMLElement) {
  if (!(target instanceof HTMLButtonElement)) return;
  requestAnimationFrame(() => {
    const summary = target.parentElement;
    if (!summary?.matches('.profile-summary') || document.activeElement !== target || !target.matches(':focus-visible')) return;
    const style = getComputedStyle(target);
    const margin = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
    const bounds = target.getBoundingClientRect();
    const top = summary.getBoundingClientRect().top + summary.clientTop;
    const bottom = top + summary.clientHeight;
    // Browser focus scrolling can expose the button while leaving its outline outside the clip.
    if (bounds.top - margin < top) summary.scrollTop -= Math.ceil(top - bounds.top + margin);
    else if (bounds.bottom + margin > bottom) summary.scrollTop += Math.ceil(bounds.bottom + margin - bottom);
  });
}

export function SessionTree({ revision, connect, configure, loaded, connecting=false, ssh1Preview }: { revision: number; connect(profile: Profile, configRevision: string): void; configure(id?:string,action?:'edit'|'delete'): void; loaded(profiles: Profile[]): void; connecting?:boolean; ssh1Preview:boolean }) {
  const [configRevision, setConfigRevision] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu,setMenu]=useState<{id:string;x:number;y:number;anchor:HTMLElement}>();
  const mounted = useRef(false);
  const loading = useRef(false);
  async function refresh() {
    if (loading.current) return;
    loading.current = true; setBusy(true);
    try {
      const result = await readConfiguration();
      if (mounted.current) { setFolders(result.folders); setProfiles(result.profiles); setConfigRevision(result.revision); loaded(result.profiles); setMessage(''); }
    } catch (error) { if (mounted.current) { setConfigRevision(''); setMessage((error as Error).message); } }
    finally { loading.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [revision]);
  const profile = profiles.find(item => item.id === selected);
  const menuProfile=menu&&profiles.find(p=>p.id===menu.id);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (item: Profile) => `${item.name} ${item.settings.protocol} ${'host' in item.settings ? item.settings.host : item.settings.port}`.toLocaleLowerCase().includes(needle);
  const canConnect = (item: Profile) => !connecting && (item.settings.protocol !== 'ssh1'
    || (ssh1Preview && item.settings.explicitly_enabled && !!configRevision && !busy));
  const openProfile = (item: Profile) => { if (canConnect(item)) connect(item, configRevision); };
  function leaf(item: Profile) {
    return <li key={item.id}><button data-profile-id={item.id} className={selected === item.id ? 'selected' : ''} aria-pressed={selected === item.id} title={`${item.name} · ${item.settings.protocol.toUpperCase()}`} onClick={() => setSelected(item.id)} onDoubleClick={() => openProfile(item)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();event.currentTarget.focus();setSelected(item.id);setMenu({id:item.id,x:event.clientX,y:event.clientY,anchor:event.currentTarget});}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const r=event.currentTarget.getBoundingClientRect();setSelected(item.id);setMenu({id:item.id,x:r.left,y:r.bottom,anchor:event.currentTarget});}}}>{item.name}{item.settings.protocol==='ssh1'?' · SSH1':''}</button></li>;
  }
  function branch(parent: string | null, visited = new Set<string>()) {
    const children=folders.filter(item=>item.parent_id===parent&&!visited.has(item.id));
    return <ul className="session-tree-list">{children.map(folder=>{const open=expanded[folder.id]??!!needle,empty=!folders.some(f=>f.parent_id===folder.id)&&!profiles.some(p=>p.folder_id===folder.id);return <li key={folder.id} data-folder-id={folder.id}><button className="tree-folder" aria-expanded={open} onClick={()=>setExpanded(value=>({...value,[folder.id]:!open}))}><span aria-hidden="true">{open?'▾':'▸'} </span>{folder.name}{empty&&<span className="tree-folder-hint">（空）</span>}</button>{open&&<>{empty?<p className="tree-empty">此目录暂无配置</p>:branch(folder.id,new Set([...visited,folder.id]))}</>}</li>;})}{profiles.filter(item => item.folder_id === parent && matches(item)).map(leaf)}</ul>;
  }
  return <>
    <div className="config-heading"><h2>会话配置</h2><button disabled={busy} onClick={() => void refresh()}>刷新会话树</button></div>
    <label className="tree-search">搜索<input aria-label="搜索会话配置" value={query} onChange={event => {setQuery(event.target.value);setExpanded({});}} placeholder="名称、协议或主机" /></label>
    <div className="tree-scroll" aria-label="会话配置树"><small className="tree-root-label">根目录</small>{branch(null)}{!profiles.length && <p>尚无配置。<button onClick={()=>configure()}>新建连接配置</button></p>}</div>
    {message && <p role="status">{message}</p>}
    <section className="profile-summary" aria-label="配置详情"><h2>配置详情</h2>{profile ? <><strong>{profile.name}</strong><p>{profile.settings.protocol.toUpperCase()} · {'host' in profile.settings ? `${profile.settings.host}:${profile.settings.port}` : profile.settings.port}</p>{profile.settings.protocol === 'ssh1' ? <small>{ssh1Preview ? 'SSH1 是可能不安全的旧协议，每次连接均需明确选择。' : '当前构建未启用 SSH1 本机预览。'}</small> : <small>单击只选中；双击或右键“连接”会新建独立会话，快速重复操作只发起一次。</small>}<button disabled={!canConnect(profile)} onClick={() => openProfile(profile)}>连接选中配置</button></> : <p>单击配置查看详情；双击或右键连接。</p>}</section>
    {menu&&menuProfile&&<ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} close={()=>setMenu(undefined)}><small>{menuProfile.name}</small><button role="menuitem" disabled={!canConnect(menuProfile)} onClick={()=>{setMenu(undefined);openProfile(menuProfile);}}>连接</button><button role="menuitem" onClick={()=>{setMenu(undefined);configure(menuProfile.id,'edit');}}>编辑</button><button role="menuitem" onClick={()=>{setMenu(undefined);configure(menuProfile.id,'delete');}}>删除</button></ContextMenu>}
  </>;
}
