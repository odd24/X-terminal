import type { TabEdge } from './tab-drag';

export type PaneIdentity={connection_id:string;generation:number;protocol:string};
export type PaneLive=PaneIdentity&{state:string};
export type PaneKey='first'|'second'|'third'|'fourth';
export type SplitAxis='horizontal'|'vertical';
export type PaneTree=PaneKey|{id:number;direction:SplitAxis;first:PaneTree;second:PaneTree};
const paneKeys:readonly PaneKey[]=['first','second','third','fourth'];
const leaves=(tree:PaneTree):PaneKey[]=>typeof tree==='string'?[tree]:[...leaves(tree.first),...leaves(tree.second)];
function replace(tree:PaneTree,key:PaneKey,next:PaneTree):PaneTree{
 return typeof tree==='string'?(tree===key?next:tree):{...tree,first:replace(tree.first,key,next),second:replace(tree.second,key,next)};
}
function without(tree:PaneTree,key:PaneKey):PaneTree|undefined{
 if(typeof tree==='string')return tree===key?undefined:tree;
 const first=without(tree.first,key),second=without(tree.second,key);
 return first&&second?{...tree,first,second}:first??second;
}
export type PaneSlot={key:PaneKey;instance:symbol;requested:string;binding?:PaneIdentity;pending:boolean;retired:boolean;expectedGeneration?:number};
const equal=(a:PaneIdentity|undefined,b:PaneIdentity|undefined)=>!!a&&!!b&&a.connection_id===b.connection_id&&a.generation===b.generation&&a.protocol===b.protocol;
const empty=(key:PaneKey,instance=Symbol()):PaneSlot=>({key,instance,requested:'',pending:false,retired:false});
const canSplit=(tab:PaneLive)=>tab.state==='CONNECTED'&&(tab.protocol==='SSH2'||tab.protocol==='SERIAL');
const axisFor=(edge:TabEdge):SplitAxis=>edge==='left'||edge==='right'?'horizontal':'vertical';
const leadingEdge=(edge:TabEdge)=>edge==='left'||edge==='top';
/** Window-only presentation. Every explicit route change invalidates unsent input. */
export class PaneLayout{
 private value:PaneSlot[]=[empty('first')];
 private membership=new Map<string,PaneKey>();
 private nextSplit=0;
 tree:PaneTree='first';
 owner='';active:PaneKey='first';epoch=0;
 get direction(){return typeof this.tree==='string'?'single':this.tree.direction;}
 get slots(){return leaves(this.tree).map(key=>{const s=this.value.find(slot=>slot.key===key)!;return {...s,binding:s.binding&&{...s.binding}};});}
 hasPane(key:PaneKey){return this.value.some(slot=>slot.key===key);}
  paneInstance(key:PaneKey){return this.value.find(slot=>slot.key===key)?.instance;}
 paneOf(id:string){return this.membership.get(id)??leaves(this.tree)[0];}
 get current(){return this.slots.find(s=>s.key===this.active)!;}
 placeLocal(id:string,key:PaneKey){this.membership.set(id,key);}
  placeConnection(id:string,key:PaneKey){this.membership.set(id,key);}
 forgetLocal(id:string){this.membership.delete(id);}
 addPane(target:PaneKey,direction:SplitAxis,leading:boolean,relocate?:PaneKey){
  const key=relocate??paneKeys.find(key=>!this.value.some(slot=>slot.key===key));
  if(!key||!this.value.some(slot=>slot.key===target))return;
  const tree=relocate?without(this.tree,relocate):this.tree;
  if(!tree||relocate===target)return;
  if(!relocate)this.value.push(empty(key));
  this.tree=replace(tree,target,{id:++this.nextSplit,direction,first:leading?key:target,second:leading?target:key});
  this.epoch++;
  return key;
 }
 splitLocalDrop(id:string,target:PaneKey,edge:TabEdge,sourceHasPeers:boolean){
  const origin=this.paneOf(id);
  if(!this.hasPane(target)||origin===target&&!sourceHasPeers)return;
  const relocate=origin!==target&&!sourceHasPeers?origin:undefined;
  return this.addPane(target,axisFor(edge),leadingEdge(edge),relocate)??'full';
 }
 moveLocalDrop(id:string,target:PaneKey,sourceHasPeers:boolean){
  const origin=this.paneOf(id);
  if(origin===target||!this.hasPane(target))return;
  this.placeLocal(id,target);
  if(!sourceHasPeers)this.closePane(origin,target);
 }
 splitDropBesideLocal(tab:PaneLive,target:PaneKey,edge:TabEdge,visible:readonly PaneLive[],local:readonly string[]){
  if(!this.hasPane(target)||!canSplit(tab))return;
  const origin=this.paneOf(tab.connection_id);
  const sourceHasPeers=local.some(id=>this.paneOf(id)===origin)||
    visible.some(peer=>peer.connection_id!==tab.connection_id&&this.paneOf(peer.connection_id)===origin);
  const relocate=origin!==target&&!sourceHasPeers?origin:undefined;
  return this.addPane(target,axisFor(edge),leadingEdge(edge),relocate)??'full';
 }
 splitRemoteDrop(owner:string,target:PaneKey,tab:PaneLive,edge:TabEdge,visible:readonly PaneLive[],local:readonly string[]){
  const slot=this.value.find(candidate=>candidate.key===target);
  if(!slot||!owner||this.owner!==owner||!visible.some(candidate=>equal(candidate,tab)))return false;
  if(!canSplit(tab))return 'missing-peer';
  const peers=visible.filter(peer=>this.paneOf(peer.connection_id)===target);
  const bound=peers.find(peer=>equal(slot.binding,peer));
  const other=bound&&bound.connection_id!==tab.connection_id&&canSplit(bound)
    ?bound:peers.find(peer=>peer.connection_id!==tab.connection_id&&canSplit(peer));
  if(!other)return 'missing-peer';
  const selectFirst=bound?.connection_id!==other.connection_id;
  if(!selectFirst&&(slot.pending||slot.retired))return false;
  const key=this.splitKey(target,tab,visible,local);
  if(!key)return false;
  const previous=this.active;
  this.focus(target);
  if(selectFirst)this.select(other.connection_id,other);
  this.applySplit(target,key,tab,axisFor(edge),leadingEdge(edge),visible,local);
  this.focus(previous);
  return true;
 }
 retain(owner:string,live:readonly PaneLive[],fulfill=true){let changed=false;
  if(owner!==this.owner){this.owner=owner;this.value=[empty('first')];this.active='first';this.tree='first';this.membership.clear();this.epoch++;changed=true;}
  for(const s of this.value){
   if(s.pending&&fulfill){const found=live.find(c=>c.connection_id===s.requested&&(s.expectedGeneration===undefined||c.generation===s.expectedGeneration));if(found){s.binding={connection_id:found.connection_id,generation:found.generation,protocol:found.protocol};s.pending=false;s.retired=false;changed=true;}}
   else if(s.binding&&!s.retired&&!live.some(c=>equal(c,s.binding))){s.retired=true;this.epoch++;changed=true;}
  }return changed;
 }
 select(id:string,current?:PaneLive,expectedGeneration?:number){if(id){this.active=this.membership.get(id)??this.active;this.membership.set(id,this.active);}
  const s=this.value.find(s=>s.key===this.active)!;s.requested=id;s.expectedGeneration=expectedGeneration;s.pending=!!id;s.retired=false;if(!id)s.binding=undefined;else if(current&&current.connection_id===id&&(expectedGeneration===undefined||current.generation===expectedGeneration)){s.binding={connection_id:current.connection_id,generation:current.generation,protocol:current.protocol};s.pending=false;}this.epoch++;
 }
 focus(key:PaneKey){if(!this.value.some(s=>s.key===key))return false;if(this.active!==key){this.active=key;this.epoch++;}return true;}
 split(owner:string,first:PaneLive,second:PaneLive,direction:SplitAxis,leading=false,visible:readonly PaneLive[]=[],local:readonly string[]=[]){
  if(!owner||owner!==this.owner||!equal(this.current.binding,first)||this.current.retired||this.current.pending||!canSplit(first)||!canSplit(second)||first.connection_id===second.connection_id||!['horizontal','vertical'].includes(direction))throw new Error('请选择两个不同且仍已连接的SSH或串口会话。');
  const target=this.active,key=this.splitKey(target,second,visible,local);
  if(!key)throw new Error('已达到四窗格上限。');
  this.applySplit(target,key,second,direction,leading,visible,local);
 }
 private splitKey(target:PaneKey,second:PaneLive,visible:readonly PaneLive[],local:readonly string[]){
  const origin=this.paneOf(second.connection_id);
  const relocated=origin!==target&&this.value.find(slot=>slot.key===origin
    && equal(slot.binding,second)&&!slot.pending&&!slot.retired)
    &&!local.some(id=>this.paneOf(id)===origin)
    &&!visible.some(tab=>tab.connection_id!==second.connection_id&&this.paneOf(tab.connection_id)===origin);
  return relocated?origin:paneKeys.find(key=>!this.value.some(slot=>slot.key===key));
 }
 private applySplit(target:PaneKey,key:PaneKey,second:PaneLive,direction:SplitAxis,leading:boolean,visible:readonly PaneLive[],local:readonly string[]){
  for(const tab of visible)if(!this.membership.has(tab.connection_id))this.membership.set(tab.connection_id,this.paneOf(tab.connection_id));
  const branch={id:++this.nextSplit,direction,first:leading?key:target,second:leading?target:key};
  if(this.hasPane(key)){
   this.tree=replace(without(this.tree,key)!,target,branch);
   this.epoch++;return;
  }
  this.move(second,key,visible,local);
  this.value.push(empty(key));
  this.tree=replace(this.tree,target,branch);
  this.focus(key);this.select(second.connection_id,second);this.focus(target);
 }
 restore(owner:string,first:PaneLive,second:PaneLive,direction:'horizontal'|'vertical',active:PaneIdentity,preserveSlots=false){
  if(!owner||owner!==this.owner||first.connection_id===second.connection_id||first.state!=='CONNECTED'||second.state!=='CONNECTED'||![first,second].every(c=>['SSH2','SERIAL'].includes(c.protocol))||!['horizontal','vertical'].includes(direction)||!equal(active,first)&&!equal(active,second))throw new Error('布局连接已变化，未恢复分屏。');
  const make=(key:PaneKey,c:PaneLive):PaneSlot=>({...empty(key),requested:c.connection_id,binding:{connection_id:c.connection_id,generation:c.generation,protocol:c.protocol}});
  const existing=(connection:PaneLive)=>preserveSlots?this.value.find(slot=>!slot.pending&&!slot.retired&&equal(slot.binding,connection))?.key:undefined;
  const firstKey=existing(first)??(existing(second)==='first'?'second':'first');
  const secondKey=firstKey==='first'?'second':'first';
  this.value=[make(firstKey,first),make(secondKey,second)];this.active=equal(active,first)?firstKey:secondKey;
  this.tree={id:++this.nextSplit,direction,first:firstKey,second:secondKey};
  this.membership.clear();this.membership.set(first.connection_id,firstKey);this.membership.set(second.connection_id,secondKey);this.epoch++;
 }
 collapse(keep:PaneKey=this.active){const s=this.value.find(s=>s.key===keep);if(!s)return false;this.value=[s];this.active=keep;this.tree=keep;this.membership.clear();if(s.requested)this.membership.set(s.requested,keep);this.epoch++;return true;}
 closePane(key:PaneKey, destination?:PaneKey){
  if(!this.value.some(slot=>slot.key===key))return false;
  const tree=without(this.tree,key);
  if(!tree)return false;
  this.tree=tree;this.value=this.value.filter(slot=>slot.key!==key);
  const keep=destination&&leaves(tree).includes(destination)?destination:leaves(tree)[0];
  for(const [id,pane] of this.membership)if(pane===key)this.membership.set(id,keep);
  if(this.active===key)this.active=keep;
  this.epoch++;return true;
 }
 move(tab:PaneLive,destination:PaneKey,visible:readonly PaneLive[],local:readonly string[]=[]){
  const origin=this.paneOf(tab.connection_id);
  if(origin===destination)return false;
  const previous=this.active;
  const selected=this.value.find(slot=>slot.key===origin)?.requested===tab.connection_id;
  this.membership.set(tab.connection_id,destination);
  const replacement=visible.find(next=>next.connection_id!==tab.connection_id&&this.paneOf(next.connection_id)===origin);
  if(selected&&replacement){this.focus(origin);this.select(replacement.connection_id,replacement);this.focus(previous);}
  if(selected&&!replacement&&local.some(id=>this.paneOf(id)===origin))
   this.value=this.value.map(slot=>slot.key===origin?empty(origin,slot.instance):slot);
  if(!replacement&&this.value.length>1&&!local.some(id=>this.paneOf(id)===origin))this.closePane(origin,destination);
  this.epoch++;return true;
 }
 remove(target:PaneIdentity,visible:readonly PaneLive[]=[],local:readonly string[]=[]){
  const key=this.paneOf(target.connection_id);
  const s=this.value.find(slot=>slot.key===key);
  if(!s||s.requested===target.connection_id&&!equal(s.binding,target))return false;
  this.membership.delete(target.connection_id);
  if(!equal(s.binding,target))return false;
  const replacement=visible.find(next=>next.connection_id!==target.connection_id&&this.paneOf(next.connection_id)===key);
  if(replacement){const previous=this.active;this.focus(key);this.select(replacement.connection_id,replacement);this.focus(previous);}
  else if(local.some(id=>this.paneOf(id)===key))this.value=this.value.map(slot=>slot.key===key?empty(key,slot.instance):slot);
  else if(!this.closePane(key))this.value=[empty(key,s.instance)];
  this.epoch++;return true;
 }
}
