import {useState} from 'react';
import {Panel,Field,ErrorNotice} from './ui';
import type {PaneLive} from './pane-layout';
export function SplitPanel({first,connections,label,apply,close}:{first:PaneLive;connections:PaneLive[];label(c:PaneLive):string;apply(second:PaneLive,direction:'horizontal'|'vertical'):Promise<void>;close():void}){
 const [direction,setDirection]=useState<'horizontal'|'vertical'>('horizontal'),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const eligible=connections.filter(c=>c.connection_id!==first.connection_id&&c.state==='CONNECTED'&&['SSH2','SERIAL'].includes(c.protocol));const second=eligible.find(c=>`${c.connection_id}/${c.generation}`===selected);
 return <Panel title="分屏" close={close} closeLabel="取消分屏设置"><p>同时查看两个现有连接，键盘只输入到当前窗格。收起窗格保留连接。</p><p>第一个会话：{label(first)} · {first.protocol} · 代次 {first.generation} · {first.connection_id.slice(0,8)}</p>{error&&<ErrorNotice title="分屏未完成">{error}</ErrorNotice>}
 <form onSubmit={e=>{e.preventDefault();if(!second||busy)return;setBusy(true);setError('');void apply({...second},direction).catch(()=>setError('会话、代次或布局已变化，请关闭后重新选择。没有新建连接或发送输入。')).finally(()=>setBusy(false));}}>
 <Field label="排列方向"><select aria-label="分屏排列方向" disabled={busy} value={direction} onChange={e=>setDirection(e.target.value as typeof direction)}><option value="horizontal">左右</option><option value="vertical">上下</option></select></Field>
 <Field label="第二个会话"><select aria-label="分屏第二个会话" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">请选择另一个已连接会话</option>{eligible.map(c=><option key={`${c.connection_id}/${c.generation}`} value={`${c.connection_id}/${c.generation}`}>{label(c)} · {c.protocol} · 代次 {c.generation} · {c.connection_id.slice(0,8)}</option>)}</select></Field>
 {!eligible.length&&<p>请先连接另一个SSH或串口会话，再设置分屏。</p>}<small>最多两个窗格；已有保存配置的目标可从工作区保存排列。</small><button disabled={busy||!second}>创建分屏</button></form></Panel>;
}
