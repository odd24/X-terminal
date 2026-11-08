type Connection = { connection_id:string; generation:number; protocol:string; state:string };
type Ref = Pick<Connection,'connection_id'|'generation'|'protocol'>;
export const tabScope=(connection:Pick<Ref,'connection_id'|'generation'>)=>`${connection.connection_id}:${connection.generation}`;
const same=(a:Ref|undefined,b:Ref)=>a?.generation===b.generation&&a.connection_id===b.connection_id&&a.protocol===b.protocol;

// UI coordination only. The service still validates the complete immutable ref.
export class SessionTabClosures {
  private owner='';
  private retained=new Map<string,Ref>();
  private hidden=new Map<string,Ref>();
  private attempts=new Map<string,{ref:Ref;state:'pending'|'accepted'|'unknown'}>();
  retain(owner:string,connections:readonly Ref[]){
    if(owner!==this.owner){this.hidden.clear();this.attempts.clear();}this.owner=owner;
    this.retained=new Map(connections.map(c=>[c.connection_id,{...c}]));
    for(const [id,c] of this.hidden)if(!same(this.retained.get(id),c))this.hidden.delete(id);
    for(const [key,a] of this.attempts)if(!same(this.retained.get(a.ref.connection_id),a.ref))this.attempts.delete(key);
  }
  begin(target:Connection,connections:readonly Connection[]){
    const current=connections.find(c=>c.connection_id===target.connection_id);
    if(!same(current,target))return 'stale';
    if(['DISCONNECTED','FAILED'].includes(current!.state))return 'hide';
    const old=this.attempts.get(tabScope(target));if(old)return old.state==='unknown'?'unknown':'pending';
    this.attempts.set(tabScope(target),{ref:{...target},state:'pending'});return 'dispatch';
  }
  finish(target:Ref,state:'accepted'|'unknown'){const old=this.attempts.get(tabScope(target));if(old&&same(this.retained.get(target.connection_id),target))old.state=state;}
  pending(target:Ref){return this.attempts.get(tabScope(target))?.state==='pending';}
  hide(target:Ref){if(!same(this.retained.get(target.connection_id),target))return false;this.hidden.set(target.connection_id,{...target});return true;}
  isHidden(target:Ref){return same(this.hidden.get(target.connection_id),target);}
  show(target:Ref){if(this.isHidden(target))this.hidden.delete(target.connection_id);}
}
