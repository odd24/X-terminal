import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {Panel,ErrorNotice} from './ui';
import {terminalAppearance} from './appearance';
import {visibleControls} from './log-search';
import {inspectContinuousTargets} from './broadcast-api';
import type {BroadcastTarget} from './broadcast';
import type {ContinuousInput} from './continuous-input';

type Candidate={connection_id:string;generation:number;protocol:string;state:string;label:string};
const key=(c:Pick<Candidate,'connection_id'|'generation'|'protocol'>)=>`${c.connection_id}/${c.generation}/${c.protocol}`;
function SyncKeyboard({run}:{run:ContinuousInput}){
 const host=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const term=new Terminal({cols:60,rows:3,scrollback:0,cursorBlink:true,...terminalAppearance(),fontSize:15}),fit=new FitAddon();term.loadAddon(fit);term.open(host.current!);fit.fit();
  term.textarea?.setAttribute('aria-label','连续同步键盘输入');
  const data=term.onData(text=>{run.input(text);});
  term.attachCustomKeyEventHandler(e=>{
   if(e.type!=='keydown')return true;
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();run.stop('Esc已停止同步；该键未群发');return false;}
   if((e.ctrlKey||e.metaKey)&&(e.key.toLowerCase()==='v'||e.shiftKey&&e.key.toLowerCase()==='c')||e.shiftKey&&e.key==='Insert'){e.preventDefault();run.stop('剪贴板快捷键已停止同步；请使用多目标文本预览，未群发剪贴板');return false;}
   return true;
  });
  const blur=()=>run.stop('窗口失焦已停止同步；不会自动恢复'),hidden=()=>{if(document.hidden)blur();};
  window.addEventListener('blur',blur);document.addEventListener('visibilitychange',hidden);
  const observer=new ResizeObserver(()=>fit.fit());observer.observe(host.current!);term.focus();
  return()=>{run.stop('专用输入区已关闭，未开始尾部已停止');window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',hidden);observer.disconnect();data.dispose();term.dispose();};
 },[run]);
 return <div className="terminal synchronized-keyboard" aria-label="连续同步专用输入区" ref={host} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))run.stop('已离开专用键盘区，未开始尾部已停止');}} onPasteCapture={e=>{e.preventDefault();e.stopPropagation();run.stop('粘贴已拦截并停止同步；请使用多目标文本预览，未群发剪贴板');}} onDrop={e=>{e.preventDefault();run.stop('拖放已停止同步；未群发正文');}}/>;
}

