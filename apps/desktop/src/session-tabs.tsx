import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type DragEvent } from 'react';
import type { GroupConnection, TabGroup } from './tab-groups';
import type { SessionDrag } from './session-drag';
import type { TabRecording } from './tab-logging';
type Connection=GroupConnection&{state:string};
export function SessionTabs({singlePane,tabs,groups,groupOf,owner,selected,name,recording,toggleRecording,select,close,pending,assign,drag,detached,copy,extraTabs,endControls,children}:{singlePane:boolean;tabs:Connection[];groups:TabGroup[];groupOf(id:string):string;owner:string;selected:string;name(c:Connection):string;recording(c:Connection):TabRecording|undefined;toggleRecording(c:Connection):void;select(id:string):void;close?(c:Connection):void;pending(c:Connection):boolean;assign(target:GroupConnection,group:string):void;drag:SessionDrag;detached:boolean;copy(c:Connection,owner:string):void;extraTabs?:ReactNode;endControls?:ReactNode;children?:ReactNode}){
  const list=useRef<HTMLDivElement>(null);
  const menuNode=useRef<HTMLDivElement>(null);
  const [menu,setMenu]=useState<{connection:Connection;owner:string;x:number;y:number;focus:HTMLElement|null}>();
  const source=menu?.owner===owner?tabs.find(c=>c.connection_id===menu.connection.connection_id&&c.generation===menu.connection.generation&&c.protocol===menu.connection.protocol):undefined;
  const copyAvailable=!!source&&source.state==='CONNECTED'&&['SSH2','SERIAL'].includes(source.protocol)&&!pending(source);
  const closeMenu=(restore:boolean)=>{setMenu(undefined);if(restore&&menu?.focus?.isConnected)menu.focus.focus({preventScroll:true});};
  useLayoutEffect(()=>{
    if(!menu||!menuNode.current)return;
    const node=menuNode.current, bounds=node.getBoundingClientRect();
    node.style.left=Math.max(8,Math.min(menu.x,innerWidth-bounds.width-8))+'px';
    node.style.top=Math.max(8,Math.min(menu.y,innerHeight-bounds.height-8))+'px';
    node.querySelector('button')?.focus({preventScroll:true});
  },[menu]);
  useEffect(()=>{
    if(!menu)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!menuNode.current?.contains(event.target))setMenu(undefined);};
    const dismiss=()=>setMenu(undefined);
    window.addEventListener('pointerdown',outside,true);
    window.addEventListener('resize',dismiss);
    window.addEventListener('blur',dismiss);
    return()=>{window.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',dismiss);window.removeEventListener('blur',dismiss);};
  },[menu]);
  function showMenu(connection:Connection,x:number,y:number){
    setMenu({connection:{...connection},owner,x,y,focus:document.activeElement instanceof HTMLElement?document.activeElement:null});
  }
  const order=tabs.map(tab=>tab.connection_id+':'+groupOf(tab.connection_id)).join(',');
  useLayoutEffect(()=>{
    const rail=list.current;
    const tab=Array.from(rail?.querySelectorAll<HTMLElement>('[role="tab"]')??[]).find(item=>item.dataset.connectionId===selected);
    if(!rail||!tab)return;
    const reveal=()=>{
      const viewport=rail.getBoundingClientRect(),bounds=(tab.parentElement??tab).getBoundingClientRect();
      if(bounds.left<viewport.left)rail.scrollLeft+=bounds.left-viewport.left;
      else if(bounds.right>viewport.right)rail.scrollLeft+=bounds.right-viewport.right;
    };
    reveal();const observer=new ResizeObserver(reveal);
    observer.observe(rail);return()=>observer.disconnect();
  },[selected,order]);
  const sections=groups.length?[{id:'',name:'未分组'},...groups]:[{id:'',name:''}];
  function drop(event:DragEvent,group:string){event.preventDefault();const raw=event.dataTransfer.getData('application/x-shared-terminal-tab');if(raw.length>512)return;try{const t=JSON.parse(raw);if(t.owner!==owner)return;const live=tabs.find(c=>c.connection_id===t.connection_id&&c.generation===t.generation&&c.protocol===t.protocol);if(live)assign(live,group);}catch{/* unrelated/corrupt drag data never becomes an action */}}
  const {preview, bindings, cancelOnKey, allowedClick}=drag;
  const destination=preview?.destination;
  return <div className="tab-tools pane-tab-bar"><div role="tablist" aria-label="连接标签" ref={list} data-tab-drag={preview?'true':undefined} onWheel={event=>{
    const rail=event.currentTarget;
    if(event.deltaX||event.shiftKey||rail.scrollWidth<=rail.clientWidth)return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?rail.clientWidth:1;
    rail.scrollLeft+=event.deltaY*scale;
  }}>{sections.map(group=><Fragment key={group.id}>
    {groups.length>0&&<span className="tab-group-marker" data-group-id={group.id} data-drop-group={destination?.kind==='group'&&destination.group===group.id?true:undefined} title="可将标签拖到这里；只移动显示分组" onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-shared-terminal-tab'))e.preventDefault();}} onDrop={e=>drop(e,group.id)}>{group.name}</span>}
    {tabs.filter(c=>groupOf(c.connection_id)===group.id).map(connection=>{
      const id=connection.connection_id, label=name(connection), status=recording(connection);
      const insertion=destination?.kind==='insert'&&destination.anchor===id&&preview?.id!==id?(destination.after?'after':'before'):undefined;
      return <div className="connection-tab" key={id} data-drag-source={preview?.id===id?true:undefined} data-insertion={insertion}
        onMouseDown={event=>{if(event.button===2)event.preventDefault();}}
        onContextMenu={event=>{event.preventDefault();event.stopPropagation();showMenu(connection,event.clientX,event.currentTarget.getBoundingClientRect().bottom);}}
        onDragStart={event=>{
          if(event.isTrusted){event.preventDefault();return;}
          event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-shared-terminal-tab',JSON.stringify({owner,...connection}));
        }}>
        <button role="tab" className={selected===id?'pane-focus':undefined} data-connection-id={id} tabIndex={selected===id?0:-1} draggable={!detached}
          {...bindings(connection)}
          onKeyDown={event=>{
            if(cancelOnKey(event))return;
            if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){
              event.preventDefault();const bounds=event.currentTarget.getBoundingClientRect();showMenu(connection,bounds.left,bounds.bottom);return;
            }
            const current=tabs.findIndex(c=>c.connection_id===id);
            const next=event.key==='ArrowRight'?(current+1)%tabs.length:event.key==='ArrowLeft'?(current+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
            if(next<0)return;
            event.preventDefault();select(tabs[next].connection_id);
            Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]')??[]).find(e=>e.dataset.connectionId===tabs[next].connection_id)?.focus({preventScroll:true});
          }} aria-selected={selected===id} aria-label={label}
          title={`${label} · ${connection.protocol} · ${connection.state} · ${id} / ${connection.generation}`}
          onClick={event=>{if(allowedClick(event)){if(event.detail)event.currentTarget.focus({preventScroll:true});select(id);}}}>
          <span className="tab-label">{label}</span>
        </button>
        {status&&<button type="button" key={`${owner}/${connection.protocol}/${connection.generation}`}
          className="tab-record-button" draggable={false} data-recording={status.state}
          aria-label={`${label} · ${status.state==='recording'?'记录中 · ':''}${status.label}`}
          aria-description={status.detail} aria-disabled={status.disabled||pending(connection)}
          title={status.label===status.detail?status.label:`${status.label} · ${status.detail}`}
          onMouseDown={event=>event.preventDefault()}
          onKeyDown={event=>{if(event.repeat&&(event.key==='Enter'||event.key===' '))event.preventDefault();}}
          onClick={event=>{if(!status.disabled&&!pending(connection)&&event.detail<2)toggleRecording(connection);}}>
          <span className="tab-record-icon" aria-hidden="true">{status.state==='unknown'?'?':status.state==='failed'?'!':status.state==='pending'?'…':''}</span>
        </button>}
        {close&&<button aria-label={`关闭标签 ${id}`} disabled={pending(connection)} onClick={()=>close({...connection})}>×</button>}
      </div>;
    })}
    </Fragment>)}{extraTabs}</div>{children}
    {singlePane&&<div className="tab-lane-drag" aria-hidden="true" data-tauri-drag-region="" />}
    {endControls}
    {menu&&source&&<div className="terminal-context-menu context-menu session-tab-menu" role="menu" aria-label="会话标签菜单" ref={menuNode}
      onKeyDown={event=>{if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.stopPropagation();closeMenu(true);}}}
      onContextMenu={event=>event.preventDefault()}>
      <button type="button" role="menuitem" aria-disabled={!copyAvailable} onClick={()=>{
        if(!copyAvailable)return;closeMenu(true);copy(source,menu.owner);
      }}>{detached?'复制会话到主窗口':'复制会话'}</button>
      {!copyAvailable&&<small>仅可复制仍在连接的 SSH2 或串口会话。</small>}
    </div>}
  </div>;
}
