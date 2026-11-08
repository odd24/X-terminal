import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Panel, Field } from './ui';
import { config, readConfiguration, type Auth, type Profile, type Settings } from './config-api';
import { ssh, SshRequestError, reference, type Connection, type ConnectionRef, type SshStatus } from './ssh-api';
import { requestId } from './request-id';

type Attempt = { id: string; connection?: ConnectionRef; secret?: { password: string; key: string; passphrase: string; saved?: boolean }; cancelled: boolean };
const ended = (state?: string) => state === 'FAILED' || state === 'DISCONNECTED';
const states: Record<string,string> = { CONNECTING:'正在连接服务器…', AUTHENTICATING:'正在验证登录信息…', CONNECTED:'已连接，可以在终端工作', DISCONNECTED:'连接已断开', FAILED:'连接未成功', CLOSING:'正在断开…' };
const failures: Record<string,string> = { TRANSPORT_TIMEOUT:'连接超时，请检查服务器地址、端口和网络。', TRANSPORT:'连接中断或服务器不可达，请检查网络和SSH服务。', HOST_KEY_REJECTED:'未信任此服务器，本次未继续登录。', HOST_KEY_CONFLICT:'主机指纹状态已变化，请重新核对。', APPROVAL_TIMEOUT:'确认已超时，请重新连接。', AUTHENTICATION_REJECTED:'用户名或密码/密钥未被服务器接受，请核对后重试。', CREDENTIAL_UNAVAILABLE:'无法读取密钥或凭据，请检查本地文件和口令。', CANCELLED:'本次连接已取消。', CONFIGURATION:'连接参数不可用，请检查配置。' };
export function QuickConnect({ connection, select, size, focus, close }: { connection?: Connection; select(id:string):void; size():{cols:number;rows:number}; focus():void; close():void }) {
  const [host,setHost]=useState(''),[username,setUsername]=useState(''),[port,setPort]=useState(22);
  const [auth,setAuth]=useState<Auth>('password'),[encoding,setEncoding]=useState<'utf8'|'gbk'|'gb18030'>('utf8');
  const [password,setPassword]=useState(''),[key,setKey]=useState(''),[passphrase,setPassphrase]=useState('');
  const [save,setSave]=useState(false),[remember,setRemember]=useState(false),[saved,setSaved]=useState<Profile[]>([]),[savedId,setSavedId]=useState('');
  const [status,setStatus]=useState<SshStatus>(),[message,setMessage]=useState('填写服务器和登录信息即可连接。'),[busy,setBusy]=useState(false),[approved,setApproved]=useState(false),[answers,setAnswers]=useState<string[]>([]),[unknown,setUnknown]=useState(false);
  const mounted=useRef(true), current=useRef(connection), attempt=useRef<Attempt | undefined>(undefined), inFlight=useRef(false), notified=useRef('');current.current=connection;
  const target=connection?.protocol==='SSH2'?connection:undefined;
  const clear=()=>{setPassword('');setPassphrase('');setAnswers([]);if(attempt.current)attempt.current.secret=undefined;};
  function active(){if(!status||status.connection.connection_id!==current.current?.connection_id||status.connection.generation!==current.current?.generation)throw new Error('连接已切换，请等待状态更新后再操作。');return {connection_id:status.connection.connection_id,generation:status.connection.generation};}
  useEffect(()=>{mounted.current=true;void readConfiguration().then(c=>{if(mounted.current)setSaved(c.profiles.filter(p=>p.settings.protocol==='ssh2'));}).catch(()=>{});return()=>{mounted.current=false;const a=attempt.current;if(a){a.cancelled=true;a.secret=undefined;const ready=a.connection?.connection_id===current.current?.connection_id&&a.connection?.generation===current.current?.generation&&current.current?.state==='CONNECTED';if(a.connection&&!ready&&notified.current!==`${a.connection.connection_id}:${a.connection.generation}`)void ssh({op:'close',connection:a.connection}).catch(()=>{});}};},[]);
  useEffect(()=>{
    setStatus(undefined);setApproved(false);setAnswers([]);
    if(!target)return;
    const ref=reference(target);let disposed=false,timer=0;
    async function poll(){
      try {
        const reply=await ssh({op:'status',connection:ref});if(disposed||reply.result!=='status'||current.current?.connection_id!==ref.connection_id||current.current.generation!==ref.generation)return;
        setStatus(reply);
        const a=attempt.current;
        if(ended(reply.connection.state)){if(a?.connection?.connection_id===ref.connection_id)a.secret=undefined;}
        if(reply.connection.state==='CONNECTED'&&notified.current!==`${ref.connection_id}:${ref.generation}`){notified.current=`${ref.connection_id}:${ref.generation}`;if(a)a.secret=undefined;setPassword('');setPassphrase('');setMessage('登录成功，直接在终端输入。');focus();}
        if(reply.challenge?.kind==='credentials'&&a?.connection?.connection_id===ref.connection_id&&a.connection.generation===ref.generation&&a.secret&&!a.cancelled){
          const secret=a.secret;a.secret=undefined;
          await ssh(secret.saved?{op:'authenticate',connection:ref,challenge_id:reply.challenge.id,use_saved:true,password:null}:reply.challenge.auth==='public_key'?{op:'authenticate_key',connection:ref,challenge_id:reply.challenge.id,key_path:secret.key,passphrase:secret.passphrase||null}:{op:'authenticate',connection:ref,challenge_id:reply.challenge.id,use_saved:false,password:secret.password});
        }
      }catch(error){if(!disposed)setMessage(String(error));}
      if(!disposed)timer=window.setTimeout(()=>void poll(),250);
    }
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[target?.connection_id,target?.generation]);
  useEffect(()=>{setApproved(false);setAnswers([]);},[status?.challenge?.id]);
  async function run(action:()=>Promise<void>){if(inFlight.current)return;inFlight.current=true;setBusy(true);try{await action();}catch(error){clear();if(mounted.current)setMessage(error instanceof Error?error.message:String(error));}finally{inFlight.current=false;if(mounted.current)setBusy(false);}}
  async function accepted(reply:Awaited<ReturnType<typeof ssh>>, a:Attempt){
    if(reply.result!=='started')throw new Error('连接回复不匹配，请查询本次请求。');
    const ref=reference(reply.connection);a.connection=ref;
    if(!mounted.current||a.cancelled){await ssh({op:'close',connection:ref});return;}
    setUnknown(false);select(ref.connection_id);setMessage('正在连接，请在此处完成必要的身份确认。');
  }
  async function connect(event:FormEvent){event.preventDefault();await run(async()=>{
    clear();const a:Attempt={id:requestId(),cancelled:false};attempt.current=a;
    const settings:Settings={protocol:'ssh2',host:host.trim(),port,username:username.trim(),auth,encoding};
    const secret={password,key,passphrase,saved:!!savedId&&!!saved.find(p=>p.id===savedId)?.credential_ref&&(auth==="public_key"?!key:!password)||save&&remember};setPassword('');setPassphrase('');a.secret=secret;
    let profileId=savedId;
    if(save&&!savedId){
      const profile={id:crypto.randomUUID(),folder_id:null,name:`${username.trim()}@${host.trim()}`,settings};
      if(remember&&auth==='public_key')await config({op:'save_profile_key_file',profile,key_path:key,passphrase:passphrase||null});
      else await config({op:'save_profile',profile,credential:remember?{action:'replace',value:{password,private_key:null,passphrase:null}}:{action:'clear'}});
      profileId=profile.id;
    }
    try {await accepted(await ssh(profileId?{op:'start',profile_id:profileId,request_id:a.id,...size()}:{op:'quick_start',settings,request_id:a.id,...size()}),a);}
    catch(error){a.secret=undefined;if(mounted.current){const known=error instanceof SshRequestError&&["InvalidArgument","NotFound","PermissionDenied","Unsupported","CapacityExceeded"].includes(error.code);setUnknown(!known);setMessage(known?error.message:`连接结果不明。先查询本次请求，不会自动再连接。${String(error)}`);} }
  });}
  async function cancel(){const a=attempt.current;if(a){a.cancelled=true;a.secret=undefined;}clear();if(target&&!ended(target.state))await ssh({op:'close',connection:reference(target)});setMessage('已取消连接，已发生的服务器动作不会撤回。');}
  const challenge=status?.challenge;
  const blocked=busy||unknown||!!target&&!ended(target.state)&&target.state!=='CONNECTED';
  const label=(status as (SshStatus&{temporary_settings?:Settings|null})|undefined)?.temporary_settings??saved.find(p=>p.id===status?.profile_id)?.settings;
  return <Panel title="连接服务器" label="SSH快速连接" close={()=>{clear();close();}} closeLabel="收起连接窗口">
    <form onSubmit={event=>void connect(event)}>
      {saved.length>0&&<Field label="已保存的连接（可选）"><select aria-label="快速连接已保存" disabled={blocked} value={savedId} onChange={e=>{clear();setSavedId(e.target.value);const p=saved.find(p=>p.id===e.target.value);if(p?.settings.protocol==='ssh2'){setHost(p.settings.host);setPort(p.settings.port);setUsername(p.settings.username);setAuth(p.settings.auth);setEncoding(p.settings.encoding);}}}><option value="">直接填写新连接</option>{saved.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <Field label="服务器地址"><input aria-label="SSH服务器" required autoFocus disabled={blocked||!!savedId} value={host} onChange={e=>setHost(e.target.value)} placeholder="例如 192.168.1.10" maxLength={1024}/></Field>
      <Field label="用户名"><input aria-label="SSH用户名" required disabled={blocked||!!savedId} value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off" maxLength={256}/></Field>
      <Field label="登录方式"><select aria-label="SSH登录方式" disabled={blocked||!!savedId} value={auth} onChange={e=>{clear();setAuth(e.target.value as Auth);}}><option value="password">密码</option><option value="public_key">密钥</option><option value="keyboard_interactive">交互认证</option></select></Field>
      {auth==='password'&&<Field label="密码"><input aria-label="SSH登录密码" type="password" autoComplete="off" disabled={busy} value={password} onChange={e=>setPassword(e.target.value)} maxLength={65536}/></Field>}
      {auth==='public_key'&&<><Field label="本地私钥文件"><input aria-label="SSH密钥文件" disabled={busy} value={key} onChange={e=>setKey(e.target.value)} placeholder="C:\Users\…\.ssh\id_ed25519"/></Field><Field label="密钥口令（如有）"><input aria-label="SSH密钥口令" type="password" autoComplete="off" disabled={busy} value={passphrase} onChange={e=>setPassphrase(e.target.value)}/></Field></>}
      <details><summary>高级连接设置</summary><Field label="端口"><input aria-label="SSH端口" type="number" min={1} max={65535} required disabled={blocked||!!savedId} value={port} onChange={e=>setPort(Number(e.target.value))}/></Field><Field label="编码"><select aria-label="SSH快速编码" disabled={blocked||!!savedId} value={encoding} onChange={e=>setEncoding(e.target.value as typeof encoding)}><option value="utf8">UTF-8</option><option value="gbk">GBK</option><option value="gb18030">GB18030</option></select></Field></details>
      {!savedId&&<><label className="check"><input aria-label="保存SSH连接" type="checkbox" disabled={blocked} checked={save} onChange={e=>{setSave(e.target.checked);setRemember(false);}}/>保存连接，便于下次使用</label>{save&&auth!=='keyboard_interactive'&&<label className="check"><input aria-label="记住SSH凭据" type="checkbox" disabled={blocked} checked={remember} onChange={e=>setRemember(e.target.checked)}/>记住凭据（Windows安全存储）</label>}</>}
      <div className="config-actions"><button type="submit" disabled={blocked}>连接</button>{unknown&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{const a=attempt.current;if(a)await accepted(await ssh({op:'start_status',request_id:a.id}),a);})}>查询本次连接</button>}<button type="button" disabled={busy} onClick={()=>void run(cancel)}>取消连接</button></div>
    </form>
    <p role="status" aria-label="SSH快速提示">{message}</p>
    {status&&<><p aria-label="SSH快速状态">{states[status.connection.state]??status.connection.state}{status.failure&&` · ${failures[status.failure]??'连接异常，请核对信息。'}`}</p>{label?.protocol==='ssh2'&&<small>当前目标：{label.username}@{label.host}:{label.port}</small>}
      {challenge?.kind==='host_key'&&<fieldset disabled={busy}><legend>确认服务器身份</legend><p>{challenge.review.status==='changed'?'服务器指纹已变化，默认不继续。请通过可信渠道核对。':'首次连接此服务器，请核对指纹。'}</p><code className="fingerprint">{challenge.review.candidate.fingerprint}</code><label className="check"><input aria-label="快速连接核对指纹" type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>我已核对服务器指纹</label><button disabled={!approved} onClick={()=>void run(async()=>{await ssh({op:'answer_host',connection:active(),challenge_id:challenge.id,approve:true});})}>信任并继续登录</button><button onClick={()=>void run(async()=>{clear();await ssh({op:'answer_host',connection:active(),challenge_id:challenge.id,approve:false});})}>拒绝连接</button></fieldset>}
      {challenge?.kind==='credentials'&&!attempt.current?.secret&&<div className="config-actions">{challenge.stored_available&&<button disabled={busy} onClick={()=>void run(async()=>{clear();await ssh({op:'authenticate',connection:active(),challenge_id:challenge.id,use_saved:true,password:null});})}>使用已记住的凭据</button>}<button disabled={busy} onClick={()=>void run(async()=>{const value=password,phrase=passphrase;clear();await ssh(challenge.auth==='public_key'?{op:'authenticate_key',connection:active(),challenge_id:challenge.id,key_path:key,passphrase:phrase||null}:{op:'authenticate',connection:active(),challenge_id:challenge.id,use_saved:false,password:value});})}>提交本次登录信息</button></div>}
      {challenge?.kind==='interactive'&&<fieldset disabled={busy}><legend>{challenge.name||'服务器认证'}</legend><p>{challenge.instructions}</p>{challenge.prompts.map((p,i)=><Field key={i} label={p.text}><input aria-label={`快速认证回答${i+1}`} type={p.echo?'text':'password'} autoComplete="off" value={answers[i]??''} onChange={e=>setAnswers(v=>{const n=[...v];n[i]=e.target.value;return n;})}/></Field>)}<button onClick={()=>void run(async()=>{const values=answers;setAnswers([]);await ssh({op:'answer_interactive',connection:active(),challenge_id:challenge.id,answers:values});})}>完成认证</button></fieldset>}
      <div className="config-actions">{!ended(status.connection.state)&&<button disabled={busy} onClick={()=>void run(cancel)}>断开连接</button>}{ended(status.connection.state)&&<button disabled={busy||unknown} onClick={()=>void run(async()=>{clear();const a:Attempt={id:requestId(),cancelled:false};attempt.current=a;try{await accepted(await ssh({op:'reconnect',connection:active(),request_id:a.id,...size()}),a);}catch(error){setUnknown(true);throw error;}})}>重新连接</button>}</div>
    </>}
    <small>不选择记住凭据时，只用于本次登录。SSH2连接通过原会话服务；基础日志在顶部“终端日志”中开始/停止。</small>
  </Panel>;
}
