import {useEffect,useRef,useState} from 'react';
import {findSerialDevice,readSerialInventory,type Device,type Inventory} from './serial-api';
import {IconButton} from './ui';

const saved='saved-port';
type PortList = {
  key:string;
  loading:boolean;
  value:string;
  inventory?:Inventory;
  error?:string;
  lost?:boolean;
};

export function useConfigSerialPorts(draftId: string|undefined, savedPort: string|undefined) {
  const key=draftId?draftId+'/'+(savedPort??''):'';
  const [snapshot,setSnapshot]=useState<PortList>();
  const flight=useRef<symbol|undefined>(undefined);
  const state=snapshot?.key===key?snapshot:undefined;
  const selected=state?.inventory&&findSerialDevice(state.inventory.devices,state.value);
  const useSaved=!!savedPort&&(!state||state.value===saved);

  async function load(initial=false) {
    if(!key||flight.current)return;
    const ticket=Symbol();
    flight.current=ticket;
    const existing=initial?undefined:state;
    const value=existing?.value??(savedPort?saved:'');
    setSnapshot({key,value,loading:true,inventory:existing?.inventory,lost:existing?.lost});
    try {
      const inventory=await readSerialInventory();
      if(flight.current!==ticket)return;
      const stillSelected=findSerialDevice(inventory.devices,value,selected?.port);
      const lost=!!existing&&(existing.lost||!!selected&&!stillSelected);
      const firstChoice=initial
        ?savedPort?inventory.devices.find(device=>device.port===savedPort)
          :inventory.devices.length===1?inventory.devices[0]:undefined
        :undefined;
      const fallback=savedPort&&(value===saved||selected?.port===savedPort)?saved:'';
      setSnapshot({key,loading:false,inventory,lost,value:(stillSelected??firstChoice)?.device_id??fallback});
    }catch(error){
      if(flight.current!==ticket)return;
      const fallback=savedPort&&(value===saved||selected?.port===savedPort)?saved:'';
      setSnapshot({key,loading:false,value:fallback,lost:existing?.lost||!!selected,
        error:error instanceof Error?error.message:'端口清单读取失败。'});
    }finally{
      if(flight.current===ticket)flight.current=undefined;
    }
  }
  useEffect(()=>{
    if(key)void load(true);
    return ()=>{flight.current=undefined;};
  },[key]);

  return {
    busy:!!key&&(!state||state.loading),pending:()=>!!flight.current,
    selected,port:selected?.port??(useSaved?savedPort:undefined),
    inventory:state?.inventory,error:state?.error,lost:state?.lost,
    value:state?.value??(useSaved?saved:''),
    refresh:()=>void load(),
    choose:(value:string)=>setSnapshot(previous=>previous?.key===key&&!previous.loading
      ?{...previous,value,lost:false}:previous),
  };
}

export function SerialPortField({id,label,ariaLabel,devices,value,savedPort,loading,disabled,refreshDisabled,
  choose,refresh,autoFocus,errorId}:{
  id:string;label:string;ariaLabel?:string;devices:readonly Device[];value:string;savedPort?:string;
  loading:boolean;disabled:boolean;refreshDisabled:boolean;choose(value:string):void;refresh():void;
  autoFocus?:boolean;errorId?:string;
}) {
  const savedDetected=savedPort&&devices.some(device=>device.port===savedPort);
  return <div className="serial-port-field">
    <label htmlFor={id}>{label}</label>
    <div className="field-refresh-row">
      <select id={id} aria-label={ariaLabel??label} aria-invalid={!!errorId} aria-describedby={errorId}
        aria-busy={loading} required autoFocus={autoFocus} disabled={disabled} value={value}
        onChange={event=>choose(event.target.value)}>
        <option value="">{loading?'正在读取端口…':'请选择端口'}</option>
        {savedPort&&!savedDetected&&<option value={saved}>{savedPort}（当前未检测到）</option>}
        {savedPort&&savedDetected&&value===saved&&<option value={saved}>{savedPort}（已保存，请重新选择设备以确认）</option>}
        {devices.map(device=><option key={device.device_id} value={device.device_id}>
          {device.friendly_name?device.port+' · '+device.friendly_name:device.port}
        </option>)}
      </select>
      <IconButton icon="refresh" label="刷新端口" disabled={refreshDisabled} onClick={refresh}/>
    </div>
  </div>;
}
