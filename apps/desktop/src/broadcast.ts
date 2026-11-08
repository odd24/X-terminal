/** One explicit text batch; transport input queues and deduplication remain service-owned. */
export type BroadcastTarget={connection_id:string;generation:number;protocol:string;label:string;encoding:string};
export type BroadcastPlan={owner:string;targets:BroadcastTarget[];payload:string};
export type BroadcastResult={target:BroadcastTarget;request_id:string;state:'WAITING'|'DISPATCHING'|'ACCEPTED'|'REJECTED'|'UNKNOWN'|'SKIPPED';message:string;bytes:number|null};
export type BroadcastReceipt=Pick<BroadcastResult,'state'|'message'|'bytes'>;
export type BroadcastSnapshot={owner:string;running:boolean;cancelled:boolean;results:BroadcastResult[]};
const key=(t:BroadcastTarget)=>`${t.connection_id}/${t.generation}`;
export function broadcastPayload(text:string,ending:string){
 const endings:Record<string,string>={none:'',cr:'\r',lf:'\n',crlf:'\r\n'};
 if(!Object.hasOwn(endings,ending)||!text||text.length>65536||/[\uD800-\uDFFF]/u.test(text))throw new Error('请输入完整Unicode正文并选择末尾换行。');
 const payload=text+endings[ending];if(new TextEncoder().encode(payload).length>65536)throw new Error('单批正文含末尾换行最多64KiB UTF-8；实际编码仍由各连接核对。');return payload;
}
function copyPlan(plan:BroadcastPlan):BroadcastPlan{
 if(!plan.owner||plan.targets.length<2||plan.targets.length>8||new Set(plan.targets.map(key)).size!==plan.targets.length)throw new Error('请选择2–8个不同的连接。');
 for(const t of plan.targets)if(!t.connection_id||!Number.isSafeInteger(t.generation)||t.generation<1||!['SSH2','SERIAL'].includes(t.protocol)||!['utf8','gbk','gb18030'].includes(t.encoding))throw new Error('目标身份或编码无效，请重新预览。');
 broadcastPayload(plan.payload,'none');return {owner:plan.owner,payload:plan.payload,targets:plan.targets.map(t=>({...t}))};
}
type Dependencies={alive(owner:string):boolean;id():string;ready(owner:string,target:BroadcastTarget):Promise<boolean>;send(target:BroadcastTarget,id:string,payload:string):Promise<BroadcastReceipt>;query(target:BroadcastTarget,id:string):Promise<BroadcastReceipt>};
export class BroadcastRun{
 private value:BroadcastSnapshot={owner:'',running:false,cancelled:false,results:[]};
 private listeners=new Set<()=>void>();private querying=new Set<string>();
 private deps:Dependencies;
 constructor(deps:Dependencies){this.deps=deps;}
 snapshot():BroadcastSnapshot{return {...this.value,results:this.value.results.map(r=>({...r,target:{...r.target}}))};}
 subscribe(listener:()=>void){this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
 private emit(){for(const listener of this.listeners)listener();}
 cancel(){if(!this.value.running)return;this.value.cancelled=true;for(const r of this.value.results)if(r.state==='WAITING'){r.state='SKIPPED';r.message='已取消尚未开始的目标；没有派发';}this.emit();}
 async start(input:BroadcastPlan){
  if(this.value.running)return false;const plan=copyPlan(input);if(!this.deps.alive(plan.owner))throw new Error('会话服务已变化，请重新预览。');
  const ids=plan.targets.map(()=>this.deps.id());if(new Set(ids).size!==ids.length)throw new Error('请求编号冲突，未发送。');
  this.value={owner:plan.owner,running:true,cancelled:false,results:plan.targets.map((target,i)=>({target,request_id:ids[i],state:'WAITING',message:'尚未派发',bytes:null}))};this.emit();
  try{for(const row of this.value.results){
   if(this.value.cancelled||row.state!=='WAITING')break;
   if(!this.deps.alive(plan.owner)){this.cancel();break;}
   let ready=false;try{ready=await this.deps.ready(plan.owner,{...row.target});}catch{/* Failed preflight never dispatches. */}
   if(this.value.cancelled||!this.deps.alive(plan.owner)){this.cancel();break;}
   if(!ready){row.state='SKIPPED';row.message='原目标状态、编码或服务已变化，未派发';this.emit();continue;}
   row.state='DISPATCHING';row.message='已开始请求；取消不能撤回';this.emit();
   let receipt:BroadcastReceipt;try{receipt=await this.deps.send({...row.target},row.request_id,plan.payload);}catch{receipt={state:'UNKNOWN',message:'请求结果不明，未重试；只能查询原编号',bytes:null};}
   if(!['ACCEPTED','REJECTED','UNKNOWN'].includes(receipt.state))receipt={state:'UNKNOWN',message:'回执状态无效；未重试',bytes:null};
   Object.assign(row,receipt);this.emit();if(receipt.state==='UNKNOWN'){this.cancel();break;}
  }}finally{this.value.running=false;this.emit();}return true;
 }
 async query(requestId:string){
  const row=this.value.results.find(r=>r.request_id===requestId),owner=this.value.owner;if(this.value.running||!row||!['UNKNOWN','ACCEPTED','REJECTED'].includes(row.state)||this.querying.has(requestId)||!this.deps.alive(owner))return false;
  this.querying.add(requestId);try{const receipt=await this.deps.query({...row.target},requestId);if(!this.deps.alive(owner)||this.value.owner!==owner||!this.value.results.includes(row))return false;if(['ACCEPTED','REJECTED','UNKNOWN'].includes(receipt.state))Object.assign(row,receipt);this.emit();return true;}catch{return false;}finally{this.querying.delete(requestId);}
 }
}
