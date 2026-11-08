import { useEffect, useRef, useState } from 'react';
import { readConfiguration, type Profile } from './config-api';
import { requestId } from './request-id';
import { serial, serialResult, reference, type Inventory, type SerialStatus } from './serial-api';
import type { Connection } from './ssh-api';
import { invoke } from '@tauri-apps/api/core';

export function SerialPanel({ connection, select, requestedProfile, controlsOnly=false, summaryOnly=false, tools, closePanel }: { connection?: Connection; select(id: string,expected?:{connection_id:string;generation:number}): void; requestedProfile?: string; controlsOnly?:boolean; summaryOnly?:boolean; tools?():void; closePanel?():void }) {
  const [profiles,setProfiles]=useState<Profile[]>([]); const [profileId,setProfileId]=useState('');
  const [inventory,setInventory]=useState<Inventory>(); const [deviceId,setDeviceId]=useState('');
  const [status,setStatus]=useState<SerialStatus>(); const [approved,setApproved]=useState(false);
  const [message,setMessage]=useState('选择配置并只读刷新设备；核对端口、身份及开口控制线后手动连接。');
  const [busy,setBusy]=useState(false); const running=useRef(false); const mounted=useRef(true); const current=useRef(connection); current.current=connection;
  const [content,setContent]=useState(''); const [format,setFormat]=useState<'text'|'hex'>('text'); const [ending,setEnding]=useState<'none'|'cr'|'lf'|'cr_lf'>('none');
  const [chunk,setChunk]=useState(1024); const [interval,setInterval]=useState(0); const [receiptId,setReceiptId]=useState('');
  const [hexRows,setHexRows]=useState<string[]>([]); const [hexTrimmed,setHexTrimmed]=useState(false); const [hexGap,setHexGap]=useState(false);
  const profile=profiles.find(item=>item.id===profileId); const settings=profile?.settings.protocol==='serial'?profile.settings:undefined;
  const device=inventory?.devices.find(item=>item.device_id===deviceId);
  async function refresh(){const [configuration,devices]=await Promise.all([readConfiguration(),serial({op:'inventory'})]);if(devices.result!=='inventory')throw new Error('设备目录响应不匹配。');if(mounted.current){setProfiles(configuration.profiles.filter(item=>item.settings.protocol==='serial'));setInventory(devices);setDeviceId('');setApproved(false);}}
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!requestedProfile)return;let disposed=false;void readConfiguration().then(result=>{if(!disposed){setProfiles(result.profiles.filter(item=>item.settings.protocol==='serial'));setProfileId(requestedProfile);setDeviceId('');setApproved(false);}}).catch(error=>{if(!disposed)setMessage((error as Error).message);});return()=>{disposed=true;};},[requestedProfile]);
  useEffect(()=>{setStatus(undefined);setContent('');setReceiptId('');if(connection?.protocol!=='SERIAL')return;let disposed=false;let timer=0;const target=reference(connection);
    async function poll(){try{const reply=await serial({op:'status',connection:target});if(disposed)return;if(reply.result!=='status'||reply.connection.connection_id!==target.connection_id||reply.connection.generation!==target.generation)throw new Error('串口状态响应不匹配。');setStatus(reply);timer=window.setTimeout(()=>void poll(),250);}catch(error){if(!disposed)setMessage((error as Error).message);}}
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[connection?.connection_id,connection?.generation,connection?.protocol]);
  useEffect(()=>{setHexRows([]);setHexTrimmed(false);setHexGap(false);if(summaryOnly||connection?.protocol!=='SERIAL')return;let disposed=false;let timer=0;let cursor=1;let count=0;const target=reference(connection);
    async function read(){try{const page=await invoke<{connection:{connection_id:string;generation:number};events:{seq:number;bytes:number[];gap_bytes?:number}[];next_cursor:number;truncated:boolean}>('service_read',{connection:target,cursor});if(disposed)return;if(page.connection.connection_id!==target.connection_id||page.connection.generation!==target.generation)throw new Error('HEX读取目标不匹配。');const rows:string[]=[];if(page.truncated){rows.push('[保留输出已覆盖，存在缺口]');setHexGap(true);}for(const event of page.events){if(event.gap_bytes){rows.push(`[接收缺口：丢失 ${event.gap_bytes} 字节]`);setHexGap(true);}for(let offset=0;offset<event.bytes.length;offset+=16)rows.push(`${event.seq}: `+event.bytes.slice(offset,offset+16).map(byte=>byte.toString(16).padStart(2,'0').toUpperCase()).join(' '));}count+=rows.length;if(count>256)setHexTrimmed(true);if(rows.length)setHexRows(values=>[...values,...rows].slice(-256));cursor=page.next_cursor;timer=window.setTimeout(()=>void read(),250);}catch(error){if(!disposed)setMessage((error as Error).message);}}
    void read();return()=>{disposed=true;clearTimeout(timer);};
  },[connection?.connection_id,connection?.generation,connection?.protocol,summaryOnly]);
  async function act(action:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);try{await action();}catch(error){if(mounted.current)setMessage((error as Error).message);}finally{running.current=false;if(mounted.current)setBusy(false);}}
  function target(){if(!status||status.connection.connection_id!==current.current?.connection_id||status.connection.generation!==current.current.generation)throw new Error('连接已切换，请等待状态刷新。');return reference(status.connection);}
  async function close(){try{const connection=target();await serial({op:'close',connection});if(mounted.current)setMessage('已停止后续发送并请求关闭；已被驱动接受的字节不会撤销，正在等待句柄清理。');}catch(error){if(mounted.current)setMessage((error as Error).message);}}
  if(summaryOnly){const labels:Record<string,string>={CONNECTING:'正在打开',CONNECTED:'已连接，持续接收',DISCONNECTED:'已断开',FAILED:'连接异常',CLOSING:'正在断开'};const failures:Record<string,string>={DEVICE_UNAVAILABLE:'设备不可用，请检查连接后刷新端口',ACCESS_OR_BUSY:'端口被占用或权限不足',IO:'通信中断，请检查接线和设备',INVALID_PARAMETERS:'设备不支持当前参数',CANCELLED:'连接已取消',WORKER_FAILED:'串口线程异常'};
    return <div aria-label="串口快捷操作"><div className="config-actions"><span role="status" aria-label="UART连接状态">{status?`${status.port} · ${labels[status.connection.state]??'正在读取状态'} · 接收 ${status.read_bytes} 字节${status.dropped_bytes?` · 缺口 ${status.dropped_bytes} 字节`:''}`:'正在读取串口状态…'}</span><button onClick={tools}>发送与接收详情</button><button disabled={!status||['DISCONNECTED','FAILED'].includes(status.connection.state)} onClick={()=>void close()}>断开串口</button></div>{status?.failure&&<p role="alert">{failures[status.failure]??'串口发生错误，请打开详情核对；没有自动重连。'}</p>}{message!=='选择配置并只读刷新设备；核对端口、身份及开口控制线后手动连接。'&&<p role="status">{message}</p>}</div>;}
  return <section className="config-panel serial-panel" aria-label="串口连接面板">
    {!controlsOnly&&<>
    <div className="config-heading"><h2>串口连接与发送</h2><button disabled={busy} onClick={()=>void act(refresh)}>刷新串口配置与设备</button></div>
    <p role="status">{message}</p>
    <div className="form-grid"><label>配置<select aria-label="串口配置" value={profileId} onChange={event=>{setProfileId(event.target.value);setApproved(false);}}><option value="">请选择配置</option>{profiles.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>当前设备<select aria-label="串口设备" value={deviceId} onChange={event=>{setDeviceId(event.target.value);setApproved(false);}}><option value="">请选择设备</option>{inventory?.devices.map(item=><option key={item.device_id} value={item.device_id}>{item.port} · {item.instance_id}</option>)}</select></label></div>
    {inventory&&<small>可识别 {inventory.devices.length} 项；未识别端口：{inventory.unidentified_ports.join('、')||'无'}；元数据失败 {inventory.metadata_failures} 项。刷新后须重新选择，未识别项不按 COM 号回退打开。</small>}
    {settings&&<p aria-label="串口参数">{settings.port} · {settings.baud_rate} · {settings.data_bits}/{settings.parity}/{settings.stop_bits} · 流控 {settings.flow} · 编码 {settings.encoding} · DTR {String(settings.dtr_on_open)} · RTS {settings.rts_on_open===null?'由硬件流控管理':String(settings.rts_on_open)}</p>}
    <label className="check"><input aria-label="确认串口设备与控制线" type="checkbox" checked={approved} onChange={event=>setApproved(event.target.checked)} />已核对设备身份与参数；打开期间控制线变化可能使设备复位</label>
    <button disabled={busy||!approved||!settings||!device||device.port!==settings.port} onClick={()=>void act(async()=>{if(!inventory||!device)throw new Error('请刷新并选择设备。');const reply=await serial({op:'start',profile_id:profileId,request_id:requestId(),revision:inventory.revision,device_id:device.device_id});if(reply.result!=='started')throw new Error('串口启动响应不匹配。');if(mounted.current){select(reply.connection.connection_id,reply.connection);setApproved(false);setMessage('已提交打开请求，请等待实际连接状态。');}})}>打开串口</button>
    </>}
    {controlsOnly&&<><div className="config-heading"><h2>串口通信</h2>{closePanel&&<button onClick={closePanel}>关闭串口详情</button>}</div><p role="status">{message==='选择配置并只读刷新设备；核对端口、身份及开口控制线后手动连接。'?'连接后持续接收；只抓取UART输出无需发送。':message}</p></>}
    {status&&<><p aria-label="串口状态">{status.connection.state} · {status.port} · {status.connection.connection_id} · 代次 {status.connection.generation} · 编码 {status.encoding}{status.failure&&` · ${status.failure}`}{status.cleanup_pending&&' · 正在清理句柄'} · 接收 {status.read_bytes} 字节 / 丢失 {status.dropped_bytes} 字节{status.break_cleanup_failure&&` · Break 清理失败 ${status.break_cleanup_failure}`}</p>
      <div className="config-actions"><button disabled={['DISCONNECTED','FAILED'].includes(status.connection.state)} onClick={()=>void close()}>停止发送并关闭串口</button><button disabled={busy||status.cleanup_pending||!['DISCONNECTED','FAILED'].includes(status.connection.state)} onClick={()=>void act(async()=>{const connection=target();const reply=await serial({op:'forget',connection});if(reply.result!=='accepted')throw new Error('移除响应不匹配。');if(mounted.current&&current.current?.connection_id===connection.connection_id){setStatus(undefined);select('');setMessage('连接记录及保留输出/回执已移除，配置仍保留。');}})}>移除串口记录</button></div>
      <details open={!controlsOnly}><summary>发送、HEX与控制线</summary><small>终端按本连接的 UTF-8/GBK/GB18030 编码快照增量解码；输出缺口会清屏并重置解析状态。发送按本连接的编码快照处理；HEX 字节不转码。关闭面板或重载不会撤销已提交发送。</small>
      <fieldset disabled={busy||status.connection.state!=='CONNECTED'}><legend>单批发送</legend>
        <label>格式<select aria-label="串口发送格式" value={format} onChange={event=>setFormat(event.target.value as typeof format)}><option value="text">文本</option><option value="hex">HEX</option></select></label>
        <label>换行<select aria-label="串口发送换行" value={ending} onChange={event=>setEnding(event.target.value as typeof ending)}><option value="none">不追加</option><option value="cr">CR</option><option value="lf">LF</option><option value="cr_lf">CRLF</option></select></label>
        <label>内容<textarea aria-label="串口发送内容" value={content} onChange={event=>setContent(event.target.value)} maxLength={196608} /></label>
        <div className="form-grid"><label>每段字节<input aria-label="串口每段字节" type="number" min="1" max="1024" value={chunk} onChange={event=>setChunk(Number(event.target.value))}/></label><label>段间最小间隔 ms<input aria-label="串口段间隔" type="number" min="0" max="1000" value={interval} onChange={event=>setInterval(Number(event.target.value))}/></label></div>
        <small>最多 64 KiB（含追加换行），计划间隔总计最多 60 秒；实际时间受驱动与排队影响。</small>
        <button onClick={()=>{const text=content;void act(async()=>{const connection=target();const id=requestId();setContent('');setReceiptId(id);const reply=await serial({op:'send',connection,request_id:id,content:text,format,ending,pace:{chunk_bytes:chunk,interval_ms:interval}});const receipt=await serialResult(connection,reply,()=>mounted.current);if(mounted.current)setMessage(`目标 ${connection.connection_id} / ${connection.generation} · ${receipt.state} · 驱动接受下界 ${receipt.driver_accepted??'—'} 字节${receipt.failure?` · ${receipt.failure}`:''}；不代表设备已执行，未重发。`);});}}>发送串口内容</button>
      </fieldset>
      <fieldset disabled={busy||status.connection.state!=='CONNECTED'}><legend>控制线</legend>{(['DTR','RTS','BREAK'] as const).map(line=><span key={line}>{[true,false].map(asserted=><button key={String(asserted)} disabled={line==='RTS'&&status.hardware_rts} onClick={()=>void act(async()=>{const connection=target();const reply=await serial({op:'control',connection,request_id:requestId(),line,asserted});const receipt=await serialResult(connection,reply,()=>mounted.current);if(mounted.current)setMessage(`目标 ${connection.connection_id} · ${line} ${asserted?'开启':'关闭'}：${receipt.state}${receipt.failure?` · ${receipt.failure}`:''}；清理失败见状态。`);})}>{line} {asserted?'开启':'关闭'}</button>)}</span>)}</fieldset>
      {receiptId&&<small aria-label="串口最近请求">最近发送请求：{receiptId}。切换连接不会把它转发到新连接。</small>}
      <details open><summary>原始 HEX 接收</summary><small>独立读取游标，保留最近 256 行；每行前缀是输出事件序号。{hexTrimmed&&'本页较早内容已裁剪。'}{hexGap&&'已检测到接收或保留输出缺口。'}</small><pre aria-label="串口HEX接收">{hexRows.join('\n')||'尚无原始字节'}</pre></details>
      </details>
    </>}
  </section>;
}
