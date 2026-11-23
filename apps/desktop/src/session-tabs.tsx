import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type DragEvent } from 'react';
import type { GroupConnection, TabGroup } from './tab-groups';
import type { SessionDrag } from './session-drag';
import type { TabRecording } from './tab-logging';
import { ContextMenu, ControlIcon } from './ui';
type Connection=GroupConnection&{state:string};
type LocalTabItem={id:string;label:string;title:string;pending:boolean;select():void;close():void;copy?():void;copyOnDoubleClick?():void};
export const localDragSource=(id:string):Connection=>({connection_id:id,generation:0,protocol:'LOCAL',state:'CONNECTED'});
export function TabCloseButton({label,disabled,close}:{label:string;disabled?:boolean;close():void}){
  return <button type="button" className="tab-close-button" aria-label={label} disabled={disabled} draggable={false} onClick={close}>
    <ControlIcon icon="close" />
  </button>;
}
export function SessionTabs({singlePane,tabs,groups,groupOf,owner,selected,name,recording,toggleRecording,select,close,pending,assign,drag,detached,copy,localTabs=[],order=[],endControls,children}:{singlePane:boolean;tabs:Connection[];groups:TabGroup[];groupOf(id:string):string;owner:string;selected:string;name(c:Connection):string;recording(c:Connection):TabRecording|undefined;toggleRecording(c:Connection):void;select(id:string):void;close?(c:Connection):void;pending(c:Connection):boolean;assign(target:GroupConnection,group:string):void;drag:SessionDrag;detached:boolean;copy(c:Connection,owner:string):void;localTabs?:LocalTabItem[];order?:string[];endControls?:ReactNode;children?:ReactNode}){
  const list=useRef<HTMLDivElement>(null);
  const [menu,setMenu]=useState<{connection:Connection;owner:string;x:number;y:number;anchor:HTMLElement}>();
  const source=menu?.owner===owner?tabs.find(c=>c.connection_id===menu.connection.connection_id&&c.generation===menu.connection.generation&&c.protocol===menu.connection.protocol):undefined;
  const copyAvailable=!!source&&source.state==='CONNECTED'&&['SSH2','SERIAL'].includes(source.protocol)&&!pending(source);
  const localSource=menu?.connection.protocol==='LOCAL'?localTabs.find(tab=>tab.id===menu.connection.connection_id):undefined;
  function showMenu(connection:Connection,anchor:HTMLElement,x:number){
    setMenu({connection:{...connection},owner,x,y:anchor.getBoundingClientRect().bottom,anchor});
  }
  const orderKey=order.join(',')+';'+tabs.map(tab=>tab.connection_id+':'+groupOf(tab.connection_id)).join(',');
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
  },[selected,orderKey]);
  const sections=groups.length?[{id:'',name:'未分组'},...groups]:[{id:'',name:''}];
  function drop(event:DragEvent,group:string){event.preventDefault();const raw=event.dataTransfer.getData('application/x-shared-terminal-tab');if(raw.length>512)return;try{const t=JSON.parse(raw);if(t.owner!==owner)return;const live=tabs.find(c=>c.connection_id===t.connection_id&&c.generation===t.generation&&c.protocol===t.protocol);if(live)assign(live,group);}catch{/* unrelated/corrupt drag data never becomes an action */}}
  const {preview, bindings, cancelOnKey, allowedClick, allowedDoubleClick}=drag;
  const destination=preview?.destination;
  const connections=new Set(tabs.map(tab=>tab.connection_id));
  const localBefore=new Map<string,LocalTabItem[]>();
  const localById=new Map(localTabs.map(tab=>[tab.id,tab]));
  for(const id of order){
    const node=localById.get(id);
    if(!node)continue;
    const anchor=order.slice(order.indexOf(id)+1).find(other=>connections.has(other))??'';
    const nodes=localBefore.get(anchor)??[];
    nodes.push(node);
    localBefore.set(anchor,nodes);
  }
  function renderTab(connection:Connection,local?:LocalTabItem){
      const id=connection.connection_id, label=local?.label??name(connection), status=local?undefined:recording(connection);
      const insertion=destination?.kind==='insert'&&destination.anchor===id&&preview?.id!==id?(destination.after?'after':'before'):undefined;
      return <div className="connection-tab" key={id} data-drag-source={preview?.id===id?true:undefined} data-insertion={insertion}
        onMouseDown={event=>{if(event.button===2)event.preventDefault();}}
        onContextMenu={event=>{
          event.preventDefault();event.stopPropagation();
          const anchor=event.currentTarget.querySelector<HTMLElement>('[role="tab"]');
          if(anchor&&(!local||local.copy))showMenu(connection,anchor,event.clientX);
        }}
        onDragStart={event=>{
          if(event.isTrusted||local)return;
          event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-shared-terminal-tab',JSON.stringify({owner,...connection}));
        }}>
        <button role="tab" type="button" className={selected===id?'pane-focus':undefined} data-connection-id={id} tabIndex={local?undefined:selected===id?0:-1}
          {...bindings(connection)}
          onKeyDown={event=>{
            if(cancelOnKey(event))return;
            if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){
              if(!local||local.copy){event.preventDefault();showMenu(connection,event.currentTarget,event.currentTarget.getBoundingClientRect().left);}
              return;
            }
            if(local)return;
            const current=tabs.findIndex(c=>c.connection_id===id);
            const next=event.key==='ArrowRight'?(current+1)%tabs.length:event.key==='ArrowLeft'?(current+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
            if(next<0)return;
            event.preventDefault();select(tabs[next].connection_id);
            Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]')??[]).find(e=>e.dataset.connectionId===tabs[next].connection_id)?.focus({preventScroll:true});
          }} aria-selected={selected===id} aria-label={label}
          title={local?.title??`${label} · ${connection.protocol} · ${connection.state} · ${id} / ${connection.generation}`}
          onDoubleClick={event=>{
            if(!allowedDoubleClick(event))return;
            if(local){local.copyOnDoubleClick?.();return;}
            if(connection.state==='CONNECTED'&&['SSH2','SERIAL'].includes(connection.protocol)&&!pending(connection))copy(connection,owner);
          }}
          onClick={event=>{
            if(!allowedClick(event))return;
            if(local){local.select();return;}
            if(event.detail)event.currentTarget.focus({preventScroll:true});select(id);
          }}>
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
        {local?<TabCloseButton label={`关闭 ${label}`} disabled={local.pending} close={local.close}/>
          :close&&<TabCloseButton label={`关闭标签 ${id}`} disabled={pending(connection)} close={()=>close({...connection})}/>}
      </div>;
  }
  const renderLocals=(anchor:string)=>localBefore.get(anchor)?.map(local=>renderTab(localDragSource(local.id),local));
  return <div className="tab-tools pane-tab-bar"><div role="tablist" aria-label="连接标签" ref={list} data-tab-drag={preview?'true':undefined} onWheel={event=>{
    const rail=event.currentTarget;
    if(event.deltaX||event.shiftKey||rail.scrollWidth<=rail.clientWidth)return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?rail.clientWidth:1;
    rail.scrollLeft+=event.deltaY*scale;
  }}>{sections.map(group=><Fragment key={group.id}>
    {groups.length>0&&<span className="tab-group-marker" data-group-id={group.id} data-drop-group={destination?.kind==='group'&&destination.group===group.id?true:undefined} title="可将标签拖到这里；只移动显示分组" onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-shared-terminal-tab'))e.preventDefault();}} onDrop={e=>drop(e,group.id)}>{group.name}</span>}
    {tabs.filter(c=>groupOf(c.connection_id)===group.id).flatMap(connection=>[
      ...(renderLocals(connection.connection_id)??[]),renderTab(connection),
    ])}
    </Fragment>)}{renderLocals('')}</div>{children}
    {singlePane&&<div className="tab-lane-drag" aria-hidden="true" data-tauri-drag-region="" />}
    {endControls}
    {menu&&(source||localSource?.copy)&&<ContextMenu className="session-tab-menu" label="会话标签菜单"
      x={menu.x} y={menu.y} anchor={menu.anchor} close={()=>setMenu(undefined)}>
      <button type="button" role="menuitem" aria-disabled={localSource?!localSource.copy||localSource.pending:!copyAvailable} onClick={()=>{
        if(localSource){if(localSource.copy&&!localSource.pending){setMenu(undefined);localSource.copy();}return;}
        if(!copyAvailable)return;setMenu(undefined);copy(source,menu.owner);
      }}>{detached?'复制会话到主窗口':'复制会话'}</button>
      {source&&!copyAvailable&&<small>仅可复制仍在连接的 SSH2 或串口会话。</small>}
    </ContextMenu>}
  </div>;
}
