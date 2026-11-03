export interface TerminalSink {
  write(bytes: Uint8Array, done: () => void): void;
}

/** A slow renderer detaches at a gap; it never blocks the transport reader. */
export class TerminalWriter {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private active = false;
  private closed = false;
  private waiters: (() => void)[] = [];
  private sink: TerminalSink;
  readonly maxBytes: number;
  readonly maxEvents: number;
  readonly maxChunk: number;
  lostBytes = 0;

  constructor(
    sink: TerminalSink,
    maxBytes = 256 * 1024,
    maxEvents = 128,
    maxChunk = 64 * 1024,
  ) {
    if (![maxBytes, maxEvents, maxChunk].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('Invalid terminal queue limits');
    }
    this.sink = sink;
    this.maxBytes = maxBytes;
    this.maxEvents = maxEvents;
    this.maxChunk = maxChunk;
  }

  enqueue(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    if (this.lostBytes || bytes.length > this.maxChunk ||
        this.queuedBytes + bytes.length > this.maxBytes || this.queue.length >= this.maxEvents) {
      this.lostBytes += bytes.length;
      return false;
    }
    if (!bytes.length) return true;
    this.queue.push(bytes.slice());
    this.queuedBytes += bytes.length;
    this.pump();
    return true;
  }

  get pendingBytes() { return this.queuedBytes; }

  drain(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.resolveWaiters();
  }

  private resolveWaiters() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private pump() {
    if (this.active || this.closed) return;
    const bytes = this.queue.shift();
    if (!bytes) { this.resolveWaiters(); return; }
    // Count the in-flight write against the byte cap until xterm acknowledges it.
    this.active = true;
    this.sink.write(bytes, () => {
      this.active = false;
      if (this.closed) return;
      this.queuedBytes -= bytes.length;
      this.pump();
    });
  }
}
