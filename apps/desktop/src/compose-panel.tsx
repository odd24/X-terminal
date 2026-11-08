import { useState } from 'react';
import { ComposeDrafts, type ComposeTarget, type ComposeProposal, type Ending } from './compose-drafts';
import { visibleControls } from './log-search';
import { Panel, Field } from './ui';

export function ComposePanel({ drafts, target, ready, send, close, initialEnding='none',origin }: {
  drafts: ComposeDrafts; target?: ComposeTarget; ready: boolean;initialEnding?:Ending;origin?:string;
  send(target: ComposeTarget, payload: string): boolean; close(): void;
}) {
  const [, update] = useState(0);
  const [ending, setEnding] = useState<Ending>(initialEnding);
  const [proposal, setProposal] = useState<ComposeProposal>();
  const [message, setMessage] = useState(origin?`已从常用命令“${origin}”准备，尚未发送；请核对目标、内容与末尾换行。`:'草稿仅保留在本窗口；切换/重连不继承预览，重载清空。');
  const refresh = () => update(value => value + 1);
  const invalidate = () => { drafts.invalidate(); setProposal(undefined); };
  return <Panel title="基础撰写" label="基础撰写面板" close={() => { invalidate(); close(); }} closeLabel="关闭撰写">
    <small aria-label="撰写目标">{target ? `${target.protocol} · ${target.connection_id} / 代次 ${target.generation}` : '尚无活动连接'}</small>
    <p role="status" aria-label="撰写状态">{message}</p>
    <p>按活动连接与代次保存独立草稿；单批发送到当前交互终端。不会启动独立 shell，不自动补回车，不解释变量。编码无法表示的内容由服务整批拒绝。</p>
    <Field label="正文"><textarea aria-label="撰写正文" disabled={!target} value={target ? drafts.get(target) : ''} maxLength={65536} onChange={event => { if (!target) return; invalidate(); try { drafts.edit(target, event.target.value); refresh(); } catch (error) { setMessage((error as Error).message); } }} /></Field>
    <Field label="末尾追加"><select aria-label="撰写末尾换行" value={ending} onChange={event => { invalidate(); setEnding(event.target.value as Ending); }}><option value="none">不追加</option><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select></Field>
    <small>本窗口 {drafts.count} / 64 份草稿，每份最多65536个UTF-16单元；正文可能包含多条命令。关闭面板保留草稿，重载不恢复正文或同意。</small>
    <div className="config-actions"><button disabled={!target || !ready || !drafts.get(target)} onClick={() => { if (!target) return; try { setProposal(drafts.prepare(target, ending)); setMessage('请核对固定目标与转义预览；尚未发送。'); } catch (error) { invalidate(); setMessage((error as Error).message); } }}>预览撰写发送</button><button onClick={() => { invalidate(); drafts.clear(); refresh(); setMessage('本窗口全部草稿已清空；未发送。'); }}>清空全部草稿</button></div>
    {proposal && <fieldset><legend>核对本次发送</legend><small>{proposal.target.protocol} · {proposal.target.connection_id} / 代次 {proposal.target.generation} · UTF-8预算 {new TextEncoder().encode(proposal.payload).length} 字节（实际编码由服务核对） · CR {proposal.payload.split('\r').length - 1} / LF {proposal.payload.split('\n').length - 1}</small><pre aria-label="撰写发送预览">{visibleControls(JSON.stringify(proposal.payload.slice(0, 8192)))}{proposal.payload.length > 8192 && ' …仅预览截断，确认发送整批'}</pre><div className="config-actions"><button autoFocus onClick={() => { invalidate(); setMessage('已取消预览；未发送。'); }}>取消撰写发送</button><button disabled={!ready} onClick={() => {
      try {
        const payload = drafts.consume(target, proposal); setProposal(undefined);
        if (!target || !send(proposal.target, payload)) throw new Error('当前终端未就绪或队列拒绝；未自动重试，请核对输入状态。');
        drafts.edit(proposal.target, ''); refresh(); setMessage('已交给统一输入路径；结果见终端输入状态，不代表远端已执行，未自动重试。');
      } catch (error) { invalidate(); setMessage((error as Error).message); }
    }}>确认发送撰写</button></div></fieldset>}
  </Panel>;
}
