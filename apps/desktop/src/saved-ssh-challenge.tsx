import {useLayoutEffect,useRef,useState} from 'react';
import type {Challenge} from './ssh-api';
import {ErrorNotice,Panel} from './ui';

type HostChallenge=Extract<Challenge,{kind:'host_key'}>;

export function sshEndpoint(host:string,port:number){
  return (host.includes(':')&&!host.startsWith('[')?'['+host+']':host)+':'+port;
}

export function SavedHostChallenge({challenge,busy,submitted,error,approve,stop}:{
  challenge:HostChallenge;busy:boolean;submitted:boolean;error:string;approve():void;stop():void;
}){
  const stopButton=useRef<HTMLButtonElement>(null);
  const [copyStatus,setCopyStatus]=useState('');
  const {candidate,known,status}=challenge.review;
  const changed=status==='changed';
  useLayoutEffect(()=>{stopButton.current?.focus();},[challenge.id]);
  async function copy(value:string){
    try{await navigator.clipboard.writeText(value);setCopyStatus('指纹已复制。');}
    catch{setCopyStatus('无法访问剪贴板，可选中指纹文本复制。');}
  }
  return <Panel compact title={changed?'服务器指纹已变化':'首次连接，请确认服务器身份'}
    label="SSH服务器身份核验" close={stop} closeLabel="收起连接窗口">
    <p>配置已保存 · <strong aria-label="SSH核验目标">{sshEndpoint(candidate.endpoint.host,candidate.endpoint.port)}</strong></p>
    {changed&&<ErrorNotice title="请先停止并核对新指纹">指纹变化可能来自服务器更换、重装或连接被拦截。请通过可信渠道确认后再更新。</ErrorNotice>}
    {!changed&&<p>请向服务器管理员或从可信管理渠道取得指纹，与下方 SHA256 指纹逐字核对。</p>}
    {changed&&known.map(key=><div key={key.algorithm} className="ssh-fingerprint-review">
      <small>原记录 · {key.algorithm}</small>
      <code className="fingerprint" aria-label="原服务器指纹">{key.fingerprint}</code>
      <button type="button" onClick={()=>void copy(key.fingerprint)}>复制原指纹</button>
    </div>)}
    <div className="ssh-fingerprint-review">
      <small>{changed?'新指纹':'服务器指纹'} · {candidate.algorithm}</small>
      <code className="fingerprint" aria-label="当前服务器指纹">{candidate.fingerprint}</code>
      <button type="button" onClick={()=>void copy(candidate.fingerprint)}>复制指纹</button>
    </div>
    {error&&<ErrorNotice>{error}</ErrorNotice>}
    {copyStatus&&<small role="status">{copyStatus}</small>}
    <div className="config-actions">
      <button type="button" ref={stopButton} data-dialog-autofocus onClick={stop}>{changed?'停止连接':'暂不连接'}</button>
      <button type="button" className={changed?undefined:'primary-action'} disabled={busy||submitted}
        onClick={approve}>{changed?'更新指纹并继续':'指纹一致，信任并继续'}</button>
    </div>
  </Panel>;
}
