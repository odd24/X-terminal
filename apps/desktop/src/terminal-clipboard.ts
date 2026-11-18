export type PasteTarget = { connection_id: string; generation: number; protocol: string };
export type PasteProposal = { target: PasteTarget; epoch: number; text: string; payload: string; bracketed: boolean; confirm: boolean };
export function preparePaste(text: string, target: PasteTarget, epoch: number, bracketed: boolean): PasteProposal {
  if (!text) throw new Error('剪贴板没有文字');
  if (/[\uD800-\uDFFF]/u.test(text)) throw new Error('粘贴含不完整 Unicode 字符；未发送');
  if (bracketed && /\x1b\[20[01]~/.test(text)) throw new Error('粘贴含终端粘贴边界控制序列；未发送');
  const payload = bracketed ? `\x1b[200~${text}\x1b[201~` : text;
  const limit = target.protocol === 'SSH1' ? 16384 : target.protocol === 'SSH2' ? 196608 : 65536;
  if (new TextEncoder().encode(payload).length > limit) throw new Error('粘贴超过单次输入上限；未发送');
  const confirm = text.length > 1024 || /[\r\n\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text);
  return { target: { ...target }, epoch, text, payload, bracketed, confirm };
}
export function samePasteTarget(a: PasteTarget | undefined, b: PasteTarget) {
  return !!a && a.connection_id === b.connection_id && a.generation === b.generation && a.protocol === b.protocol;
}
/** No clipboard contents or approval is persisted. Late reads cannot retarget a paste. */
export class TerminalClipboard {
  private epoch = 0;
  private pending?: PasteProposal;
  private deps: {
    target: () => PasteTarget | undefined; bracketed: () => boolean;
    send: (text: string) => void; proposal: (value: PasteProposal | undefined) => void;
    message: (value: string) => void;
    read: () => Promise<string>; write: (text: string) => Promise<void>;
    selection: () => string;
  };
  constructor(deps: TerminalClipboard['deps']) { this.deps = deps; }
  invalidate() {
    this.epoch++;
    if (this.pending) this.deps.message('待确认粘贴已取消；未发送');
    this.pending = undefined; this.deps.proposal(undefined);
  }
  async copy() {
    const text = this.deps.selection();
    if (!text) { this.deps.message('终端没有选区'); return; }
    try { await this.deps.write(text); this.deps.message('终端选区已复制'); }
    catch { this.deps.message('系统剪贴板写入失败；选区仍保留，可用系统复制菜单'); }
  }
  async paste(text?: string) {
    this.invalidate();
    const epoch = this.epoch, target = this.deps.target();
    if (!target) { this.deps.message('当前连接不可写；未读取或发送粘贴'); return; }
    try {
      const content = text ?? await this.deps.read();
      if (epoch !== this.epoch) return;
      if (!samePasteTarget(this.deps.target(), target)) { this.deps.message('粘贴目标已变化；未发送'); return; }
      const proposal = preparePaste(content, target, epoch, this.deps.bracketed());
      this.pending = proposal;
      if (proposal.confirm) { this.deps.proposal(proposal); this.deps.message('粘贴等待确认；尚未发送'); }
      else this.confirm(proposal);
    } catch (error) { if (epoch === this.epoch) this.deps.message(error instanceof Error ? error.message : typeof error === 'string' ? error : '剪贴板读取失败；可用终端系统粘贴菜单'); }
  }
  confirm(proposal: PasteProposal) {
    if (this.pending !== proposal) return;
    const valid = proposal.epoch === this.epoch && samePasteTarget(this.deps.target(), proposal.target) && this.deps.bracketed() === proposal.bracketed;
    this.invalidate();
    if (!valid) { this.deps.message('连接、代次或粘贴模式已变化；未发送，请重新粘贴'); return; }
    this.deps.send(proposal.payload);
    this.deps.message('粘贴已提交输入队列；结果见输入状态，不代表设备已执行');
  }
}
