import {invoke} from '@tauri-apps/api/core';
import {ssh,SshRequestError,type Receipt} from './ssh-api';
import {serial,SerialRequestError,type SerialReceipt} from './serial-api';
import type {BroadcastReceipt,BroadcastTarget} from './broadcast';
type Live={connection_id:string;generation:number;protocol:string;state:string};
const reference=(t:Pick<BroadcastTarget,'connection_id'|'generation'>)=>({connection_id:t.connection_id,generation:t.generation});
export async function inspectBroadcastTargets(owner:string,targets:readonly Pick<BroadcastTarget,'connection_id'|'generation'|'protocol'>[]):Promise<BroadcastTarget[]>{
 const native=await invoke<{service_id:string}>('service_status');if(native.service_id!==owner)throw new Error('服务已变化，请重新选择目标。');
 const live=await invoke<Live[]>('service_list'),result:BroadcastTarget[]=[];
 for(const t of targets){if(!live.some(c=>c.connection_id===t.connection_id&&c.generation===t.generation&&c.protocol===t.protocol&&c.state==='CONNECTED'))throw new Error('所选目标已断开、正在认证或代次变化；未发送，请重新选择。');
  if(t.protocol==='SSH2'){const status=await ssh({op:'status',connection:reference(t)});if(status.result!=='status'||status.connection.state!=='CONNECTED'||status.challenge)throw new Error('SSH目标未就绪，未发送。');result.push({...reference(t),protocol:t.protocol,label:status.server_host,encoding:status.encoding});}
  else if(t.protocol==='SERIAL'){const status=await serial({op:'status',connection:reference(t)});if(status.result!=='status'||status.connection.state!=='CONNECTED'||status.cleanup_pending)throw new Error('串口目标未就绪，未发送。');result.push({...reference(t),protocol:t.protocol,label:status.port,encoding:status.encoding});}
  else throw new Error('此入口仅支持SSH2和串口文本。');
 }
 return result;
}
export async function broadcastTargetReady(owner:string,target:BroadcastTarget){const targets=await inspectBroadcastTargets(owner,[target]);return targets[0].encoding===target.encoding&&targets[0].label===target.label;}
const unknown=(message='结果不明；未重试，只能查询原编号',bytes:number|null=null):BroadcastReceipt=>({state:'UNKNOWN',message,bytes});
function project(target:BroadcastTarget,id:string,receipt:Receipt|SerialReceipt):BroadcastReceipt{
 if(receipt.request_id!==id)return unknown('回执编号不匹配；未重试');
 const bytes='pipeline_bytes'in receipt?receipt.pipeline_bytes:receipt.driver_accepted;
 if(bytes!==null&&(!Number.isSafeInteger(bytes)||bytes<0))return unknown('回执计数无效；未重试');
 if(receipt.state==='PIPELINE_QUEUED'||receipt.state==='DRIVER_ACCEPTED')return bytes===null?unknown('缺少接受计数；未重试'):{state:'ACCEPTED',message:target.protocol==='SSH2'?'SSH发送管线已接受；不代表远端已执行':'串口驱动已接受；不代表设备已执行',bytes};
 if(receipt.state==='CANCELLED_BEFORE_DISPATCH')return {state:'REJECTED',message:'服务在派发前取消',bytes};return unknown('尚未取得最终接受回执；只查原编号，不重发',bytes);
}
async function finish(target:BroadcastTarget,id:string,first:Receipt|SerialReceipt):Promise<BroadcastReceipt>{
 let receipt=first;const deadline=performance.now()+(target.protocol==='SSH2'?17000:75000);
 while(['PENDING','DISPATCHING'].includes(receipt.state)){
  if(receipt.request_id!==id||performance.now()>deadline)return unknown('原请求仍未确认；只查原编号，不重发');
  await new Promise(resolve=>setTimeout(resolve,50));const r=target.protocol==='SSH2'?await ssh({op:'input_status',connection:reference(target),request_id:id}):await serial({op:'input_status',connection:reference(target),request_id:id});if(r.result!=='input')return unknown('回执类型不匹配；未重试');receipt=r;
 }
 return project(target,id,receipt);
}
export async function sendBroadcastTarget(target:BroadcastTarget,id:string,payload:string):Promise<BroadcastReceipt>{
 let initial:Receipt|SerialReceipt;try{const r=target.protocol==='SSH2'?await ssh({op:'write_text',connection:reference(target),request_id:id,text:payload}):await serial({op:'send',connection:reference(target),request_id:id,content:payload,format:'text',ending:'none',pace:{chunk_bytes:1024,interval_ms:0}});if(r.result!=='input')return unknown('回执类型不匹配；未重试');initial=r;}
 catch(e){if((e instanceof SshRequestError||e instanceof SerialRequestError)&&['CapacityExceeded','NotFound','NotConnected','InvalidState','StaleGeneration','InvalidArgument','INVALID_SSH_REQUEST','INVALID_SERIAL_REQUEST','PermissionDenied'].includes(e.code))return {state:'REJECTED',message:e.message,bytes:null};return unknown();}
 try{return await finish(target,id,initial);}catch{return unknown('派发后回执查询失败；结果不明，只查原编号');}
}
export async function queryBroadcastTarget(target:BroadcastTarget,id:string):Promise<BroadcastReceipt>{
 try{const r=target.protocol==='SSH2'?await ssh({op:'input_status',connection:reference(target),request_id:id}):await serial({op:'input_status',connection:reference(target),request_id:id});return r.result==='input'?project(target,id,r):unknown('原编号回执不可用；未重发');}catch{return unknown('原编号暂无法查询或已过期；不能据此重新发送');}
}
