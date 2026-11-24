import {useLayoutEffect,useRef,useState} from 'react';
import {config,ConfigRequestError,readConfiguration,type Profile} from './config-api';

type Target = {profile:Profile; revision:string};
type Mode = 'confirm'|'deleting'|'uncertain'|'checking'|'failed';
type Deletion = {target:Target;mode:Mode;notice?:string};
export type ProfileDeletionResult = {
  id:string; exists:boolean; revision:string; message:string;
  snapshot?:Awaited<ReturnType<typeof readConfiguration>>;
};

export function useProfileDeletion(completed:(result:ProfileDeletionResult)=>void) {
  const [state,setState]=useState<Deletion>();
  const flight=useRef(false);
  const mounted=useRef(false);
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function start(profile:Profile,revision:string) {
    if(!revision||state||flight.current)return;
    setState({target:{profile,revision},mode:'confirm'});
  }
  function cancel() {
    if(!state||flight.current||state.mode==='uncertain')return false;
    setState(undefined);
    return true;
  }
  function finish(result:ProfileDeletionResult) {
    if(!mounted.current)return;
    setState(undefined);
    completed(result);
  }
  async function confirm() {
    if(state?.mode!=='confirm'||flight.current)return;
    const {target}=state;
    const id=target.profile.id;
    flight.current=true;
    setState({target,mode:'deleting'});
    try {
      const reply=await config({op:'delete_profile_if_revision',id,revision:target.revision});
      if(reply.result!=='updated'||!reply.revision||reply.revision===target.revision)
        throw new ConfigRequestError('INVALID_CONFIGURATION_REPLY',true);
      finish({id,exists:false,revision:reply.revision,message:'所选保存配置已删除。'});
    } catch(error) {
      if(!mounted.current)return;
      const uncertain=!(error instanceof ConfigRequestError)||error.uncertain;
      setState({target,mode:uncertain?'uncertain':'failed',
        notice:uncertain?'删除结果不明。请只读核对原配置。':error.message});
    } finally {flight.current=false;}
  }
  async function check() {
    if(state?.mode!=='uncertain'||flight.current)return;
    const {target}=state;
    const id=target.profile.id;
    flight.current=true;
    setState({target,mode:'checking'});
    try {
      const snapshot=await readConfiguration();
      const exists=snapshot.profiles.some(profile=>profile.id===id);
      finish({id,exists,revision:snapshot.revision,snapshot,
        message:exists?'核对时原配置仍存在。如需删除，请重新选择。':'原配置已不存在。'});
    } catch {
      if(mounted.current)setState({target,mode:'uncertain',notice:'读取配置失败。可再次只读核对。'});
    } finally {flight.current=false;}
  }
  return {state,start,cancel,confirm,check};
}

export function ProfileDeletionConfirmation({deletion,onCancel,onConfirm,onCheck}:{
  deletion:Deletion;onCancel():void;onConfirm():void;onCheck():void;
}) {
  const {target,mode,notice}=deletion;
  const {name,id,settings}=target.profile;
  const preferred=useRef<HTMLButtonElement>(null);
  const heading=useRef<HTMLHeadingElement>(null);
  useLayoutEffect(()=>{
    (preferred.current&&!preferred.current.disabled?preferred.current:heading.current)?.focus({preventScroll:true});
  },[mode]);
  const initial=mode==='confirm'||mode==='deleting';
  return <section className="profile-deletion" aria-label="删除保存配置确认">
    <h2 ref={heading} tabIndex={-1}>{initial?'删除会话配置？':'删除会话配置'}</h2>
    <strong>{name}</strong>
    <p>{settings.protocol.toUpperCase()} · {'host' in settings?`${settings.host}:${settings.port}`:settings.port}</p>
    <small>配置编号 {id}</small>
    <p>现有连接、日志和共享凭据会保留。</p>
    <p role="status">{notice??(mode==='deleting'?'正在删除配置…':mode==='checking'?'正在读取原配置…':'')}</p>
    <div className="config-actions">
      {initial&&<>
        <button type="button" ref={preferred} data-dialog-autofocus disabled={mode==='deleting'} onClick={onCancel}>取消删除</button>
        <button type="button" className="profile-delete-confirm" disabled={mode==='deleting'} onClick={onConfirm}>确认删除此配置</button>
      </>}
      {(mode==='uncertain'||mode==='checking')&&<button type="button" ref={preferred} disabled={mode==='checking'} onClick={onCheck}>只读核对删除结果</button>}
      {mode==='failed'&&<button type="button" ref={preferred} onClick={onCancel}>返回</button>}
    </div>
  </section>;
}
