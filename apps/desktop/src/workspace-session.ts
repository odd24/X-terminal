import type { Profile, Workspace } from './config-api';
import type { GroupConnection, TabGroup } from './tab-groups';
type SnapshotConnection=GroupConnection&{profile_id?:string};
export function copyWorkspace(w:Workspace):Workspace{return {id:w.id,name:w.name,groups:w.groups.map(g=>({id:g.id,name:g.name})),tabs:w.tabs.map(t=>({id:t.id,profile_id:t.profile_id,group_id:t.group_id})),selected_tab:w.selected_tab,navigation_open:w.navigation_open};}
export function captureWorkspace(name:string,connections:readonly SnapshotConnection[],profiles:readonly Profile[],groups:TabGroup[],groupOf:(id:string)=>string,selected:string,navigation:boolean){
  let skipped=0;let selectedTab:string|null=null;
  const tabs:Workspace['tabs']=[];
  for(const c of connections){const profile=profiles.find(p=>p.id===c.profile_id&&p.settings.protocol.toUpperCase()===c.protocol);if(!profile){skipped++;continue;}const id=crypto.randomUUID();tabs.push({id,profile_id:profile.id,group_id:groupOf(c.connection_id)||null});if(c.connection_id===selected)selectedTab=id;}
  return {workspace:{id:crypto.randomUUID(),name:name.trim(),groups:groups.map(g=>({...g})),tabs,selected_tab:selectedTab,navigation_open:navigation} satisfies Workspace,skipped};
}
// Bindings are window-only and never serialized into a Workspace.
export class WorkspaceSession {
  private value:Workspace|undefined;
  private owner='';
  private bindings=new Map<string,GroupConnection>();
  get layout(){return this.value&&copyWorkspace(this.value);}
  retain(owner:string,live:readonly GroupConnection[]){if(owner!==this.owner)this.bindings.clear();this.owner=owner;
    for(const [slot,ref] of this.bindings){const current=live.find(c=>c.connection_id===ref.connection_id&&c.protocol===ref.protocol);if(!current)this.bindings.delete(slot);else this.bindings.set(slot,{connection_id:current.connection_id,generation:current.generation,protocol:current.protocol});}}
  open(workspace:Workspace,owner:string,live:readonly GroupConnection[]){if(workspace.id!==this.value?.id)this.bindings.clear();const previous=this.value;this.value=copyWorkspace(workspace);for(const id of this.bindings.keys())if(previous?.tabs.find(t=>t.id===id)?.profile_id!==workspace.tabs.find(t=>t.id===id)?.profile_id)this.bindings.delete(id);this.retain(owner,live);}
  close(){this.value=undefined;this.bindings.clear();}
  binding(slot:string){const ref=this.bindings.get(slot);return ref&&{...ref};}
  bind(owner:string,slot:string,profileId:string,target:GroupConnection){const tab=this.value?.tabs.find(t=>t.id===slot);if(owner!==this.owner||!tab||tab.profile_id!==profileId||target.generation<1)return false;
    if([...this.bindings].some(([id,c])=>id!==slot&&c.connection_id===target.connection_id))return false;
    this.bindings.set(slot,{connection_id:target.connection_id,generation:target.generation,protocol:target.protocol});return true;}
  order<T extends GroupConnection>(connections:readonly T[]){const rank=new Map(this.value?.tabs.map((t,i)=>[this.bindings.get(t.id)?.connection_id,i]));return [...connections].sort((a,b)=>(rank.get(a.connection_id)??Number.MAX_SAFE_INTEGER)-(rank.get(b.connection_id)??Number.MAX_SAFE_INTEGER));}
}