export function ContinuousInputPanel({owner,connections,run,close}:{owner:string;connections:readonly Candidate[];run:ContinuousInput;close():void}){
 const [selected,setSelected]=useState(new Set<string>()),[proposal,setProposal]=useState<BroadcastTarget[]>(),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[querying,setQuerying]=useState(''),[snapshot,setSnapshot]=useState(()=>run.snapshot());
 const mounted=useRef(true),nonce=useRef(0),ownerRef=useRef(owner);ownerRef.current=owner;
 const signature=connections.map(c=>`${key(c)}/${c.state}/${c.label}`).join('|');
 function invalidate(){nonce.current++;setProposal(undefined);setConfirmed(false);setBusy(false);setError('');}
 useEffect(()=>{mounted.current=true;const off=run.subscribe(()=>{if(mounted.current)setSnapshot(run.snapshot());});return()=>{mounted.current=false;nonce.current++;off();run.stop('连续同步窗口已关闭，未开始尾部已停止');};},[run]);
 useEffect(()=>{invalidate();setSelected(new Set());run.stop('服务已变化，未开始尾部已停止');},[owner]);
 useEffect(()=>{invalidate();setSelected(s=>new Set([...s].filter(id=>connections.some(c=>key(c)===id&&c.state==='CONNECTED'))));const fixed=run.snapshot();if(fixed.enabled&&fixed.totals.some(r=>!connections.some(c=>key(c)===key(r.target)&&c.state==='CONNECTED')))run.stop('固定目标已变化或断开，已停止同步；不改投新代次');},[signature]);
 const disabled=busy||snapshot.enabled||snapshot.working;
 async function preview(){
  if(disabled||!owner)return;const source=owner,version=++nonce.current,targets=[...selected].map(id=>connections.find(c=>key(c)===id)).filter((c):c is Candidate=>!!c);
  if(targets.length<2||targets.length>8){setError('请明确选择2–8个已连接目标。');return;}
  setBusy(true);setProposal(undefined);setConfirmed(false);setError('');
  try{const fixed=await inspectContinuousTargets(source,targets);if(mounted.current&&version===nonce.current&&source===ownerRef.current)setProposal(fixed);}
  catch(e){if(mounted.current&&version===nonce.current)setError(e instanceof Error?e.message:'目标核对失败，未启用。');}
  finally{if(mounted.current&&version===nonce.current)setBusy(false);}
 }
 function arm(){if(!proposal||!confirmed||disabled)return;try{const fixed=proposal;invalidate();setSelected(new Set());run.arm(owner,fixed);}catch(e){setError((e as Error).message);}}
 async function query(id:string){if(querying)return;setQuerying(id);try{await run.query(id);}finally{if(mounted.current)setQuerying('');}}
 return <Panel title="连续同步键盘" label="连续同步键盘面板" close={()=>{run.stop();close();}} closeLabel="关闭连续同步">
  {error&&<ErrorNotice title="连续同步未启用">{error}</ErrorNotice>}
  <p>仅下面的专用键盘区同步到明确选择的2–8个目标。普通终端与认证表单不参与；切标签不扩大集合。启用不发送，键入才发送，不显示本地正文，也不把本地光标当远端回执。</p>
  <fieldset disabled={disabled||!owner}><legend>固定目标（默认不选）</legend>{connections.filter(c=>['SSH2','SERIAL'].includes(c.protocol)).map(c=><label className="check" key={key(c)}><input type="checkbox" aria-label={`连续同步选择 ${c.connection_id}/${c.generation}`} checked={selected.has(key(c))} disabled={c.state!=='CONNECTED'||!selected.has(key(c))&&selected.size>=8} onChange={e=>{invalidate();setSelected(previous=>{const next=new Set(previous);if(e.target.checked)next.add(key(c));else next.delete(key(c));return next;});}}/>{visibleControls(c.label)} · {c.protocol} · 代次 {c.generation} · {c.connection_id.slice(0,8)} · {c.state}</label>)}</fieldset>
  <button disabled={disabled||!owner||selected.size<2} onClick={()=>void preview()}>预览连续同步目标</button>
  {proposal&&<fieldset aria-label="连续同步预览"><legend>核对本次持续输入范围</legend><ol>{proposal.map(t=><li key={key(t)}>{visibleControls(t.label)} · {t.protocol} · {t.encoding} · {t.connection_id} / {t.generation}</li>)}</ol><p>按终端键盘序列及各连接编码发送，Enter为CR，退格/方向/Ctrl组合沿终端语义，不自动补换行。不能用于输入密码；远端程序的密码提示无法自动识别。目标认证中、Agent租约占用或核对失败拒发。租约预检并非原子锁，最终仍由原服务执行人工接管。</p><label className="check"><input type="checkbox" aria-label="确认连续同步范围与人工接管" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>已核对固定范围，同意仅该键盘区持续人工输入及原服务接管；可能撤下对应Agent写/控制和未开始动作。</label><button disabled={!confirmed||disabled} onClick={arm}>启用连续同步键盘</button><button onClick={invalidate}>取消连续同步预览</button></fieldset>}
  <p role="status" aria-label="连续同步状态">{snapshot.enabled?'同步已启用':snapshot.working?'已停止，等待在途回执':'同步未启用'} · {snapshot.reason}。停止后须重新选择、预览并明确启用，不能撤回已发动作。</p>
  {snapshot.enabled&&<><strong aria-label="连续同步活动范围">正在向 {snapshot.totals.length} 个固定目标同步：{snapshot.totals.map(t=>`${visibleControls(t.target.label)} (${t.target.protocol})`).join('；')}。Esc停止且不群发，离开键盘区/窗口失焦/粘贴也停止。</strong><SyncKeyboard run={run}/><button onClick={()=>run.stop()}>停止连续同步</button></>}
  <small>队列含在途最多16项，仅合并未发的同类键；每段最多4KiB。任一目标未就绪、拒绝、结果不明或队列满都会停止全部未发输入，不自动重连/续发。部分目标可能已收到前缀，没有跨目标回滚。粘贴请另用“多目标发送”文本预览。</small>
  {!!snapshot.totals.length&&<section aria-label="连续同步逐目标回执"><h3>本次固定目标与发送回执</h3><p>服务 {snapshot.owner} · 已开始 {snapshot.packets} 段；仅本窗口计数及最后一段原编号，重载清空。接受仅指SSH管线/串口驱动，不代表远端执行。</p><ul>{snapshot.totals.map(t=>{const row=snapshot.results.find(r=>key(r.target)===key(t.target));return <li key={key(t.target)} data-sync-target={t.target.connection_id} data-sync-state={row?.state??'WAITING'}><strong>{visibleControls(t.target.label)} · {t.target.protocol} · {t.target.encoding}</strong><details><summary>完整目标身份</summary>{t.target.connection_id} / 代次 {t.target.generation}</details><p>已接受 {t.accepted} 段 / {t.bytes} 字节 · {row?.state??'WAITING'} · {row?.message??'尚未键入'}</p>{row&&<><small>请求 {row.request_id}</small>{['ACCEPTED','REJECTED','UNKNOWN'].includes(row.state)&&<button aria-label={`查询连续同步原编号 ${row.request_id}`} disabled={snapshot.enabled||snapshot.working||!!querying||owner!==snapshot.owner} onClick={()=>void query(row.request_id)}>仅查询此原编号</button>}</>}</li>;})}</ul></section>}
 </Panel>;
}
