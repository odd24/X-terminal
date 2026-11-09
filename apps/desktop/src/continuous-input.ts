import {InputQueue} from './input-queue.ts';
import {BroadcastRun,broadcastTargets,type BroadcastTarget,type BroadcastReceipt,type BroadcastResult} from './broadcast.ts';

type Dependencies={alive(owner:string):boolean;id():string;ready(owner:string,target:BroadcastTarget):Promise<boolean>;send(target:BroadcastTarget,id:string,payload:string):Promise<BroadcastReceipt>;query(target:BroadcastTarget,id:string):Promise<BroadcastReceipt>};
type Total={target:BroadcastTarget;accepted:number;bytes:number};
/** Dedicated keyboard surface only. No normal terminal, form, clipboard or output capture. */
export class ContinuousInput {
 private owner='';private enabled=false;private working=false;private reason='尚未启用';
 private targets:BroadcastTarget[]=[];private totals:Total[]=[];private packets=0;
 private queue?:InputQueue;private batch?:BroadcastRun;private detach?:()=>void;
 private epoch=0;private counted=new Map<string,string>();
 private listeners=new Set<()=>void>();private deps:Dependencies;
 constructor(deps:Dependencies){this.deps=deps;}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private emit(){for(const listener of this.listeners)listener();}
 snapshot(){return {owner:this.owner,enabled:this.enabled,working:this.working,reason:this.reason,packets:this.packets,totals:this.totals.map(r=>({...r,target:{...r.target}})),results:this.batch?.snapshot().results??[]};}
 arm(owner:string,targets:readonly BroadcastTarget[]){
  if(this.enabled||this.working)return false;
  const fixed=broadcastTargets(owner,targets);if(!this.deps.alive(owner))throw new Error('服务已变化，未启用。');
  this.detach?.();const epoch=++this.epoch;this.counted.clear();this.owner=owner;this.targets=fixed;this.totals=fixed.map(target=>({target,accepted:0,bytes:0}));this.packets=0;
  const record=(t:BroadcastTarget,id:string,r:BroadcastReceipt)=>{if(epoch!==this.epoch||r.state!=='ACCEPTED'||r.bytes===null||!Number.isSafeInteger(r.bytes)||r.bytes<0||this.counted.get(t.connection_id)===id)return;const total=this.totals.find(row=>row.target.connection_id===t.connection_id)!;total.accepted++;total.bytes+=r.bytes;this.counted.set(t.connection_id,id);};
  this.batch=new BroadcastRun({...this.deps,
   ready:async(o,t)=>{let ready=false;try{ready=await this.deps.ready(o,t);}catch{/* Preflight failure never dispatches. */}if(!ready||!this.deps.alive(o))this.stop('原目标、认证或输入租约未就绪；已停止全部未发输入');return ready;},
   send:async(t,id,text)=>{
    let receipt:BroadcastReceipt;try{receipt=await this.deps.send(t,id,text);}catch{receipt={state:'UNKNOWN',bytes:null,message:'结果不明，只能查询原编号'};}
    if(receipt.state==='ACCEPTED'&&receipt.bytes!==null&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>=0){record(t,id,receipt);}
    else {if(!['REJECTED','UNKNOWN'].includes(receipt.state))receipt={state:'UNKNOWN',bytes:null,message:'回执状态或计数无效'};this.stop(`${receipt.message}；已停止全部未发输入`);}
    return receipt;
   },query:async(t,id)=>{const receipt=await this.deps.query(t,id);record(t,id,receipt);return receipt;}
  });
  this.detach=this.batch.subscribe(()=>this.emit());
  this.queue=new InputQueue(()=>this.stop('输入队列失败或结果不明，已停止；未重试'));
  this.enabled=true;this.reason='连续同步已启用；仅专用键盘区输入会发送';this.emit();return true;
 }
 stop(reason='已停止未开始输入；在途请求不能撤回'){
  if(!this.enabled)return;
  this.enabled=false;this.reason=reason;this.queue?.close();this.batch?.cancel();this.emit();
 }
 input(text:string){
  if(!this.enabled||!this.queue||!this.batch)return false;
  if(!this.deps.alive(this.owner)){this.stop('服务已变化，未派发后续输入');return false;}
  if(!text||/[\uD800-\uDFFF]/u.test(text)||new TextEncoder().encode(text).length>4096){this.stop('单段输入无效或超过4KiB，已停止；未发送该段');return false;}
  const accepted=this.queue.enqueueKeyboard(text,this.owner,async payload=>{
   if(!this.enabled)return;
   this.working=true;this.packets++;this.emit();
   try{await this.batch!.start({owner:this.owner,targets:this.targets,payload});}
   finally{this.working=false;this.emit();}
  });
  if(!accepted)this.stop('16项输入队列已满，已停止并丢弃未发尾部；没有静默丢弃后继续');
  return accepted;
 }
 async query(id:string){if(this.enabled||this.working||!this.batch)return false;return this.batch.query(id);}
}
export type ContinuousSnapshot=ReturnType<ContinuousInput['snapshot']>;
export type ContinuousRow=BroadcastResult;
