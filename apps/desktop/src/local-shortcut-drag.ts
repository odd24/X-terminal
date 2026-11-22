import {useEffect,useRef,useState,type PointerEvent,type RefObject} from 'react';

type Target={id:string;after:boolean;horizontal:boolean};
type Gesture={id:string;pinned:boolean;revision:string|null;selected:ReadonlySet<string>;pointer:number;x:number;y:number;moving:boolean};

export function useShortcutDrag(body:RefObject<HTMLDivElement|null>, revision:string|null, enabled:boolean, selection:ReadonlySet<string>,
  drop:(gesture:Gesture,target:Target)=>void) {
  const current=useRef<Gesture|undefined>(undefined);
  const frame=useRef(0);
  const [preview,setPreview]=useState<Target&{source:string}>();
  const latest=useRef({revision,enabled,drop});latest.current={revision,enabled,drop};
  function hit(gesture:Gesture):Target|undefined{
    const item=document.elementFromPoint(gesture.x,gesture.y)?.closest<HTMLElement>('[data-shortcut-id]');
    const id=item?.dataset.shortcutId;
    if(!item||!id||!body.current?.contains(item)||gesture.selected.has(id)||item.dataset.pinned!==String(gesture.pinned))return;
    const bounds=item.getBoundingClientRect();
    const rail=getComputedStyle(item.parentElement!).gridTemplateColumns;
    const horizontal=rail.split(' ').length>1;
    const after=horizontal?gesture.x>bounds.x+bounds.width/2:gesture.y>bounds.y+bounds.height/2;
    return {id,after,horizontal};
  }
  function render(gesture:Gesture){
    const target=hit(gesture);
    if(!target){setPreview(undefined);return;}
    setPreview(previous=>previous?.id===target.id&&previous.after===target.after&&previous.horizontal===target.horizontal
      ?previous:{...target,source:gesture.id});
  }
  function scroll(){
    const gesture=current.current, panel=body.current;
    if(!gesture?.moving||!panel)return;
    const bounds=panel.getBoundingClientRect();
    if(gesture.x>=bounds.left&&gesture.x<bounds.right&&gesture.y>=bounds.top&&gesture.y<bounds.bottom){
      const delta=gesture.y<bounds.top+24?-8:gesture.y>bounds.bottom-24?8:0;
      const before=panel.scrollTop;
      panel.scrollTop+=delta;
      if(panel.scrollTop!==before)render(gesture);
    }
    frame.current=requestAnimationFrame(scroll);
  }
  function cancel(){
    current.current=undefined;
    cancelAnimationFrame(frame.current);
    setPreview(undefined);
  }
  useEffect(()=>{if(current.current&&(current.current.revision!==revision||!enabled))cancel();},[revision,enabled]);
  useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
  function finish(event:PointerEvent<HTMLButtonElement>, commit:boolean){
    const gesture=current.current;
    if(!gesture||gesture.pointer!==event.pointerId)return;
    cancel();
    if(!commit||!gesture.moving||!latest.current.enabled||gesture.revision!==latest.current.revision)return;
    const target=hit({...gesture,x:event.clientX,y:event.clientY});
    if(target)latest.current.drop(gesture,target);
  }
  function bindings(id:string,isPinned:boolean){
    return {
      onPointerDown(event:PointerEvent<HTMLButtonElement>){
        if(!enabled||!event.isPrimary||event.button!==0)return;
        event.preventDefault();
        event.currentTarget.focus({preventScroll:true});
        event.currentTarget.setPointerCapture(event.pointerId);
        current.current={id,pinned:isPinned,revision,selected:selection.has(id)?new Set(selection):new Set([id]),
          pointer:event.pointerId,x:event.clientX,y:event.clientY,moving:false};
      },
      onPointerMove(event:PointerEvent<HTMLButtonElement>){
        const gesture=current.current;
        if(!gesture||gesture.pointer!==event.pointerId)return;
        if(!gesture.moving){
          if(Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<6)return;
          gesture.moving=true;
          frame.current=requestAnimationFrame(scroll);
        }
        gesture.x=event.clientX;gesture.y=event.clientY;
        render(gesture);
      },
      onPointerUp:(event:PointerEvent<HTMLButtonElement>)=>finish(event,true),
      onPointerCancel:(event:PointerEvent<HTMLButtonElement>)=>finish(event,false),
      onLostPointerCapture:(event:PointerEvent<HTMLButtonElement>)=>finish(event,false),
    };
  }
  return {bindings,cancel,preview,active:()=>!!current.current};
}
