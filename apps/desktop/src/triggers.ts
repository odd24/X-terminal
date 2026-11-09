import type {BroadcastTarget,BroadcastReceipt,BroadcastResult} from './broadcast';
export type TriggerHit={first_seq:number;last_seq:number;text:string};
export type TriggerEvent={seq:number;text:string;gap_bytes:number|null;decode_error:boolean};
export type TriggerPage={connection:{connection_id:string;generation:number};encoding:string;events:TriggerEvent[];next_cursor:number;truncated:boolean;completed:boolean};
export type TriggerActions={highlight:boolean;notify:boolean;record:boolean;send:boolean};
export type TriggerInput={owner:string;name:string;source:Pick<BroadcastTarget,'connection_id'|'generation'|'protocol'>;kind:'literal'|'regex';pattern:string;actions:TriggerActions;targets:Pick<BroadcastTarget,'connection_id'|'generation'|'protocol'>[];payload:string;cooldown:number;limit:number};
export type TriggerPlan=Omit<TriggerInput,'source'|'targets'> & {id:string;source:BroadcastTarget;targets:BroadcastTarget[];span:number};
type HitRecord={id:string;name:string;source:BroadcastTarget;first_seq:number;last_seq:number;excerpt:string;truncated:boolean;highlight:boolean;at:number};
type Dependencies={id():string;now():number;alive(owner:string):boolean;inspect(owner:string,targets:TriggerInput['targets'],sending:boolean):Promise<BroadcastTarget[]>;compile(id:string,kind:string,pattern:string):Promise<number>;reset(id:string,next:number):Promise<void>;feed(id:string,event:TriggerEvent):Promise<TriggerHit[]>;close(id:string):Promise<void>;read(source:BroadcastTarget,cursor:number):Promise<TriggerPage>;ready(owner:string,t:BroadcastTarget):Promise<boolean>;send(t:BroadcastTarget,id:string,payload:string):Promise<BroadcastReceipt>;query(t:BroadcastTarget,id:string):Promise<BroadcastReceipt>;notify(text:string):void;later(callback:()=>void):()=>void};
const same=(a:{connection_id:string;generation:number},b:typeof a)=>a.connection_id===b.connection_id&&a.generation===b.generation;
const clone=<T,>(value:T):T=>structuredClone(value);
function metadata(actual:BroadcastTarget|undefined,wanted:Pick<BroadcastTarget,'connection_id'|'generation'|'protocol'>){return !!actual&&same(actual,wanted)&&actual.protocol===wanted.protocol&&['SSH2','SERIAL'].includes(actual.protocol)&&['utf8','gbk','gb18030'].includes(actual.encoding)&&!!actual.label&&new TextEncoder().encode(actual.label).length<=1024;}
/** One window, source and rule. Output never grants input; automatic send disarms before dispatch. */
export class Triggers {
 private deps:Dependencies;private epoch=0;private id?:string;private plan?:TriggerPlan;private prepared?:TriggerPlan;
 private active=false;private preparing=false;private polling=false;private cursor=1;private cancelTimer?:()=>void;
 private working=false;private cancelled=false;private sends:BroadcastResult[]=[];private sendOwner='';
 private reason='尚未启用';private fired=0;private suppressed=0;private lastAt=-Infinity;
 private records:HitRecord[]=[];private last?:HitRecord;private listeners=new Set<()=>void>();
 constructor(deps:Dependencies){this.deps=deps;}
 snapshot(){return clone({active:this.active,preparing:this.preparing,working:this.working,reason:this.reason,fired:this.fired,suppressed:this.suppressed,prepared:this.prepared,source:this.plan?.source,records:this.records,last:this.last,sends:this.sends,sendOwner:this.sendOwner});}
 subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 private emit(){for(const fn of this.listeners)fn();}
 private retire(){const id=this.id;this.id=undefined;if(id)void this.deps.close(id).catch(()=>{/* Bounded native slots remain fail-closed on unknown cleanup. */});}
 stop(reason='已停用；不会恢复旧同意或重放'){
  this.epoch++;this.active=false;this.preparing=false;this.prepared=undefined;this.cancelled=true;this.cancelTimer?.();this.retire();this.reason=reason;
  for(const row of this.sends)if(row.state==='WAITING'){row.state='SKIPPED';row.message='未开始，已停止';}this.emit();
 }
 clear(){this.stop('本窗口规则与命中记录已清空；已开始的发送回执仅供原编号查询');this.plan=undefined;this.records=[];this.last=undefined;this.emit();}
 validate(owner:string,live:readonly {connection_id:string;generation:number;protocol:string;state:string}[]){
  const plan=this.prepared??this.plan;if(!plan||!this.active&&!this.working&&!this.prepared)return;
  if(owner!==plan.owner||!this.deps.alive(plan.owner)||[plan.source,...(plan.actions.send?plan.targets:[])].some(t=>!live.some(c=>same(c,t)&&c.protocol===t.protocol&&c.state==='CONNECTED')))this.stop('服务、来源或固定目标已变化，旧激活已撤销；不跟随新代次');
 }
 async preview(input:TriggerInput){
  if(this.preparing||this.working)return false;this.stop();
  if(!input.owner||!input.name||Array.from(input.name).length>64||!['literal','regex'].includes(input.kind)||!input.pattern||new TextEncoder().encode(input.pattern).length>1024||/[\uD800-\uDFFF]/u.test(input.pattern)||!Number.isSafeInteger(input.cooldown)||input.cooldown<100||input.cooldown>60000||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100||!Object.values(input.actions).some(v=>v===true))throw new Error('请核对名称、模式、动作、100–60000毫秒冷却及1–100次上限。');
  if(input.actions.send&&(!input.payload||new TextEncoder().encode(input.payload).length>4096||/[\uD800-\uDFFF]/u.test(input.payload)||input.targets.length<1||input.targets.length>8||new Set(input.targets.map(t=>`${t.connection_id}/${t.generation}`)).size!==input.targets.length))throw new Error('发送须独立选择1–8目标和最多4KiB固定正文；不使用匹配文字插值。');
  const version=this.epoch,id=this.deps.id();this.preparing=true;this.id=id;this.emit();
  try{
   const [source]=await this.deps.inspect(input.owner,[input.source],false);const targets=input.actions.send?await this.deps.inspect(input.owner,input.targets,true):[];
   if(!metadata(source,input.source)||targets.length!==(input.actions.send?input.targets.length:0)||targets.some((t,i)=>!metadata(t,input.targets[i])))throw new Error('来源或发送范围的实际身份/编码不匹配');
   const span=await this.deps.compile(id,input.kind,input.pattern);
   if(version!==this.epoch||!this.deps.alive(input.owner)){await this.deps.close(id);return false;}
   this.prepared=clone({...input,id,source,targets,payload:input.actions.send?input.payload:'',span});this.reason='请核对来源、四动作和独立发送许可；尚未启用';return true;
  }catch(e){if(version===this.epoch)this.stop('规则预览失败，未启用');throw e;}
  finally{if(version===this.epoch){this.preparing=false;this.emit();}}
 }
 private page(plan:TriggerPlan,page:TriggerPage){if(!same(page.connection,plan.source)||page.encoding!==({utf8:'utf-8',gbk:'gbk',gb18030:'gb18030'}[plan.source.encoding])||!Number.isSafeInteger(page.next_cursor)||page.next_cursor<1||page.events.length>128)throw new Error('来源文本身份或游标不匹配');}
 async activate(){
  if(!this.prepared||this.preparing||this.working)return false;const plan=this.prepared,version=this.epoch;this.prepared=undefined;this.preparing=true;this.emit();
  try{
   // Drain retained history without matching; activation starts at a new live text watermark.
   let cursor=1,primed=false;
   for(let n=0;n<16;n++){const page=await this.deps.read(plan.source,cursor);this.page(plan,page);if(page.completed)throw new Error('来源已结束，未启用');cursor=page.next_cursor;if(!page.events.length){primed=true;break;}if(version!==this.epoch)return false;}
   if(!primed)throw new Error('来源输出过快，无法冻结起点；未启用');
   const [current]=await this.deps.inspect(plan.owner,[plan.source],false);
   if(!same(current,plan.source)||current.protocol!==plan.source.protocol||current.encoding!==plan.source.encoding||current.label!==plan.source.label)throw new Error('来源身份或编码已变化，未启用');
   if(plan.actions.send){const currentTargets=await this.deps.inspect(plan.owner,plan.targets,true);if(currentTargets.length!==plan.targets.length||currentTargets.some((t,i)=>!same(t,plan.targets[i])||t.protocol!==plan.targets[i].protocol||t.encoding!==plan.targets[i].encoding||t.label!==plan.targets[i].label))throw new Error('发送范围已变化，未启用');}
   await this.deps.reset(plan.id,cursor);
   if(version!==this.epoch||!this.deps.alive(plan.owner))return false;
   this.plan=plan;this.cursor=cursor;this.active=true;this.cancelled=false;this.fired=0;this.suppressed=0;this.lastAt=-Infinity;this.sends=[];this.reason='规则已启用，仅匹配启用后的来源文本';this.emit();this.schedule();return true;
  }catch(e){if(version===this.epoch)this.stop('来源起点未确认，未启用');throw e;}
  finally{if(version===this.epoch){this.preparing=false;this.emit();}}
 }
 private schedule(){this.cancelTimer?.();if(this.active)this.cancelTimer=this.deps.later(()=>{void this.poll();});}
 async poll(){
  if(!this.active||!this.plan||this.polling)return;const plan=this.plan,version=this.epoch;this.polling=true;
  try{
   if(!this.deps.alive(plan.owner))throw new Error('来源服务已变化');
   const page=await this.deps.read(plan.source,this.cursor);if(version!==this.epoch||!this.active)return;this.page(plan,page);
   if(page.truncated||page.completed)throw new Error('来源缺口、文本重建或结束；匹配窗口已重置，需重新明确启用');
   for(const event of page.events){
    if(version!==this.epoch||!this.active)break;
    if(event.seq!==this.cursor||!Number.isSafeInteger(event.seq)||event.gap_bytes!==null||event.decode_error)throw new Error('来源序号缺口或解码错误；旧激活已撤销，不能跨缺口匹配');
    const hits=await this.deps.feed(plan.id,event);if(version!==this.epoch||!this.active)return;this.cursor=event.seq+1;
    if(hits.length>32)throw new Error('单次命中容量超限，已停止');
    for(const hit of hits){
     if(version!==this.epoch||!this.active)break;
     if(!Number.isSafeInteger(hit.first_seq)||!Number.isSafeInteger(hit.last_seq)||hit.first_seq<1||hit.last_seq<hit.first_seq||hit.last_seq>event.seq||!hit.text||new TextEncoder().encode(hit.text).length>1024)throw new Error('匹配回执无效，已停止');
     const now=this.deps.now();if(now-this.lastAt<plan.cooldown){this.suppressed++;continue;}
     this.lastAt=now;this.fired++;const chars=Array.from(hit.text),record:HitRecord={id:this.deps.id(),name:plan.name,source:clone(plan.source),first_seq:hit.first_seq,last_seq:hit.last_seq,excerpt:chars.slice(0,256).join(''),truncated:chars.length>256,highlight:plan.actions.highlight,at:Date.now()};this.last=record;
     if(plan.actions.record){this.records.push(record);while(this.records.length>64||new TextEncoder().encode(JSON.stringify(this.records)).length>65536)this.records.shift();}
     if(plan.actions.notify)this.deps.notify(`${plan.name} · ${plan.source.label} · 文本序号 ${hit.first_seq}–${hit.last_seq} 命中`);
     this.emit();
     if(plan.actions.send){this.active=false;this.cancelTimer?.();this.retire();this.reason='发送前已停用规则；每次启用最多一个自动批次，回显不再触发';await this.dispatch(plan,version);break;}
     if(this.fired>=plan.limit){this.stop('已达到本次触发次数上限，规则已停用');break;}
    }
   }
   if(this.active&&this.cursor!==page.next_cursor)throw new Error('来源文本游标不连续，已停用');
  }catch(e){if(version===this.epoch)this.stop(e instanceof Error?e.message:'匹配结果不明，已停用；不重试');}
  finally{this.polling=false;this.emit();this.schedule();}
 }
 private async dispatch(plan:TriggerPlan,version:number){
  this.working=true;this.sendOwner=plan.owner;const rows=plan.targets.map(target=>({target:clone(target),request_id:this.deps.id(),state:'WAITING',message:'尚未派发',bytes:null} as BroadcastResult));this.sends=rows;this.emit();
  try{
   if(new Set(rows.map(r=>r.request_id)).size!==rows.length)throw new Error('编号冲突');
   for(const row of rows){
    if(this.cancelled||version!==this.epoch||!this.deps.alive(plan.owner))break;
    let ready=false;try{ready=await this.deps.ready(plan.owner,row.target);}catch{/* Never dispatch without preflight. */}
    if(this.cancelled||version!==this.epoch||!this.deps.alive(plan.owner))break;
    if(!ready){row.state='SKIPPED';row.message='原目标或租约未就绪，停止余项';break;}
    row.state='DISPATCHING';row.message='在途动作不能撤回';this.emit();let receipt:BroadcastReceipt;
    try{receipt=await this.deps.send(row.target,row.request_id,plan.payload);}catch{receipt={state:'UNKNOWN',message:'结果不明，只查原编号；不重发',bytes:null};}
    Object.assign(row,receipt);this.emit();if(receipt.state!=='ACCEPTED')break;
   }
  }catch{this.reason='自动批次未能确认，未重试';}
  finally{for(const row of rows)if(row.state==='WAITING'){row.state='SKIPPED';row.message='未开始，停止余项';}this.working=false;this.emit();}
 }
 async query(id:string){if(this.active||this.working)return false;const row=this.sends.find(r=>r.request_id===id),owner=this.sendOwner;if(!row||row.state!=='UNKNOWN'||!owner||!this.deps.alive(owner))return false;const receipt=await this.deps.query(row.target,id);if(this.sends.includes(row))Object.assign(row,receipt);this.emit();return true;}
}
