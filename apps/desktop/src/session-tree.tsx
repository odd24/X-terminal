import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readConfiguration, type Folder, type Profile } from './config-api';
import { ProfileDeletionConfirmation, useProfileDeletion } from './profile-deletion';
import { ContextMenu, ControlIcon, Dialog, IconButton, ToolbarMenu } from './ui';

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

export function SessionTree({ revision, connect, configure, create, loaded, connecting=false, ssh1Preview, reveal, focusRevealed, onRevealed }: { revision: number; connect(profile: Profile, configRevision: string): void; configure(id?:string): void; create(protocol:'ssh2'|'serial',folder:string):void; loaded(profiles: Profile[]): void; connecting?:boolean; ssh1Preview:boolean; reveal?:string; focusRevealed:boolean; onRevealed():void }) {
  const [configRevision, setConfigRevision] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState('');
  const [selectedFolder,setSelectedFolder]=useState('');
  const [query, setQuery] = useState('');
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const [message, setMessage] = useState('');
  const [deletionMessage,setDeletionMessage]=useState('');
  const [busy, setBusy] = useState(false);
  const [menu,setMenu]=useState<{id:string;x:number;y:number;anchor:HTMLElement}>();
  const mounted = useRef(false);
  const loading = useRef(false);
  const refreshQueued = useRef(false);
  const list=useRef<HTMLDivElement>(null);
  const revealed=useRef<string|undefined>(undefined);
  const neighbors=useRef<string[]>([]);
  const returnFocus=useRef<string[]>(undefined);
  const deletion=useProfileDeletion(result=>{
    if(result.snapshot) {
      setFolders(result.snapshot.folders);
      setProfiles(result.snapshot.profiles);
      loaded(result.snapshot.profiles);
    } else {
      setProfiles(previous=>previous.filter(profile=>profile.id!==result.id));
    }
    setConfigRevision(result.revision);
    setDeletionMessage(result.message);
    returnFocus.current=result.exists?[result.id,...neighbors.current]:neighbors.current;
    void refresh();
  });
  useLayoutEffect(()=>{
    if(deletion.state||!returnFocus.current)return;
    const ids=returnFocus.current;
    returnFocus.current=undefined;
    const leaves=Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-profile-id]')??[]);
    const button=ids.map(id=>leaves.find(leaf=>leaf.dataset.profileId===id)).find(leaf=>leaf);
    setSelected(button?.dataset.profileId??'');
    if(!button)setSelectedFolder('');
    (button??list.current?.querySelector<HTMLButtonElement>('.tree-root-label'))?.focus();
  },[deletion.state]);
  function beginDelete(profile:Profile) {
    const rows=Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-profile-id]')??[]);
    const index=rows.findIndex(row=>row.dataset.profileId===profile.id);
    neighbors.current=[...rows.slice(index+1),...rows.slice(0,Math.max(0,index)).reverse()].map(row=>row.dataset.profileId!);
    setDeletionMessage('');
    setMenu(undefined);
    deletion.start(profile,configRevision);
  }
  function cancelDelete() {
    const state=deletion.state;
    if(!state||!deletion.cancel())return;
    returnFocus.current=[state.target.profile.id,...neighbors.current];
    setDeletionMessage(state.notice??'已取消删除。');
    if(state.mode==='failed')void refresh();
  }
  async function refresh() {
    if (loading.current) {refreshQueued.current=true;return;}
    loading.current = true; setBusy(true);
    try {
      const result = await readConfiguration();
      if (mounted.current) { setFolders(result.folders); setProfiles(result.profiles); setConfigRevision(result.revision); loaded(result.profiles); setMessage(''); }
    } catch (error) { if (mounted.current) { setConfigRevision(''); setMessage((error as Error).message); } }
    finally {
      loading.current=false;
      const again=refreshQueued.current;
      refreshQueued.current=false;
      if(mounted.current){
        if(again)void refresh();
        else setBusy(false);
      }
    }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [revision]);
  useLayoutEffect(()=>{
    if(!reveal){revealed.current=undefined;return;}
    const saved=profiles.find(item=>item.id===reveal);
    if(!saved)return;
    if(revealed.current!==reveal){
      revealed.current=reveal;
      const parents:Record<string,boolean>={};
      let folder=saved.folder_id;
      while(folder&&!parents[folder]){
        parents[folder]=true;
        folder=folders.find(item=>item.id===folder)?.parent_id??null;
      }
      setExpanded(previous=>({...previous,...parents}));
      setQuery('');
      setSelected(saved.id);
      setSelectedFolder(saved.folder_id??'');
    }
    if(!focusRevealed)return;
    const frame=requestAnimationFrame(()=>{
      if(document.querySelector('dialog:modal'))return;
      const button=Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-profile-id]')??[])
        .find(row=>row.dataset.profileId===reveal);
      if(!button)return;
      button.scrollIntoView({block:'nearest'});
      button.focus({preventScroll:true});
      onRevealed();
    });
    return ()=>cancelAnimationFrame(frame);
  },[reveal,profiles,folders,focusRevealed,onRevealed]);
  const profile = profiles.find(item => item.id === selected);
  const menuProfile=menu&&profiles.find(p=>p.id===menu.id);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (item: Profile) => `${item.name} ${item.settings.protocol} ${'host' in item.settings ? item.settings.host : item.settings.port}`.toLocaleLowerCase().includes(needle);
  const canConnect = (item: Profile) => !connecting && (item.settings.protocol !== 'ssh1'
    || (ssh1Preview && item.settings.explicitly_enabled && !!configRevision && !busy));
  const openProfile = (item: Profile) => { if (canConnect(item)) connect(item, configRevision); };
  function leaf(item: Profile) {
    return <li key={item.id}><button data-profile-id={item.id} className={selected === item.id ? 'selected' : ''} aria-pressed={selected === item.id} title={`${item.name} · ${item.settings.protocol.toUpperCase()}`} onClick={() => {setSelected(item.id);setSelectedFolder(item.folder_id??'');}} onDoubleClick={() => openProfile(item)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();event.currentTarget.focus();setSelected(item.id);setMenu({id:item.id,x:event.clientX,y:event.clientY,anchor:event.currentTarget});}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const r=event.currentTarget.getBoundingClientRect();setSelected(item.id);setMenu({id:item.id,x:r.left,y:r.bottom,anchor:event.currentTarget});}}}>{item.name}{item.settings.protocol==='ssh1'?' · SSH1':''}</button></li>;
  }
  function branch(parent: string | null, visited = new Set<string>()) {
    const children=folders.filter(item=>item.parent_id===parent&&!visited.has(item.id));
    return <ul className="session-tree-list">{children.map(folder=>{const open=expanded[folder.id]??!!needle,empty=!folders.some(f=>f.parent_id===folder.id)&&!profiles.some(p=>p.folder_id===folder.id);return <li key={folder.id} data-folder-id={folder.id}><button className="tree-folder" title={folder.name} aria-expanded={open} aria-current={!profile&&selectedFolder===folder.id?'true':undefined} onClick={()=>{setSelected('');setSelectedFolder(folder.id);setExpanded(value=>({...value,[folder.id]:!open}));}}><span aria-hidden="true">{open?'▾':'▸'} </span>{folder.name}{empty&&<span className="tree-folder-hint">（空）</span>}</button>{open&&<>{empty?<p className="tree-empty">此目录暂无配置</p>:branch(folder.id,new Set([...visited,folder.id]))}</>}</li>;})}{profiles.filter(item => item.folder_id === parent && matches(item)).map(leaf)}</ul>;
  }
  return <>
    <div className="config-heading"><h2>会话配置</h2><div className="tree-heading-actions"><ToolbarMenu className="tree-new-menu" summaryClassName="icon-button" label="新建会话配置" text={<ControlIcon icon="plus" />}>{(['ssh2','serial'] as const).map(protocol=><button key={protocol} onClick={()=>{const folder=profile?profile.folder_id??'':selectedFolder;create(protocol,folders.some(item=>item.id===folder)?folder:'');}}>{protocol==='ssh2'?'新建 SSH 配置':'新建串口配置'}</button>)}</ToolbarMenu><IconButton icon="refresh" label="刷新会话树" disabled={busy} onClick={() => void refresh()} /></div></div>
    <label className="tree-search"><input aria-label="搜索会话配置" value={query} onChange={event => {setQuery(event.target.value);setExpanded({});}} placeholder="名称、协议或主机" /></label>
    <div ref={list} className="tree-scroll" aria-label="会话配置树"><button type="button" className="tree-root-label" onClick={()=>{setSelected('');setSelectedFolder('');}}>根目录</button>{branch(null)}{!profiles.length && <p>尚无配置。<button onClick={()=>configure()}>新建连接配置</button></p>}</div>
    {message && <p role="status">{message}</p>}
    <p className="tree-deletion-status" role="status" aria-label="会话树配置状态">{deletionMessage}</p>
    <section className="profile-summary" aria-label="配置详情"><h2>配置详情</h2>{profile ? <><strong>{profile.name}</strong><p>{profile.settings.protocol.toUpperCase()} · {'host' in profile.settings ? `${profile.settings.host}:${profile.settings.port}` : profile.settings.port}</p>{profile.settings.protocol === 'ssh1' ? <small>{ssh1Preview ? 'SSH1 是可能不安全的旧协议，每次连接均需明确选择。' : '当前构建未启用 SSH1 本机预览。'}</small> : <small>单击只选中；双击或右键“连接”会新建独立会话，快速重复操作只发起一次。</small>}<button disabled={!canConnect(profile)} onClick={() => openProfile(profile)}>连接选中配置</button></> : <p>单击配置查看详情；双击或右键连接。</p>}</section>
    {menu&&menuProfile&&<ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} close={()=>setMenu(undefined)}><small>{menuProfile.name}</small><button role="menuitem" disabled={!canConnect(menuProfile)} onClick={()=>{setMenu(undefined);openProfile(menuProfile);}}>连接</button><button role="menuitem" onClick={()=>{setMenu(undefined);configure(menuProfile.id);}}>编辑</button><button role="menuitem" disabled={busy||!configRevision} onClick={()=>beginDelete(menuProfile)}>删除</button></ContextMenu>}
    {deletion.state&&<Dialog label="删除会话配置" close={cancelDelete} handleEscape><ProfileDeletionConfirmation
      deletion={deletion.state} onCancel={cancelDelete} onConfirm={()=>void deletion.confirm()} onCheck={()=>void deletion.check()}/></Dialog>}
  </>;
}
