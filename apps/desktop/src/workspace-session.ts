import type { Profile, Workspace } from './config-api';
import type { GroupConnection, TabGroup } from './tab-groups';
export type SplitCapture={direction:'horizontal'|'vertical';connections:readonly GroupConnection[]};
type SnapshotConnection=GroupConnection&{profile_id?:string};
export function copyWorkspace(w:Workspace):Workspace{return {id:w.id,name:w.name,groups:w.groups.map(g=>({id:g.id,name:g.name})),tabs:w.tabs.map(t=>({id:t.id,profile_id:t.profile_id,group_id:t.group_id})),selected_tab:w.selected_tab,navigation_open:w.navigation_open,split:w.split?{direction:w.split.direction,tabs:[w.split.tabs[0],w.split.tabs[1]]}:null};}
export function captureWorkspace(name:string,connections:readonly SnapshotConnection[],profiles:readonly Profile[],groups:TabGroup[],groupOf:(id:string)=>string,selected:string,navigation:boolean,view?:SplitCapture){
  let skipped=0;let selectedTab:string|null=null;
  const tabs:Workspace['tabs']=[],mapped=new Map<string,{connection:SnapshotConnection;tab:Workspace['tabs'][number]}>();
  for(const c of connections){const profile=profiles.find(p=>p.id===c.profile_id&&p.settings.protocol.toUpperCase()===c.protocol);if(!profile){skipped++;continue;}const id=crypto.randomUUID();const tab={id,profile_id:profile.id,group_id:groupOf(c.connection_id)||null};tabs.push(tab);mapped.set(c.connection_id,{connection:c,tab});if(c.connection_id===selected)selectedTab=id;}
  const candidates=view?.connections.map(c=>{const value=mapped.get(c.connection_id);return value&&value.connection.generation===c.generation&&value.connection.protocol===c.protocol?value.tab.id:undefined;});
  const split:Workspace['split']=view&&candidates?.length===2&&candidates[0]&&candidates[1]&&candidates[0]!==candidates[1]&&selectedTab&&candidates.includes(selectedTab)?{direction:view.direction,tabs:[candidates[0],candidates[1]]}:null;
  return {workspace:{id:crypto.randomUUID(),name:name.trim(),groups:groups.map(g=>({...g})),tabs,selected_tab:selectedTab,navigation_open:navigation,split} satisfies Workspace,skipped,splitSkipped:!!view&&!split};
}
// Bindings are window-only and never serialized into a Workspace.
export class WorkspaceSession {
  private value:Workspace|undefined;
  private owner='';
  private restoration:'pending'|'applied'|'cancelled'='cancelled';
  get splitState(){return this.restoration;}
  cancelSplit(force=false){if(force||this.restoration==='pending')this.restoration='cancelled';}
  cancelSplitFor(target:GroupConnection){if(this.value?.split?.tabs.some(t=>{const c=this.bindings.get(t);return c?.connection_id===target.connection_id&&c.generation===target.generation&&c.protocol===target.protocol;}))this.cancelSplit();}
  private bindings=new Map<string,GroupConnection>();
  get layout(){return this.value&&copyWorkspace(this.value);}
  retain(owner:string,live:readonly GroupConnection[]){if(owner!==this.owner){this.bindings.clear();this.cancelSplit();}this.owner=owner;
    for(const [slot,ref] of this.bindings){if(!live.some(c=>c.connection_id===ref.connection_id&&c.generation===ref.generation&&c.protocol===ref.protocol))this.bindings.delete(slot);}}
  open(workspace:Workspace,owner:string,_live:readonly GroupConnection[]){this.bindings.clear();this.owner=owner;this.value=copyWorkspace(workspace);this.restoration=workspace.split?'pending':'cancelled';}
  close(){this.value=undefined;this.bindings.clear();this.restoration='cancelled';}
  binding(slot:string){const ref=this.bindings.get(slot);return ref&&{...ref};}
  bind(owner:string,slot:string,profileId:string,target:GroupConnection){const tab=this.value?.tabs.find(t=>t.id===slot);if(owner!==this.owner||!tab||tab.profile_id!==profileId||target.generation<1)return false;
    if([...this.bindings].some(([id,c])=>id!==slot&&c.connection_id===target.connection_id))return false;
    this.bindings.set(slot,{connection_id:target.connection_id,generation:target.generation,protocol:target.protocol});return true;}
  claimSplit<T extends GroupConnection&{state:string}>(owner:string,live:readonly T[]){
    if(this.restoration!=='pending'||owner!==this.owner||!this.value?.split)return;
    const split=this.value.split;
    const find=(slot:string)=>{const c=this.bindings.get(slot);return c&&live.find(l=>l.connection_id===c.connection_id&&l.generation===c.generation&&l.protocol===c.protocol&&l.state==='CONNECTED'&&['SSH2','SERIAL'].includes(l.protocol));};
    const first=find(split.tabs[0]),second=find(split.tabs[1]),active=this.value.selected_tab&&find(this.value.selected_tab);
    if(!first||!second||!active||first.connection_id===second.connection_id)return;
    this.restoration='applied';return {direction:split.direction,first:{...first},second:{...second},active:{...active}};
  }
  order<T extends GroupConnection>(connections:readonly T[]){const rank=new Map(this.value?.tabs.map((t,i)=>[this.bindings.get(t.id)?.connection_id,i]));return [...connections].sort((a,b)=>(rank.get(a.connection_id)??Number.MAX_SAFE_INTEGER)-(rank.get(b.connection_id)??Number.MAX_SAFE_INTEGER));}
}
