export type PaneIdentity={connection_id:string;generation:number;protocol:string};
export type PaneLive=PaneIdentity&{state:string};
export type PaneKey='first'|'second';
export type PaneSlot={key:PaneKey;requested:string;binding?:PaneIdentity;pending:boolean;retired:boolean;expectedGeneration?:number};
const equal=(a:PaneIdentity|undefined,b:PaneIdentity|undefined)=>!!a&&!!b&&a.connection_id===b.connection_id&&a.generation===b.generation&&a.protocol===b.protocol;
const empty=(key:PaneKey):PaneSlot=>({key,requested:'',pending:false,retired:false});
/** Window-only presentation. Every explicit route change invalidates unsent input. */
export class PaneLayout{
 private value:PaneSlot[]=[empty('first')];
 owner='';active:PaneKey='first';direction:'single'|'horizontal'|'vertical'='single';epoch=0;
 get slots(){return this.value.map(s=>({...s,binding:s.binding&&{...s.binding}}));}
 get current(){return this.slots.find(s=>s.key===this.active)!;}
 retain(owner:string,live:readonly PaneLive[],fulfill=true){let changed=false;
  if(owner!==this.owner){this.owner=owner;this.value=[empty('first')];this.active='first';this.direction='single';this.epoch++;changed=true;}
  for(const s of this.value){
   if(s.pending&&fulfill){const found=live.find(c=>c.connection_id===s.requested&&(s.expectedGeneration===undefined||c.generation===s.expectedGeneration));if(found){s.binding={connection_id:found.connection_id,generation:found.generation,protocol:found.protocol};s.pending=false;s.retired=false;changed=true;}}
   else if(s.binding&&!s.retired&&!live.some(c=>equal(c,s.binding))){s.retired=true;this.epoch++;changed=true;}
  }return changed;
 }
 select(id:string,current?:PaneLive,expectedGeneration?:number){const existing=id&&this.value.find(s=>s.requested===id);if(existing)this.active=existing.key;
  const s=this.value.find(s=>s.key===this.active)!;s.requested=id;s.expectedGeneration=expectedGeneration;s.pending=!!id;s.retired=false;if(!id)s.binding=undefined;else if(current&&current.connection_id===id&&(expectedGeneration===undefined||current.generation===expectedGeneration)){s.binding={connection_id:current.connection_id,generation:current.generation,protocol:current.protocol};s.pending=false;}this.epoch++;
 }
 focus(key:PaneKey){if(!this.value.some(s=>s.key===key))return false;if(this.active!==key){this.active=key;this.epoch++;}return true;}
 split(owner:string,first:PaneLive,second:PaneLive,direction:'horizontal'|'vertical'){
  if(!owner||owner!==this.owner||!equal(this.current.binding,first)||this.current.retired||this.current.pending||first.state!=='CONNECTED'||second.state!=='CONNECTED'||first.connection_id===second.connection_id||!['SSH2','SERIAL'].includes(first.protocol)||!['SSH2','SERIAL'].includes(second.protocol)||!['horizontal','vertical'].includes(direction))throw new Error('请选择两个不同且仍已连接的SSH或串口会话。');
  const retained=this.value.find(s=>s.key===this.active)!;this.value=[retained,{key:this.active==='first'?'second':'first',requested:second.connection_id,binding:{connection_id:second.connection_id,generation:second.generation,protocol:second.protocol},pending:false,retired:false}];this.direction=direction;this.epoch++;
 }
 restore(owner:string,first:PaneLive,second:PaneLive,direction:'horizontal'|'vertical',active:PaneIdentity,preserveSlots=false){
  if(!owner||owner!==this.owner||first.connection_id===second.connection_id||first.state!=='CONNECTED'||second.state!=='CONNECTED'||![first,second].every(c=>['SSH2','SERIAL'].includes(c.protocol))||!['horizontal','vertical'].includes(direction)||!equal(active,first)&&!equal(active,second))throw new Error('布局连接已变化，未恢复分屏。');
  const make=(key:PaneKey,c:PaneLive):PaneSlot=>({key,requested:c.connection_id,binding:{connection_id:c.connection_id,generation:c.generation,protocol:c.protocol},pending:false,retired:false});
  const existing=(connection:PaneLive)=>preserveSlots?this.value.find(slot=>!slot.pending&&!slot.retired&&equal(slot.binding,connection))?.key:undefined;
  const firstKey=existing(first)??(existing(second)==='first'?'second':'first');
  const secondKey=firstKey==='first'?'second':'first';
  this.value=[make(firstKey,first),make(secondKey,second)];this.active=equal(active,first)?firstKey:secondKey;this.direction=direction;this.epoch++;
 }
 collapse(keep:PaneKey=this.active){const s=this.value.find(s=>s.key===keep);if(!s)return false;this.value=[s];this.active=keep;this.direction='single';this.epoch++;return true;}
 remove(target:PaneIdentity){const s=this.value.find(s=>equal(s.binding,target));if(!s)return false;
  if(this.value.length===2){this.value=this.value.filter(p=>p.key!==s.key);this.active=this.value[0].key;this.direction='single';}else this.value=[empty(s.key)];this.epoch++;return true;
 }
}
