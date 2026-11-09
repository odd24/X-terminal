/** FIFO renderer input: a failed/unknown dispatch drops unsent actions and never retries. */
export class InputQueue {
  private queue: {run():Promise<void>;keyboard?:{key:string;kind:string;text:string;bytes:number}}[] = [];
  private active = false;
  private closed = false;
  private failed = false;
  private onError: (error: unknown) => void;
  constructor(onError: (error: unknown) => void) { this.onError = onError; }
  enqueue(action: () => Promise<void>): boolean {
    if (this.closed || this.failed || this.queue.length + Number(this.active) >= 16) return false;
    this.queue.push({run:action});
    void this.pump();
    return true;
  }
  /** Only an unsent tail can merge; explicit actions and control changes are barriers. */
  enqueueKeyboard(text:string,key:string,dispatch:(text:string)=>Promise<void>):boolean {
    if(this.closed||this.failed)return false;
    const kind=/^[^\x00-\x1f\x7f-\x9f]+$/u.test(text)?'print':text==='\x7f'||text==='\b'||text==='\x1b[3~'?text:'';
    const bytes=new TextEncoder().encode(text).length,tail=this.queue.at(-1)?.keyboard;
    if(kind&&tail&&tail.key===key&&tail.kind===kind&&tail.bytes+bytes<=4096){tail.text+=text;tail.bytes+=bytes;return true;}
    if(!kind||bytes>4096)return this.enqueue(()=>dispatch(text));
    if(this.queue.length+Number(this.active)>=16)return false;
    const keyboard={key,kind,text,bytes};this.queue.push({keyboard,run:()=>dispatch(keyboard.text)});void this.pump();return true;
  }
  close() { this.closed = true; this.queue = []; }
  private async pump() {
    if (this.active || this.closed || this.failed) return;
    this.active = true;
    try {
      while (!this.closed && this.queue.length) await this.queue.shift()!.run();
    } catch (error) {
      this.failed = true;
      this.queue = [];
      if (!this.closed) this.onError(error);
    } finally { this.active = false; }
  }
}
