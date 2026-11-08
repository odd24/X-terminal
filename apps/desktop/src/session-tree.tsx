import { useEffect, useRef, useState } from 'react';
import { readConfiguration, type Folder, type Profile } from './config-api';
import { ContextMenu } from './ui';

export function SessionTree({ revision, connect, configure, loaded, connecting=false }: { revision: number; connect(profile: Profile): void; configure(): void; loaded(profiles: Profile[]): void; connecting?:boolean }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
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
      if (mounted.current) { setFolders(result.folders); setProfiles(result.profiles); loaded(result.profiles); setMessage(''); }
    } catch (error) { if (mounted.current) setMessage((error as Error).message); }
    finally { loading.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [revision]);
  const profile = profiles.find(item => item.id === selected);
  const menuProfile=menu&&profiles.find(p=>p.id===menu.id);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (item: Profile) => `${item.name} ${item.settings.protocol} ${'host' in item.settings ? item.settings.host : item.settings.port}`.toLocaleLowerCase().includes(needle);
  function leaf(item: Profile) {
    return <li key={item.id}><button className={selected === item.id ? 'selected' : ''} aria-pressed={selected === item.id} title={`${item.name} · ${item.settings.protocol.toUpperCase()}`} onClick={() => setSelected(item.id)} onDoubleClick={() => connect(item)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();event.currentTarget.focus();setSelected(item.id);setMenu({id:item.id,x:event.clientX,y:event.clientY,anchor:event.currentTarget});}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const r=event.currentTarget.getBoundingClientRect();setSelected(item.id);setMenu({id:item.id,x:r.left,y:r.bottom,anchor:event.currentTarget});}}}>{item.name}<small>{item.settings.protocol.toUpperCase()}</small></button></li>;
  }
  function branch(parent: string | null, visited = new Set<string>()) {
    return <ul className="session-tree-list">{folders.filter(item => item.parent_id === parent && !visited.has(item.id)).map(folder => <li key={folder.id}><details open={needle ? true : undefined}><summary>{folder.name}</summary>{branch(folder.id, new Set([...visited, folder.id]))}</details></li>)}{profiles.filter(item => item.folder_id === parent && matches(item)).map(leaf)}</ul>;
  }
  return <>
    <div className="config-heading"><h2>会话配置</h2><button disabled={busy} onClick={() => void refresh()}>刷新会话树</button></div>
    <label className="tree-search">搜索<input aria-label="搜索会话配置" value={query} onChange={event => setQuery(event.target.value)} placeholder="名称、协议或主机" /></label>
    <div className="tree-scroll" aria-label="会话配置树">{branch(null)}{!profiles.length && <p>尚无配置。<button onClick={configure}>新建连接配置</button></p>}</div>
    {message && <p role="status">{message}</p>}
    <section className="profile-summary" aria-label="配置详情"><h2>配置详情</h2>{profile ? <><strong>{profile.name}</strong><p>{profile.settings.protocol.toUpperCase()} · {'host' in profile.settings ? `${profile.settings.host}:${profile.settings.port}` : profile.settings.port}</p><small>单击只选中；双击或右键“连接”会新建独立会话，快速重复操作只发起一次。</small><button disabled={connecting} onClick={() => connect(profile)}>连接选中配置</button></> : <p>单击配置查看详情；双击或右键连接。</p>}</section>
    {menu&&menuProfile&&<ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} close={()=>setMenu(undefined)}><small>{menuProfile.name}</small><button role="menuitem" disabled={connecting} onClick={()=>{setMenu(undefined);connect(menuProfile);}}>连接</button></ContextMenu>}
  </>;
}
