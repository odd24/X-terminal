import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {config,ConfigRequestError} from './config-api';

// Explicit recovery only: fixed native directory and the same authenticated service.
// Reading configuration, inventory or a saved intent never invokes this operation.
export function ConfigurationRecheck({ready,disabled=false}:{ready():Promise<void>;disabled?:boolean}){
 const onReady=useRef(ready);onReady.current=ready;
 const mounted=useRef(true),flight=useRef(false),owner=useRef('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('复查只尝试取得本服务原数据目录的独占访问权，不打开设备或继续连接。');
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function recheck(){if(flight.current||disabled)return;flight.current=true;setBusy(true);
  try{
   const before=await invoke<{service_id:string}>('service_status');
   if(owner.current&&owner.current!==before.service_id)throw new ConfigRequestError('CONFLICT');
   owner.current=before.service_id;if(!mounted.current)return;
   const reply=await config({op:'recheck',service_id:owner.current});
   const after=await invoke<{service_id:string}>('service_status');
   if(reply.result!=='rechecked'||reply.service_id!==owner.current||after.service_id!==owner.current)throw new ConfigRequestError('INVALID_CONFIGURATION_REPLY',true);
   if(!mounted.current)return;
   window.dispatchEvent(new CustomEvent('configuration-rechecked',{detail:{service_id:owner.current}}));
   setMessage('配置目录已就绪；请核对输入后明确连接，没有自动打开设备或登录。');
   await onReady.current();
  }catch(error){if(mounted.current)setMessage(error instanceof ConfigRequestError?(error.code==='LOCKED'?'本次复查仍未取得配置目录的独占访问权；请核对持有服务。没有打开设备或继续连接。':error.message):'配置复查未获有效结果，请再次明确复查；没有继续连接。');}
  finally{flight.current=false;if(mounted.current)setBusy(false);}
 }
 return <div><button type="button" disabled={disabled||busy} onClick={()=>void recheck()}>重新检查配置目录</button><p role="status" aria-label="配置目录复查状态">{busy?'正在复查本服务原配置目录…':message}</p></div>;
}
