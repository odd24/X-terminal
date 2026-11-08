import { useState } from 'react';
import { Panel, Field } from './ui';
import { TabGroups, type GroupConnection } from './tab-groups';
type Connection=GroupConnection&{state:string};
export function TabGroupsPanel({groups,owner,connections,label,changed,select,close}:{groups:TabGroups;owner:string;connections:Connection[];label(c:Connection):string;changed():void;select(id:string):void;close():void}){
  const [name,setName]=useState(''),[message,setMessage]=useState('');
  const [selected,setSelected]=useState(''),[rename,setRename]=useState('');
  const list=groups.list(),group=list.find(g=>g.id===selected);
  function action(run:()=>void){try{run();changed();setMessage('分组已更新，连接和通信保持原状态。');}catch(e){setMessage(e instanceof Error?e.message:'分组操作未完成。');}}
  return <Panel title="标签分组" close={close} closeLabel="关闭分组窗口">
    <p>把本窗口的会话标签放在一起。分组只整理显示，不建连、不发送、不关闭；关闭或重载应用后清空，尚不是持久工作区。</p>
    <form onSubmit={e=>{e.preventDefault();action(()=>{const id=groups.create(name);setSelected(id);setRename(name.trim());setName('');});}}><Field label="新分组名称"><input aria-label="新分组名称" maxLength={64} value={name} onChange={e=>setName(e.target.value)} autoComplete="off"/></Field><button disabled={!name.trim()}>新建分组</button></form>
    <Field label="管理分组"><select aria-label="管理标签分组" value={selected} onChange={e=>{setSelected(e.target.value);setRename(list.find(g=>g.id===e.target.value)?.name??'');}}><option value="">请选择分组</option>{list.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
    {group&&<><Field label="分组名称"><input aria-label="修改分组名称" maxLength={64} value={rename} onChange={e=>setRename(e.target.value)}/></Field><div className="config-actions"><button disabled={!rename.trim()} onClick={()=>action(()=>groups.rename(group.id,rename))}>保存分组名称</button><button disabled={list[0]?.id===group.id} onClick={()=>action(()=>groups.move(group.id,-1))}>分组前移</button><button disabled={list.at(-1)?.id===group.id} onClick={()=>action(()=>groups.move(group.id,1))}>分组后移</button><button onClick={()=>action(()=>{groups.remove(group.id);setSelected('');setRename('');})}>解散分组，保留连接</button></div></>}
    <h3>会话归属</h3><small>隐藏标签也可从这里显示；同地址的独立实例分别列出。重连仍属于原逻辑标签，已开始的拖动须重新核对当前代次。</small>
    {connections.length===0?<p>尚无会话，可先连接服务器或串口。</p>:connections.map((c,i)=><div className="form-grid" key={c.connection_id}><button title={`${c.connection_id} / ${c.generation}`} onClick={()=>{select(c.connection_id);close();}}>{i+1}. {label(c)}</button><select aria-label={`标签归属 ${c.connection_id}`} value={groups.groupOf(c.connection_id)} onChange={e=>action(()=>groups.assign(owner,c,e.target.value))}><option value="">未分组</option>{list.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></div>)}
    {message&&<p role="status" aria-label="分组操作状态">{message}</p>}
  </Panel>;
}
