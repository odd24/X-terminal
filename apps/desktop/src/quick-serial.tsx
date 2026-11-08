import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Panel, Field, ErrorNotice } from './ui';
import { config, readConfiguration, ConfigRequestError, type Profile, type Settings } from './config-api';
import { serial, SerialRequestError, reference, type Inventory, type SerialReply } from './serial-api';
import { requestId } from './request-id';
import type { ConnectionRef } from './ssh-api';

type SerialSettings = Extract<Settings,{protocol:'serial'}>;
type Attempt = { id:string; connection?:ConnectionRef; cancelled:boolean; connected:boolean };
const slot='terminal-serial-start-v1';
const defaults:SerialSettings={protocol:'serial',port:'',baud_rate:115200,data_bits:8,stop_bits:1,parity:'none',flow:'none',dtr_on_open:false,rts_on_open:false,encoding:'utf8'};
const failures:Record<string,string>={DEVICE_UNAVAILABLE:'设备已拔出或不可用，请检查接线并刷新端口。',ACCESS_OR_BUSY:'端口被占用或访问被拒绝，请关闭占用程序后重试。',INVALID_PARAMETERS:'设备不支持这些参数，请检查波特率和流控。',IO:'设备通信中断，请检查连接。',CANCELLED:'本次连接已取消。',WORKER_FAILED:'串口线程异常，未自动重连。'};
function safe(error:unknown){return error instanceof SerialRequestError||error instanceof ConfigRequestError?error.message:'串口操作未完成；结果可能不明，没有自动重试。';}
function savedAttempt():Attempt|undefined {try{const id=sessionStorage.getItem(slot);if(id&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id))return {id,cancelled:false,connected:false};}catch{/* unavailable */}return undefined;}
export function QuickSerial({requestedProfile,select,close,focus}:{requestedProfile?:string;select(id:string):void;close():void;focus(connection:ConnectionRef,profileId:string):void}){
  const [settings,setSettings]=useState<SerialSettings>(defaults),[inventory,setInventory]=useState<Inventory>(),[deviceId,setDeviceId]=useState('');
  const [profiles,setProfiles]=useState<Profile[]>([]),[profileId,setProfileId]=useState(''),[save,setSave]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('选择端口即可连接。只接收抓取UART日志无需发送命令。');
  const [unknown,setUnknown]=useState(()=>!!savedAttempt()),[saveUnknown,setSaveUnknown]=useState(false);
  const attempt=useRef<Attempt|undefined>(savedAttempt()),mounted=useRef(true),flight=useRef(false);
  const device=inventory?.devices.find(d=>d.device_id===deviceId);
  const patch=(value:Partial<SerialSettings>)=>{setProfileId('');setSettings(previous=>({...previous,...value}));};
  const forget=()=>{try{sessionStorage.removeItem(slot);}catch{/* unavailable */}};
  async function load(){if(flight.current)return;flight.current=true;setLoading(true);setError('');try{
    const [c,i]=await Promise.all([readConfiguration(),serial({op:'inventory'})]);if(i.result!=='inventory')throw new Error();
    if(!mounted.current)return;setProfiles(c.profiles.filter(p=>p.settings.protocol==='serial'));setInventory(i);setDeviceId('');setSaveUnknown(false);
    const p=c.profiles.find(p=>p.id===requestedProfile);if(p?.settings.protocol==='serial'){setSettings(p.settings);setProfileId(p.id);}
  }catch(e){if(mounted.current){setInventory(undefined);setError(`读取端口或配置失败：${safe(e)}`);}}finally{flight.current=false;if(mounted.current)setLoading(false);}}
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;const a=attempt.current;if(a&&!a.connected){a.cancelled=true;if(a.connection)void serial({op:'close',connection:a.connection}).catch(()=>{});}};},[]);
  async function accept(reply:SerialReply,a:Attempt){if(reply.result!=='started')throw new Error();a.connection=reference(reply.connection);
    if(!mounted.current||a.cancelled){await serial({op:'close',connection:a.connection});forget();return;}
    setUnknown(false);setMessage('正在打开串口…');
    for(let n=0;n<120;n++){
      const status=await serial({op:'status',connection:a.connection});if(status.result!=='status'||status.connection.connection_id!==a.connection.connection_id||status.connection.generation!==a.connection.generation)throw new Error();
      if(!mounted.current||a.cancelled){await serial({op:'close',connection:a.connection});return;}
      if(status.connection.state==='CONNECTED'){a.connected=true;forget();select(a.connection.connection_id);focus(a.connection,status.profile_id);return;}
      if(['FAILED','DISCONNECTED'].includes(status.connection.state)){forget();setError(failures[status.failure??'']??'串口未能打开，请检查设备、占用和参数。');select(a.connection.connection_id);return;}
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error();
  }
  async function connect(event:FormEvent){event.preventDefault();if(flight.current||unknown||saveUnknown||loading||!inventory||!device)return;flight.current=true;setBusy(true);setError('');
    const a:Attempt={id:requestId(),cancelled:false,connected:false};attempt.current=a;
    try{
      let id=profileId;
      if(save&&!id){const profile={id:crypto.randomUUID(),name:`${device.port} · ${settings.baud_rate}`,folder_id:null,settings:{...settings,port:device.port}};
        try{const reply=await config({op:'save_profile',profile,credential:{action:'keep'}});if(reply.result!=='saved_profile'||reply.profile.id!==profile.id)throw new Error();id=profile.id;}
        catch(e){if(mounted.current){setSaveUnknown(!(e instanceof ConfigRequestError)||e.uncertain);setError(`保存配置未完成：${safe(e)} 尚未打开串口，请重新读取核对。`);}return;}
      }
      if(!mounted.current||a.cancelled)return;
      try{sessionStorage.setItem(slot,a.id);}catch{/* in-memory ID remains */}
      await accept(await serial(id?{op:'start',profile_id:id,request_id:a.id,revision:inventory.revision,device_id:device.device_id}:{op:'quick_start',settings:{...settings,port:device.port},request_id:a.id,revision:inventory.revision,device_id:device.device_id}),a);
    }catch(e){if(mounted.current){const known=!a.connection&&e instanceof SerialRequestError&&['InvalidState','InvalidArgument','NotFound','CapacityExceeded','PermissionDenied','INVALID_SERIAL_REQUEST'].includes(e.code);setUnknown(!known);if(known)forget();setError(`${safe(e)}${known?'':' 请查询原连接结果，不要再次打开。'}`);}}
    finally{flight.current=false;if(mounted.current)setBusy(false);}
  }
  async function query(){const a=attempt.current;if(!a||flight.current)return;flight.current=true;setBusy(true);setError('');try{await accept(await serial({op:'start_status',request_id:a.id}),a);}catch(e){if(mounted.current)setError(`${safe(e)} 仍只查询原编号，没有重新打开。`);}finally{flight.current=false;if(mounted.current)setBusy(false);}}
  const blocked=busy||loading||unknown||saveUnknown;
  return <Panel title="串口连接" label="串口快速连接" close={close} closeLabel="取消连接窗口">
    {error&&<ErrorNotice>{error}</ErrorNotice>}<p role="status">{loading?'正在读取端口与配置…':message}</p>
    <form onSubmit={e=>void connect(e)}>
      {profiles.length>0&&<Field label="已保存的连接（可选）"><select aria-label="串口已保存连接" disabled={blocked} value={profileId} onChange={e=>{setProfileId(e.target.value);const p=profiles.find(p=>p.id===e.target.value);if(p?.settings.protocol==='serial')setSettings(p.settings);setDeviceId('');}}><option value="">直接填写新连接</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <Field label="端口"><select aria-label="UART端口" autoFocus required disabled={blocked} value={deviceId} onChange={e=>{setDeviceId(e.target.value);const d=inventory?.devices.find(d=>d.device_id===e.target.value);if(d){if(profileId&&settings.port!==d.port)setProfileId('');setSettings(s=>({...s,port:d.port}));}}}><option value="">请选择端口</option>{inventory?.devices.map(d=><option key={d.device_id} value={d.device_id}>{d.port} · {d.instance_id}</option>)}</select></Field>
      <button type="button" disabled={busy||loading} onClick={()=>void load()}>刷新端口</button>
      {inventory&&<small>{inventory.devices.length===0?'没有可识别端口，请连接设备后刷新。':`可识别 ${inventory.devices.length} 个端口。`}{inventory.unidentified_ports.length>0&&` 无法确认身份的端口：${inventory.unidentified_ports.join('、')}（不可打开）。`}{inventory.metadata_failures>0&&` 身份读取失败 ${inventory.metadata_failures} 项。`}</small>}
      <Field label="波特率"><input aria-label="UART波特率" type="number" min="1" max="4000000" required disabled={blocked} value={settings.baud_rate} onChange={e=>patch({baud_rate:Number(e.target.value)})}/></Field>
      <p aria-label="UART初始控制线">打开时：DTR {settings.dtr_on_open?'高电平':'低电平'} · RTS {settings.flow==='hardware'?'由硬件流控管理':settings.rts_on_open?'高电平':'低电平'}。控制线变化可能使设备复位，请按接线确认。</p>
      <details><summary>通信参数与控制线</summary><div className="form-grid">
        <Field label="数据位"><select aria-label="UART数据位" disabled={blocked} value={settings.data_bits} onChange={e=>patch({data_bits:Number(e.target.value)})}>{[5,6,7,8].map(v=><option key={v}>{v}</option>)}</select></Field>
        <Field label="停止位"><select aria-label="UART停止位" disabled={blocked} value={settings.stop_bits} onChange={e=>patch({stop_bits:Number(e.target.value)})}><option>1</option><option>2</option></select></Field>
        <Field label="校验"><select aria-label="UART校验" disabled={blocked} value={settings.parity} onChange={e=>patch({parity:e.target.value as SerialSettings['parity']})}><option value="none">无</option><option value="odd">奇</option><option value="even">偶</option></select></Field>
        <Field label="流控"><select aria-label="UART流控" disabled={blocked} value={settings.flow} onChange={e=>{const flow=e.target.value as SerialSettings['flow'];patch({flow,rts_on_open:flow==='hardware'?null:false});}}><option value="none">无</option><option value="software">软件</option><option value="hardware">硬件 RTS/CTS</option></select></Field>
        <Field label="编码"><select aria-label="UART编码" disabled={blocked} value={settings.encoding} onChange={e=>patch({encoding:e.target.value as SerialSettings['encoding']})}><option value="utf8">UTF-8</option><option value="gbk">GBK</option><option value="gb18030">GB18030</option></select></Field>
        <Field label="初始DTR"><select aria-label="UART初始DTR" disabled={blocked} value={String(settings.dtr_on_open)} onChange={e=>patch({dtr_on_open:e.target.value==='true'})}><option value="false">低电平</option><option value="true">高电平</option></select></Field>
        <Field label="初始RTS"><select aria-label="UART初始RTS" disabled={blocked||settings.flow==='hardware'} value={settings.rts_on_open===null?'managed':String(settings.rts_on_open)} onChange={e=>patch({rts_on_open:e.target.value==='true'})}><option value="false">低电平</option><option value="true">高电平</option>{settings.flow==='hardware'&&<option value="managed">由硬件流控管理</option>}</select></Field>
      </div></details>
      {!profileId&&<label className="check"><input type="checkbox" aria-label="保存UART连接" disabled={blocked} checked={save} onChange={e=>setSave(e.target.checked)}/>保存连接（可选）</label>}
      <div className="config-actions"><button type="submit" disabled={blocked||!device||!inventory}>连接串口</button>{unknown&&<button type="button" disabled={busy} onClick={()=>void query()}>查询串口连接结果</button>}</div>
    </form>
  </Panel>;
}
