/** Window-only line pacing. Every dispatch still uses the original input FIFO. */
export type ComposePaceState = 'queued' | 'sending' | 'waiting' | 'completed' | 'cancelled' | 'unknown';
export function composeParts(payload: string, interval: number): readonly string[] {
  if (!Number.isSafeInteger(interval) || interval < 50 || interval > 1000) throw new Error('逐行间隔须为50–1000毫秒整数。');
  if (!payload || /[\uD800-\uDFFF]/u.test(payload) || new TextEncoder().encode(payload).length > 196608) throw new Error('逐行内容无效或超过字节预算。');
  const parts = payload.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  if (parts.length > 256 || (parts.length - 1) * interval > 60000) throw new Error('逐行最多256片段，计划间隔合计最多60秒；请减少正文或间隔。');
  return Object.freeze(parts);
}

export class ComposePacing {
  readonly parts: readonly string[];
  readonly interval: number;
  state: ComposePaceState = 'queued';
  accepted = 0;
  private stopped = false;
  private started = false;
  private wake?: () => void;
  private change: () => void;
  constructor(payload: string, interval: number, change: () => void = () => {}) {
    this.change = change;
    this.parts = composeParts(payload, interval); this.interval = interval;
  }
  get busy() { return ['queued', 'sending', 'waiting'].includes(this.state); }
  cancel() { if (!this.busy) return; this.stopped = true; this.wake?.(); if(!this.started)this.publish('cancelled'); }
  private publish(state: ComposePaceState) { this.state = state; this.change(); }
  async run(dispatch: (part: string) => Promise<boolean>, alive: () => boolean) {
    if (this.started) throw new Error('逐行任务不可重复派发。');
    this.started = true;
    try {
      for (const part of this.parts) {
        if (this.stopped || !alive()) { this.publish('cancelled'); return; }
        this.publish('sending');
        // A call already started can complete after cancellation. Count its receipt only.
        if (!await dispatch(part)) { this.publish('cancelled'); return; }
        this.accepted++;
        if (this.accepted < this.parts.length) {
          if (this.stopped || !alive()) { this.publish('cancelled'); return; }
          this.publish('waiting');
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { this.wake = undefined; resolve(); }, this.interval);
            this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
          });
        }
      }
      this.publish('completed');
    } catch (error) { this.publish('unknown'); throw error; }
  }
}
