export type GroupConnection = { connection_id:string;generation:number;protocol:string };
export type TabGroup = {id:string;name:string};
// Window-only presentation state. Never a connection, input or authorization source.
export class TabGroups {
  private owner='';
  private live=new Map<string,GroupConnection>();
  private groups:TabGroup[]=[];
  private members=new Map<string,string>();
  retain(owner:string,connections:readonly GroupConnection[]){
    if(owner!==this.owner){this.groups=[];this.members.clear();}
    this.owner=owner;this.live=new Map(connections.map(c=>[c.connection_id,{...c}]));
    for(const id of this.members.keys())if(!this.live.has(id))this.members.delete(id);
  }
  private name(value:string){const name=value.trim();if(!name||name.length>64||/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name))throw new Error('分组名需为1–64个字符，不能包含控制或方向控制字符。');return name;}
  replace(groups:TabGroup[]){if(groups.length>16||new Set(groups.map(g=>g.id)).size!==groups.length||groups.some(g=>!g.id))throw new Error('布局分组无效。');const next=groups.map(g=>({id:g.id,name:this.name(g.name)}));this.groups=next;this.members.clear();}
  list(){return this.groups.map(g=>({...g}));}
  create(value:string){if(this.groups.length>=16)throw new Error('本窗口最多16个分组，请先解散不需要的分组。');const group={id:crypto.randomUUID(),name:this.name(value)};this.groups.push(group);return group.id;}
  rename(id:string,value:string){const group=this.groups.find(g=>g.id===id);if(!group)throw new Error('分组已不存在。');group.name=this.name(value);}
  remove(id:string){this.groups=this.groups.filter(g=>g.id!==id);for(const [connection,group] of this.members)if(group===id)this.members.delete(connection);}
  move(id:string,offset:-1|1){const index=this.groups.findIndex(g=>g.id===id),next=index+offset;if(index<0||next<0||next>=this.groups.length)return;[this.groups[index],this.groups[next]]=[this.groups[next],this.groups[index]];}
  groupOf(id:string){return this.members.get(id)??'';}
  assign(owner:string,target:GroupConnection,group:string){const current=this.live.get(target.connection_id);
    if(owner!==this.owner||!current||current.generation!==target.generation||current.protocol!==target.protocol)throw new Error('会话已变化，未移动标签。');
    if(group&&!this.groups.some(g=>g.id===group))throw new Error('分组已不存在。');
    if(group)this.members.set(target.connection_id,group);else this.members.delete(target.connection_id);
  }
  order<T extends GroupConnection>(connections:readonly T[]):T[]{const rank=new Map(this.groups.map((g,i)=>[g.id,i+1]));return [...connections].sort((a,b)=>(rank.get(this.groupOf(a.connection_id))??0)-(rank.get(this.groupOf(b.connection_id))??0));}
}
