import { Fragment, useEffect, useRef, useState, type PointerEvent, type RefObject, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GroupConnection, TabGroup } from './tab-groups';
import { locateTabDrop, type TabDrop } from './tab-drag';
type Connection=GroupConnection&{state:string};
type TabLabel = {text:string; instance?:string};

function describeTabs(tabs:Connection[],name:(connection:Connection)=>string) {
  const byName=new Map<string,string[]>();
  const labels=new Map<string,TabLabel>();
  for(const connection of tabs){
    const text=name(connection);
    const ids=byName.get(text)??[];
    ids.push(connection.connection_id);
    byName.set(text,ids);
    labels.set(connection.connection_id,{text});
  }
  for(const [text,ids] of byName){
    if(ids.length<2)continue;
    for(const id of ids){
      const compact=id.slice(-6).toUpperCase();
      // A collision uses the full distinct identity rather than confusing two tabs.
      const instance=ids.some(other=>other!==id&&other.slice(-6).toUpperCase()===compact)?id.toUpperCase():compact;
      labels.set(id,{text,instance});
    }
  }
  return labels;
}

export function SessionTabs({tabs,groups,groupOf,owner,selected,list,name,badge,select,close,pending,assign,onDrop}:{tabs:Connection[];groups:TabGroup[];groupOf(id:string):string;owner:string;selected:string;list:RefObject<HTMLDivElement|null>;name(c:Connection):string;badge(c:Connection):string|undefined;select(id:string):void;close?(c:Connection):void;pending(c:Connection):boolean;assign(target:GroupConnection,group:string):void;onDrop?(source:Connection,destination:TabDrop):void}){
  const labels=describeTabs(tabs,name);
  const sections=groups.length?[{id:'',name:'未分组'},...groups]:[{id:'',name:''}];
  function drop(event:DragEvent,group:string){event.preventDefault();const raw=event.dataTransfer.getData('application/x-shared-terminal-tab');if(raw.length>512)return;try{const t=JSON.parse(raw);if(t.owner!==owner)return;const live=tabs.find(c=>c.connection_id===t.connection_id&&c.generation===t.generation&&c.protocol===t.protocol);if(live)assign(live,group);}catch{/* unrelated/corrupt drag data never becomes an action */}}
  const gesture = useRef<{ source:Connection; owner:string; pointer:number; x:number; y:number; moving:boolean }>(undefined);
  const frame = useRef(0);
  const ignoreClick = useRef(false);
  const [preview,setPreview] = useState<{id:string; destination?:TabDrop}>();
  useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
  useEffect(()=>{
    const current=gesture.current;
    if(!current||current.owner===owner&&tabs.some(tab=>tab.connection_id===current.source.connection_id&&tab.generation===current.source.generation))return;
    gesture.current=undefined;
    cancelAnimationFrame(frame.current);
    setPreview(undefined);
  },[tabs,owner]);

  function start(event:PointerEvent<HTMLButtonElement>, source:Connection) {
    if (!onDrop || !event.isPrimary || event.button!==0) return;
    ignoreClick.current=false;
    gesture.current={source:{...source},owner,pointer:event.pointerId,x:event.clientX,y:event.clientY,moving:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function scrollRail() {
    const current=gesture.current, rail=list.current;
    if (!current?.moving || !rail) return;
    const bounds=rail.getBoundingClientRect();
    if(current.y>=bounds.top&&current.y<bounds.bottom&&current.x>=bounds.left&&current.x<bounds.right){
      const delta=current.x<bounds.left+24?-8:current.x>bounds.right-24?8:0;
      const before=rail.scrollLeft;
      rail.scrollLeft+=delta;
      if(before!==rail.scrollLeft)setPreview({id:current.source.connection_id,destination:locateTabDrop(current.x,current.y,rail)});
    }
    frame.current=requestAnimationFrame(scrollRail);
  }
  function move(event:PointerEvent<HTMLButtonElement>) {
    const current=gesture.current, rail=list.current;
    if(!current||current.pointer!==event.pointerId||!rail)return;
    if(!current.moving){
      if(Math.hypot(event.clientX-current.x,event.clientY-current.y)<6)return;
      current.moving=true;
      frame.current=requestAnimationFrame(scrollRail);
    }
    current.x=event.clientX;current.y=event.clientY;
    setPreview({id:current.source.connection_id,destination:locateTabDrop(current.x,current.y,rail)});
  }
  function finish(event:PointerEvent<HTMLButtonElement>, commit:boolean) {
    const current=gesture.current;
    if(!current||current.pointer!==event.pointerId)return;
    gesture.current=undefined;
    cancelAnimationFrame(frame.current);
    if(!current.moving)return;
    ignoreClick.current=true;
    setPreview(undefined);
    if(!commit||current.owner!==owner||!list.current)return;
    const destination=locateTabDrop(event.clientX,event.clientY,list.current);
    if(destination)onDrop?.(current.source,destination);
  }
  const destination=preview?.destination;
  return <div className="tab-tools"><div role="tablist" aria-label="连接标签" ref={list} data-tab-drag={preview?'true':undefined} onWheel={event=>{
    const rail=event.currentTarget;
    if(event.deltaX||event.shiftKey||rail.scrollWidth<=rail.clientWidth)return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?rail.clientWidth:1;
    rail.scrollLeft+=event.deltaY*scale;
  }}>{sections.map(group=><Fragment key={group.id}>
    {groups.length>0&&<span className="tab-group-marker" data-group-id={group.id} data-drop-group={destination?.kind==='group'&&destination.group===group.id?true:undefined} title="可将标签拖到这里；只移动显示分组" onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-shared-terminal-tab'))e.preventDefault();}} onDrop={e=>drop(e,group.id)}>{group.name}</span>}
    {tabs.filter(c=>groupOf(c.connection_id)===group.id).map(connection=>{
      const id=connection.connection_id, label=labels.get(id)!, status=badge(connection);
      const insertion=destination?.kind==='insert'&&destination.anchor===id&&preview?.id!==id?(destination.after?'after':'before'):undefined;
      return <div className="connection-tab" key={id} data-drag-source={preview?.id===id?true:undefined} data-insertion={insertion}
        draggable={!!onDrop} onDragStart={event=>{
          if(event.isTrusted){event.preventDefault();return;}
          event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-shared-terminal-tab',JSON.stringify({owner,...connection}));
        }}>
        <button role="tab" data-connection-id={id} tabIndex={selected===id?0:-1}
          onPointerDown={event=>start(event,connection)} onPointerMove={move}
          onPointerUp={event=>finish(event,true)} onPointerCancel={event=>finish(event,false)} onLostPointerCapture={event=>finish(event,false)}
          onKeyDown={event=>{
            if(event.key==='Escape'&&gesture.current){event.preventDefault();gesture.current=undefined;ignoreClick.current=true;cancelAnimationFrame(frame.current);setPreview(undefined);return;}
            const current=tabs.findIndex(c=>c.connection_id===id);
            const next=event.key==='ArrowRight'?(current+1)%tabs.length:event.key==='ArrowLeft'?(current+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
            if(next<0)return;
            event.preventDefault();select(tabs[next].connection_id);
            Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]')??[]).find(e=>e.dataset.connectionId===tabs[next].connection_id)?.focus({preventScroll:true});
          }} aria-selected={selected===id} aria-label={[label.text,label.instance&&`会话 ${label.instance}`,status].filter(Boolean).join(" · ")}
          title={`${label.text} · ${connection.protocol} · ${connection.state} · ${id} / ${connection.generation}`}
          onClick={event=>{if(event.detail&&ignoreClick.current){ignoreClick.current=false;return;}select(id);}}>
          <span className="tab-label">{label.text}</span>{label.instance&&<span className="tab-instance">#{label.instance}</span>}
          {status&&<span className="tab-log-badge" title={status} aria-label={status}>{status.startsWith('●')?'●':'◌'}</span>}
        </button>
        {close&&<button aria-label={`关闭标签 ${id}`} disabled={pending(connection)} onClick={()=>close({...connection})}>×</button>}
      </div>;
    })}
    </Fragment>)}</div>
    {destination?.kind==='split'&&createPortal(<div className="tab-split-preview" data-edge={destination.edge} aria-hidden="true"
      style={{left:destination.bounds.left,top:destination.bounds.top,width:destination.bounds.width,height:destination.bounds.height}}>
      <span>{destination.edge==='left'||destination.edge==='right'?'左右分屏':'上下分屏'}</span>
    </div>,document.body)}
    {destination?.kind==='detach'&&createPortal(<div className="tab-detach-preview" aria-hidden="true">松开后移到独立窗口</div>,document.body)}
  </div>;
}
