export type ComposeTarget = { connection_id: string; generation: number; protocol: string };
export type Ending = 'none' | 'cr' | 'lf' | 'crlf';
export type ComposeProposal = { target: ComposeTarget; text: string; payload: string; ending: Ending };
const key = (target: ComposeTarget) => `${target.connection_id}/${target.generation}/${target.protocol}`;
const same = (a: ComposeTarget | undefined, b: ComposeTarget) => !!a && key(a) === key(b);
const endings: Record<Ending, string> = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };

/** Window-only, bounded drafts. A proposal is one-shot and cannot follow a tab or generation. */
export class ComposeDrafts {
  private drafts = new Map<string, string>();
  private pending?: ComposeProposal;
  private changes=0;
  get revision(){return this.changes;}
  get count() { return this.drafts.size; }
  get(target: ComposeTarget) { return this.drafts.get(key(target)) ?? ''; }
  invalidate() { this.pending = undefined; }
  clear() { this.invalidate(); this.drafts.clear();this.changes++; }
  edit(target: ComposeTarget, text: string) {
    this.invalidate();
    if (text.length > 65536) throw new Error('草稿最多 65536 个 UTF-16 单元；此次修改未保存。');
    const id = key(target);
    if (!text) { this.drafts.delete(id);this.changes++; return; }
    if (!this.drafts.has(id) && this.drafts.size >= 64) throw new Error('本窗口草稿已达 64 份；请先清空草稿。');
    this.drafts.set(id, text);this.changes++;
  }
  prepare(target: ComposeTarget, ending: Ending): ComposeProposal {
    this.invalidate();
    if (!['SSH2', 'SERIAL', 'FIXTURE'].includes(target.protocol)) throw new Error('此协议尚不可撰写发送。');
    const text = this.get(target);
    if (!text) throw new Error('请先撰写内容。');
    if (/[\uD800-\uDFFF]/u.test(text)) throw new Error('草稿包含不完整 Unicode 字符；未发送。');
    if (!Object.hasOwn(endings, ending)) throw new Error('换行选项无效；未发送。');
    const payload = text + endings[ending];
    if (new TextEncoder().encode(payload).length > (target.protocol === 'SSH2' ? 196608 : 65536)) throw new Error('内容连同追加换行超过单批字节上限；未发送。');
    return this.pending = Object.freeze({ target: Object.freeze({ ...target }), text, payload, ending });
  }
  consume(target: ComposeTarget | undefined, proposal: ComposeProposal): string {
    const valid = this.pending === proposal && same(target, proposal.target) && this.get(proposal.target) === proposal.text;
    this.invalidate();
    if (!valid) throw new Error('草稿、目标或代次已变化；请重新预览，未发送。');
    return proposal.payload;
  }
}
