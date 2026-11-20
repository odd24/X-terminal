import { Fragment, type RefObject, type DragEvent } from 'react';
import type { GroupConnection, TabGroup } from './tab-groups';
import type { SessionDrag } from './session-drag';
type Connection=GroupConnection&{state:string};
export function SessionTabs({tabs,groups,groupOf,owner,selected,list,name,badge,select,close,pending,assign,drag,detached}:{tabs:Connection[];groups:TabGroup[];groupOf(id:string):string;owner:string;selected:string;list:RefObject<HTMLDivElement|null>;name(c:Connection):string;badge(c:Connection):string|undefined;select(id:string):void;close?(c:Connection):void;pending(c:Connection):boolean;assign(target:GroupConnection,group:string):void;drag:SessionDrag;detached:boolean}){
  const sections=groups.length?[{id:'',name:'未分组'},...groups]:[{id:'',name:''}];
  function drop(event:DragEvent,group:string){event.preventDefault();const raw=event.dataTransfer.getData('application/x-shared-terminal-tab');if(raw.length>512)return;try{const t=JSON.parse(raw);if(t.owner!==owner)return;const live=tabs.find(c=>c.connection_id===t.connection_id&&c.generation===t.generation&&c.protocol===t.protocol);if(live)assign(live,group);}catch{/* unrelated/corrupt drag data never becomes an action */}}
  const {preview, bindings, cancelOnKey, allowedClick}=drag;
  const destination=preview?.destination;
  return <div className="tab-tools"><div role="tablist" aria-label="连接标签" ref={list} data-tab-drag={preview?'true':undefined} onWheel={event=>{
    const rail=event.currentTarget;
    if(event.deltaX||event.shiftKey||rail.scrollWidth<=rail.clientWidth)return;
    const scale=event.deltaMode===1?16:event.deltaMode===2?rail.clientWidth:1;
    rail.scrollLeft+=event.deltaY*scale;
  }}>{sections.map(group=><Fragment key={group.id}>
    {groups.length>0&&<span className="tab-group-marker" data-group-id={group.id} data-drop-group={destination?.kind==='group'&&destination.group===group.id?true:undefined} title="可将标签拖到这里；只移动显示分组" onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-shared-terminal-tab'))e.preventDefault();}} onDrop={e=>drop(e,group.id)}>{group.name}</span>}
    {tabs.filter(c=>groupOf(c.connection_id)===group.id).map(connection=>{
      const id=connection.connection_id, label=name(connection), status=badge(connection);
      const insertion=destination?.kind==='insert'&&destination.anchor===id&&preview?.id!==id?(destination.after?'after':'before'):undefined;
      return <div className="connection-tab" key={id} data-drag-source={preview?.id===id?true:undefined} data-insertion={insertion}
        draggable={!detached} onDragStart={event=>{
          if(event.isTrusted){event.preventDefault();return;}
          event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-shared-terminal-tab',JSON.stringify({owner,...connection}));
        }}>
        <button role="tab" data-connection-id={id} tabIndex={selected===id?0:-1}
          {...bindings(connection)}
          onKeyDown={event=>{
            if(cancelOnKey(event))return;
            const current=tabs.findIndex(c=>c.connection_id===id);
            const next=event.key==='ArrowRight'?(current+1)%tabs.length:event.key==='ArrowLeft'?(current+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
            if(next<0)return;
            event.preventDefault();select(tabs[next].connection_id);
            Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]')??[]).find(e=>e.dataset.connectionId===tabs[next].connection_id)?.focus({preventScroll:true});
          }} aria-selected={selected===id} aria-label={[label,status].filter(Boolean).join(" · ")}
          title={`${label} · ${connection.protocol} · ${connection.state} · ${id} / ${connection.generation}`}
          onClick={event=>{if(allowedClick(event)){if(event.detail)event.currentTarget.focus({preventScroll:true});select(id);}}}>
          <span className="tab-label">{label}</span>
          {status&&<span className="tab-log-badge" title={status} aria-label={status} data-recording={status.startsWith('●')?'true':undefined} />}
        </button>
        {close&&<button aria-label={`关闭标签 ${id}`} disabled={pending(connection)} onClick={()=>close({...connection})}>×</button>}
      </div>;
    })}
    </Fragment>)}</div>
  </div>;
}
