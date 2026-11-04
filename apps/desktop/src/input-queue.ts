/** FIFO renderer input: a failed/unknown dispatch drops unsent actions and never retries. */
export class InputQueue {
  private queue: (() => Promise<void>)[] = [];
  private active = false;
  private closed = false;
  private failed = false;
  private onError: (error: unknown) => void;
  constructor(onError: (error: unknown) => void) { this.onError = onError; }
  enqueue(action: () => Promise<void>): boolean {
    if (this.closed || this.failed || this.queue.length + Number(this.active) >= 16) return false;
    this.queue.push(action);
    void this.pump();
    return true;
  }
  close() { this.closed = true; this.queue = []; }
  private async pump() {
    if (this.active || this.closed || this.failed) return;
    this.active = true;
    try {
      while (!this.closed && this.queue.length) await this.queue.shift()!();
    } catch (error) {
      this.failed = true;
      this.queue = [];
      if (!this.closed) this.onError(error);
    } finally { this.active = false; }
  }
}
