import { useRef } from 'react';

export function SplitDivider({direction,ratio,change}:{direction:'horizontal'|'vertical';ratio:number;change(value:number):void}) {
  const offset = useRef(0);
  const columns = direction==='horizontal';
  function adjust(value:number){change(Math.max(20,Math.min(80,value)));}
  return <div className="split-divider" role="separator" aria-label="调整窗格大小"
    aria-orientation={columns?'vertical':'horizontal'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={ratio}
    tabIndex={0}
    onPointerDown={event=>{
      if(!event.isPrimary||event.button!==0)return;
      const rect=event.currentTarget.getBoundingClientRect();
      offset.current=columns?event.clientX-rect.left:event.clientY-rect.top;
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      if(!event.currentTarget.hasPointerCapture(event.pointerId))return;
      const grid=event.currentTarget.parentElement!.getBoundingClientRect();
      const handle=event.currentTarget.getBoundingClientRect();
      const offsetInGrid=columns?event.clientX-grid.left:event.clientY-grid.top;
      const available=columns?grid.width-handle.width:grid.height-handle.height;
      if(available>0)adjust(Math.round((offsetInGrid-offset.current)*100/available));
    }}
    onKeyDown={event=>{
      const before=columns?'ArrowLeft':'ArrowUp',after=columns?'ArrowRight':'ArrowDown';
      if(event.key!==before&&event.key!==after&&event.key!=='Home'&&event.key!=='End')return;
      event.preventDefault();
      adjust(event.key==='Home'?20:event.key==='End'?80:ratio+(event.key===before?-5:5));
    }}/>
}
