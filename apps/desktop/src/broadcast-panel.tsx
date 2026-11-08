import {useEffect,useRef,useState} from 'react';
import {Panel,Field,ErrorNotice} from './ui';
import {visibleControls} from './log-search';
import {BroadcastRun,broadcastPayload,type BroadcastPlan} from './broadcast';
import {inspectBroadcastTargets} from './broadcast-api';
type Candidate={connection_id:string;generation:number;protocol:string;state:string;label:string};
const key=(c:Candidate)=>`${c.connection_id}/${c.generation}/${c.protocol}`;
export function BroadcastPanel({owner,connections,run,close}:{owner:string;connections:readonly Candidate[];run:BroadcastRun;close():void}){
 const [selected,setSelected]=useState(new Set<string>()),[text,setText]=useState(''),[ending,setEnding]=useState('none'),[proposal,setProposal]=useState<BroadcastPlan>(),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[querying,setQuerying]=useState(''),[snapshot,setSnapshot]=useState(()=>run.snapshot());
 const mounted=useRef(true),nonce=useRef(0),flight=useRef(false),currentOwner=useRef(owner);currentOwner.current=owner;
 const signature=connections.map(c=>`${key(c)}/${c.state}`).join('|');
 function invalidate(){nonce.current++;setBusy(false);setProposal(undefined);setConfirmed(false);setError('');}
 useEffect(()=>{mounted.current=true;const off=run.subscribe(()=>setSnapshot(run.snapshot()));return()=>{mounted.current=false;nonce.current++;off();run.cancel();};},[run]);
 useEffect(()=>{invalidate();setSelected(new Set());run.cancel();},[owner]);
 useEffect(()=>{invalidate();setSelected(previous=>new Set([...previous].filter(id=>connections.some(c=>key(c)===id&&c.state==='CONNECTED'))));},[signature]);
 async function preview(){if(flight.current||busy||snapshot.running||!owner)return;let payload;try{payload=broadcastPayload(text,ending);}catch(e){setError((e as Error).message);return;}const targets=[...selected].map(id=>connections.find(c=>key(c)===id)).filter((c):c is Candidate=>!!c);if(targets.length<2||targets.length>8){setError('请明确选择2–8个已连接的SSH2或串口目标。');return;}
  const version=++nonce.current,source=owner;setBusy(true);setError('');setConfirmed(false);setProposal(undefined);try{const frozen=await inspectBroadcastTargets(source,targets);if(mounted.current&&version===nonce.current&&currentOwner.current===source)setProposal({owner:source,targets:frozen,payload});}catch(e){if(mounted.current&&version===nonce.current)setError(e instanceof Error?e.message:'目标核对失败，未发送，请重新预览。');}finally{if(mounted.current&&version===nonce.current)setBusy(false);}
 }
 async function send(){if(flight.current||!proposal||!confirmed||snapshot.running||proposal.owner!==owner)return;const fixed=proposal;flight.current=true;setProposal(undefined);setConfirmed(false);setSelected(new Set());setText('');setEnding('none');setError('');try{await run.start(fixed);}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'未能开始批次，请重新预览。');}finally{flight.current=false;}}
 async function query(id:string){if(querying||snapshot.running)return;setQuerying(id);setError('');try{const ok=await run.query(id);if(mounted.current&&!ok)setError('原编号暂无法查询或服务已变化；未发送、未重试。');}finally{if(mounted.current)setQuerying('');}}
 const disabled=busy||snapshot.running;
 return <Panel title="多目标发送" label="多目标发送面板" close={()=>{nonce.current++;run.cancel();close();}} closeLabel="关闭多目标发送">
  {error&&<ErrorNotice title="多目标操作未完成">{error}</ErrorNotice>}
  <p>选择2–8个已有连接，按勾选顺序预览固定清单后发送一批文本。不跟随活动标签，不自动连接或重放。</p>
  <fieldset disabled={disabled||!owner}><legend>本次目标（默认不选）</legend>{connections.filter(c=>['SSH2','SERIAL'].includes(c.protocol)).map(c=><label className="check" key={key(c)}><input type="checkbox" aria-label={`多目标选择 ${c.connection_id}/${c.generation}`} disabled={c.state!=='CONNECTED'||!selected.has(key(c))&&selected.size>=8} checked={selected.has(key(c))} onChange={e=>{invalidate();setSelected(previous=>{const next=new Set(previous);if(e.target.checked)next.add(key(c));else next.delete(key(c));return next;});}}/>{visibleControls(c.label)} · {c.protocol} · 代次 {c.generation} · {c.connection_id.slice(0,8)} · {c.state}</label>)}{!connections.length&&<p>尚无连接，请先正常连接服务器或串口。</p>}</fieldset>
  <Field label="文本"><textarea aria-label="多目标正文" disabled={disabled||!owner} maxLength={65536} value={text} onChange={e=>{invalidate();setText(e.target.value);}}/></Field>
  <Field label="末尾追加"><select aria-label="多目标末尾换行" disabled={disabled||!owner} value={ending} onChange={e=>{invalidate();setEnding(e.target.value);}}><option value="none">不追加</option><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select></Field>
  <button disabled={disabled||!owner||selected.size<2||!text} onClick={()=>void preview()}>预览多目标发送</button>
  {proposal&&<fieldset aria-label="多目标发送预览"><legend>核对固定目标与正文</legend><ol>{proposal.targets.map(t=><li key={t.connection_id}>{visibleControls(t.label)} · {t.protocol} · {t.encoding} · 代次 {t.generation} · {t.connection_id}</li>)}</ol><pre>{visibleControls(JSON.stringify(proposal.payload))}</pre><p>UTF-8预算 {new TextEncoder().encode(proposal.payload).length} 字节；各连接按自身编码核对。逐目标独立发送，已知拒绝继续其他目标，结果不明停止尚未开始目标。管线或驱动接受不代表设备已执行，不提供跨目标回滚。</p><label className="check"><input type="checkbox" aria-label="确认本次多目标范围与人工接管" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>已核对全部目标和正文；同意按人工输入接管这些连接，撤下对应Agent写入/控制及未开始动作。已执行动作不能撤回。</label><button disabled={!confirmed} onClick={()=>void send()}>确认本次多目标发送</button><button onClick={invalidate}>取消本次多目标预览</button></fieldset>}
  {snapshot.results.length>0&&<section aria-label="多目标批次回执"><h3>{snapshot.running?'本批次正在处理':'上次批次结果'}</h3><p>服务 {snapshot.owner}。取消/关闭只停止未开始目标，不撤回当前在途请求。回执仅本窗口保留；重载会清空，原动作仍可能已执行，请勿据此重发。</p>{snapshot.running&&<button onClick={()=>run.cancel()}>停止尚未开始的目标</button>}<ul>{snapshot.results.map(r=><li key={r.request_id} data-broadcast-target={r.target.connection_id} data-broadcast-state={r.state}><strong>{visibleControls(r.target.label)} · {r.target.protocol} · 代次 {r.target.generation} · {r.target.connection_id}</strong><p>{r.state} · {r.message}{r.bytes!==null?` · 已接受 ${r.bytes} 字节`:''}</p><small>请求 {r.request_id}</small>{['UNKNOWN','ACCEPTED','REJECTED'].includes(r.state)&&<button aria-label={`查询多目标原编号 ${r.request_id}`} disabled={snapshot.running||!!querying||owner!==snapshot.owner} onClick={()=>void query(r.request_id)}>仅查询此原编号</button>}</li>)}</ul></section>}
 </Panel>;
}
