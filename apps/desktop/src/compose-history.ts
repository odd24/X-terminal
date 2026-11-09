import type {Ending} from './compose-drafts';
export type ComposeHistoryEntry={id:string;text:string;ending:Ending;protocol:string;queuedAt:number};
/** Opt-in window memory only; entries are text drafts, never execution receipts or capabilities. */
export class ComposeHistory{
 private owner='';private recording=false;private rows:ComposeHistoryEntry[]=[];private sizes:number[]=[];private used=0;
 get enabled(){return this.recording;}
 get bytes(){return this.used+(this.rows.length?2:0);}
 retain(owner:string){if(owner!==this.owner){this.clear();this.owner=owner;}}
 enable(owner:string,value:boolean){if(!owner||owner!==this.owner)return false;if(!value)this.clear();else this.recording=true;return true;}
 clear(){this.recording=false;this.rows=[];this.sizes=[];this.used=0;}
 list(owner:string){return owner&&owner===this.owner?this.rows.map(r=>({...r})):[];}
 get(owner:string,id:string){return this.list(owner).find(r=>r.id===id);}
 remember(owner:string,text:string,ending:Ending,protocol:string):'disabled'|'oversize'|'added'{
  if(!owner||owner!==this.owner||!this.recording)return 'disabled';
  if(!text||text.length>65536||/[\uD800-\uDFFF]/u.test(text)||!['none','cr','lf','crlf'].includes(ending)||!['SSH2','SERIAL','FIXTURE'].includes(protocol))return 'oversize';
  const entry={id:crypto.randomUUID(),text,ending,protocol,queuedAt:Date.now()},size=new TextEncoder().encode(JSON.stringify(entry)).length+1;
  if(size+2>262144)return 'oversize';
  while(this.rows.length>=32||this.used+size+2>262144){this.rows.pop();this.used-=this.sizes.pop()!;}
  this.rows.unshift(entry);this.sizes.unshift(size);this.used+=size;return 'added';
 }
}
