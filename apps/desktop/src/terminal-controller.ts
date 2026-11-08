import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { TerminalClipboard, type PasteProposal } from './terminal-clipboard';
import { TerminalWriter } from './terminal-writer';
import { OutputDecoder } from './output-decoder';
import { terminalAppearance } from './appearance';
import { InputQueue } from './input-queue';
import { requestId } from './request-id';
import { ssh, dimensions, type Receipt, type SshReply } from './ssh-api';
import { serial, serialResult, type SerialStatus } from './serial-api';
import type { DesktopPreferences } from './config-api';
import type { ComposeTarget } from './compose-drafts';
export type PaneConnection=ComposeTarget&{state:string};
type Ref=Pick<PaneConnection,'connection_id'|'generation'>;
type Page={connection:Ref;events:{seq:number;bytes:number[];gap_bytes?:number}[];next_cursor:number;available_from:number;truncated:boolean;disconnected:boolean};
export type PaneSelection={owner:string;connection?:PaneConnection;active:boolean;epoch:number;fixture:boolean;suspended?:boolean};
export type TerminalView={status:string;inputFailure:string;failure:string;lastInput:string;decodeWarning:string;viewport:{cols:number;rows:number};renderedTarget?:ComposeTarget};
export const initialTerminalView=():TerminalView=>({status:'正在连接会话服务',inputFailure:'',failure:'',lastInput:'尚无输入',decodeWarning:'',viewport:{cols:80,rows:24}});
type Deps={selection():PaneSelection;preferences():DesktopPreferences;state(view:TerminalView):void;invalidateDrafts():void;input():void;search():void;proposal(p?:PasteProposal):void;message(text:string):void;reset():void};
export function createTerminalController(element:HTMLDivElement,deps:Deps){
    let view=initialTerminalView(),owner='';
    const update=(patch:Partial<TerminalView>)=>{view={...view,...patch};deps.state(view);};
    const setViewport=(viewport:TerminalView['viewport'])=>update({viewport});
    const setDecodeWarning=(decodeWarning:string)=>update({decodeWarning});
    const setStatus=(status:string)=>update({status});
    const setLastInput=(lastInput:string)=>update({lastInput});
    const setFailure=(failure:string)=>update({failure});
    const setInputFailure=(value:string|((s:string)=>string))=>update({inputFailure:typeof value==='function'?value(view.inputFailure):value});
    const setSnapshot=(_value:string)=>deps.reset();
    const setServiceScreen=(_value:undefined)=>deps.reset();
    const setPasteProposal=deps.proposal,setClipboardMessage=deps.message;
    function bound(target?:Ref){const wanted=deps.selection();return !disposed&&owner===wanted.owner&&!!target&&!!wanted.connection&&current.connection?.connection_id===target.connection_id&&current.connection.generation===target.generation&&wanted.connection.connection_id===target.connection_id&&wanted.connection.generation===target.generation&&wanted.connection.protocol===current.protocol;}
    function active(){return deps.selection().active;}
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, ...terminalAppearance(), fontSize: 15, scrollback: 512 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    setViewport({ cols: term.cols, rows: term.rows });
    const current = { term, fit, writer: new TerminalWriter(term), connection: undefined as Ref | undefined, fixture: false, inputs: 0, protocol: '', writable: false };
    let disposed = false;
    let cursor = 1;
    let gap = false;
    let decoder = new OutputDecoder('utf8');
    // xterm 6 reset() clears buffers but leaves the parser state intact.
    // CAN/SUB cancel a partial string/CSI; RIS also resets the parser via public write.
    const resetParser = () => new Promise<void>(resolve => term.write(new Uint8Array([0x18, 0x1a, 0x1b, 0x63]), resolve));
    function display(decoded: { bytes: Uint8Array; replacement: boolean }) {
      if (decoded.replacement) setDecodeWarning('解码文本含 U+FFFD（原始字符或无效字节替换）；请核对原始字节。');
      if (!current.writer.enqueue(decoded.bytes)) { gap = true; setStatus('渲染队列输出缺口；请重载后读取保留输出'); }
    }
    async function outputGap(message: string) {
      gap = true;
      await current.writer.drain();
      if (disposed) return;
      // Drop partial character and escape state together, so bytes across a gap cannot join.
      await resetParser();
      if (disposed) return;
      term.reset();
      decoder = new OutputDecoder(decoder.encoding);
      setSnapshot('');
      setStatus(message + '；终端已清屏并重置解析状态，后续内容可能从序列中间开始');
    }
    let queueVersion=0;
    const newQueue = () => {const version=++queueVersion;return new InputQueue(error => { if (!disposed&&version===queueVersion) setInputFailure(error instanceof Error && error.message !== 'unknown' ? `${error.message} 已停止本页面后续输入，未重试。` : '输入结果可能未知；已停止本页面后续输入，未重试。请核对远端状态。'); });};
    let queue = newQueue();
    let resizeTimer = 0;
    let lastSize = '';
    function submit(action: { bytes: number[] } | { cols: number; rows: number } | { text: string }) {
      const target = current.connection;
      const protocol = current.protocol;
      const writing='text' in action||'bytes' in action;
      if (!target || !['SSH2','SERIAL'].includes(protocol) || !current.writable || !bound(target) || deps.selection().connection?.state!=='CONNECTED' || writing&&!active()) return false;
      const epoch=deps.selection().epoch;
      const id = requestId();
      const accepted = queue.enqueue(async () => {
        // A selection change drops unsent input rather than retargeting it.
        if (disposed || !bound(target) || deps.selection().connection?.state!=='CONNECTED' || writing&&(!active()||deps.selection().epoch!==epoch)) return;
        if (protocol === 'SERIAL') {
          if (!('text' in action)) return;
          const initial = await serial({ op: 'send', connection: target, request_id: id, content: action.text, format: 'text', ending: 'none', pace: { chunk_bytes: 1024, interval_ms: 0 } });
          const receipt = await serialResult(target, initial, () => bound(target));
          if (receipt.state !== 'DRIVER_ACCEPTED') throw new Error('unknown');
          if (!disposed && bound(target)) setLastInput('串口驱动已接受；不代表设备已执行');
          return;
        }
        const reply = await ssh('text' in action
          ? { op: 'write_text', connection: target, request_id: id, text: action.text }
          : 'bytes' in action
          ? { op: 'write', connection: target, request_id: id, bytes: action.bytes }
          : { op: 'resize', connection: target, request_id: id, ...action });
        if (reply.result !== 'input') throw new Error('receipt');
        let receipt: Receipt = reply;
        const deadline = Date.now() + 17000;
        while (receipt.state === 'PENDING' || receipt.state === 'DISPATCHING') {
          await new Promise(resolve => setTimeout(resolve, 50));
          if (disposed || !bound(target)) return;
          if (Date.now() > deadline) throw new Error('unknown');
          const result = await ssh({ op: 'input_status', connection: target, request_id: id });
          if (result.result !== 'input') throw new Error('receipt');
          receipt = result;
        }
        if (receipt.state !== 'PIPELINE_QUEUED') throw new Error('unknown');
        if (!disposed && bound(target)) setLastInput('已进入 SSH 发送管线；不代表远端已执行');
      });
      // Error text can resize the terminal, enqueueing another resize against a
      // stopped queue. Keep the original dispatch failure visible.
      if (!accepted) setInputFailure(previous => previous || '输入队列已满或已停止；此次输入未发送。');
      return accepted;
    }
    const clip = new TerminalClipboard({
      target: () => current.connection && active() && bound(current.connection) && (current.writable || (current.fixture && current.protocol === 'FIXTURE')) ? { ...current.connection, protocol: current.protocol } : undefined,
      bracketed: () => term.modes.bracketedPasteMode,
      send: data => receiveInput(data), proposal: setPasteProposal, message: setClipboardMessage,
      selection: () => term.getSelection(), read: () => invoke<string>('terminal_clipboard_read'), write: text => navigator.clipboard.writeText(text),
    });
    const paste = (event: ClipboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.clipboardData) void clip.paste(event.clipboardData.getData('text/plain'));
      else setClipboardMessage('剪贴板没有可读取文字；未发送');
    };
    const contextMenu = (event: MouseEvent) => {
      if (!deps.preferences().right_click_paste) return;
      event.preventDefault(); event.stopImmediatePropagation(); void clip.paste();
    };
    element.addEventListener('paste', paste, true);
    element.addEventListener('contextmenu', contextMenu, true);
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      if (event.key.toLowerCase() === 'c' && ((deps.preferences().ctrl_c_copy && term.hasSelection()) || event.shiftKey)) { event.preventDefault(); void clip.copy(); return false; }
      if (event.key.toLowerCase() === 'v' && (event.shiftKey || deps.preferences().ctrl_v_paste)) { event.preventDefault(); void clip.paste(); return false; }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); deps.search(); return false; }
      return true;
    });
    function receiveInput(data: string, compose = false): boolean {
      if (!active()||!bound(current.connection)) return false;
      if (!compose) deps.input();
      deps.invalidateDrafts(); clip.invalidate();
      if (current.protocol === 'SERIAL') {
        if (!current.writable || !bound(current.connection)) { setLastInput('串口当前不可写，此次输入未发送'); return false; }
        if (new TextEncoder().encode(data).length > 65536) { setInputFailure('单次输入超过 64 KiB；此次输入未发送'); return false; }
        setLastInput('串口键盘输入已收到，内容不显示；Enter 按终端 CR 发送'); return submit({ text: data });
      }
      if (current.protocol === 'SSH2') {
        if (!current.writable || !bound(current.connection)) { setLastInput('连接当前不可写；此次输入未发送'); return false; }
        if (/[\uD800-\uDFFF]/u.test(data)) { setInputFailure('输入包含不完整 Unicode 字符；此次输入未发送'); return false; }
        if (new TextEncoder().encode(data).length > 196608) { setInputFailure('单次文本超过输入上限；此次输入未发送'); return false; }
        setLastInput('SSH 键盘输入已收到，按连接编码发送；内容不显示');
        return submit({ text: data });
      }
      if (!current.fixture || current.protocol !== 'FIXTURE' || !current.connection) return false;
      setLastInput(JSON.stringify(data));
      if (current.inputs >= 16) { setStatus('合成输入队列已满；此次输入未发送'); return false; }
      current.inputs++;
      void invoke('fixture_append', { connection: current.connection, bytes: Array.from(new TextEncoder().encode(!compose && data === '\r' ? '\r\n' : data)) })
        .catch(() => { if (!disposed) setFailure('合成输入失败；未重试'); })
        .finally(() => current.inputs--);
      return true;
    }
    const compose = (target:ComposeTarget, text:string) => {
      if (disposed || !current.connection || !bound(target) || current.connection.connection_id !== target.connection_id || current.connection.generation !== target.generation || current.protocol !== target.protocol || !current.writable) return false;
      return receiveInput(text, true);
    };
    const input = term.onData(data => receiveInput(data));
    const resize = term.onResize(({ cols, rows }) => {
      setViewport({ cols, rows });
      clearTimeout(resizeTimer);
      const resized=current.connection&&{...current.connection};
      resizeTimer = window.setTimeout(() => {
        if(!resized||!bound(resized))return;
        const size = dimensions(term.cols, term.rows);
        const key = `${size.cols}:${size.rows}`;
        if (lastSize !== key && current.protocol === 'SSH2' && current.writable) { if(submit(size))lastSize = key; }
      }, 150);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    function same(selection:PaneSelection){const now=deps.selection();return !now.suspended&&!selection.suspended&&selection.owner===now.owner&&selection.connection?.connection_id===now.connection?.connection_id&&selection.connection?.generation===now.connection?.generation&&selection.connection?.protocol===now.connection?.protocol;}
    async function poll(){
      try{
        const selection=deps.selection(),connection=selection.connection;
        current.fixture=selection.fixture;
        if(!selection.owner){current.writable=false;timer=window.setTimeout(()=>void poll(),100);return;}
        if(selection.suspended){current.writable=false;clip.invalidate();update({renderedTarget:undefined,status:'会话已变化或正在绑定，请明确选择当前会话。'});timer=window.setTimeout(()=>void poll(),100);return;}
        const changed=owner!==selection.owner||connection?.connection_id!==current.connection?.connection_id||connection?.generation!==current.connection?.generation||connection?.protocol!==current.protocol;
        if(changed){
          current.writable=false;queue.close();queue=newQueue();lastSize='';clearTimeout(resizeTimer);
          deps.invalidateDrafts();clip.invalidate();update({renderedTarget:undefined});current.writer.close();
          let encoding='utf8';
          if(connection&&['SSH2','SERIAL'].includes(connection.protocol)){
            const metadata=await invoke<SshReply|SerialStatus>(connection.protocol==='SSH2'?'ssh_request':'serial_request',{request:{op:'status',connection:{connection_id:connection.connection_id,generation:connection.generation}}});
            if(disposed)return;if(!same(selection)){timer=window.setTimeout(()=>void poll(),0);return;}
            if(metadata.result!=='status'||metadata.connection.connection_id!==connection.connection_id||metadata.connection.generation!==connection.generation||metadata.connection.protocol!==connection.protocol)throw new Error('Invalid encoding status');
            encoding=metadata.encoding;
          }
          await resetParser();if(disposed)return;
          if(!same(selection)){timer=window.setTimeout(()=>void poll(),0);return;}
          term.reset();current.writer=new TerminalWriter(term);decoder=new OutputDecoder(encoding);
          current.connection=connection&&{connection_id:connection.connection_id,generation:connection.generation};current.protocol=connection?.protocol??'';owner=selection.owner;
          cursor=1;gap=false;deps.reset();update({decodeWarning:'',lastInput:'尚无输入',inputFailure:'',failure:'',renderedTarget:undefined});
        }
        if(!same(selection)){timer=window.setTimeout(()=>void poll(),0);return;}
        current.writable=connection?.state==='CONNECTED';
        if(!current.writable)clip.invalidate();
        if(current.protocol==='SSH2'&&current.writable&&!lastSize){const size=dimensions(term.cols,term.rows);if(submit(size))lastSize=`${size.cols}:${size.rows}`;}
        if(current.connection){
          const page=await invoke<Page>('service_read',{connection:current.connection,cursor});
          if(disposed)return;if(!same(selection)){timer=window.setTimeout(()=>void poll(),0);return;}
          if(page.connection.connection_id!==current.connection.connection_id||page.connection.generation!==current.connection.generation)throw new Error('Invalid output identity');
          if(page.truncated)await outputGap(`输出缺口：起始游标 ${page.available_from}，历史输出已覆盖`);
          if(disposed)return;if(!same(selection)){timer=window.setTimeout(()=>void poll(),0);return;}
          for(const event of page.events){if(event.gap_bytes){await outputGap(`设备接收输出缺口：丢失 ${event.gap_bytes} 字节`);if(disposed)return;if(!same(selection))break;continue;}display(decoder.decode(new Uint8Array(event.bytes)));}
          if(page.disconnected&&page.events.length===0)display(decoder.finish());
          cursor=page.next_cursor;await current.writer.drain();if(disposed)return;
          if(same(selection)){update({renderedTarget:{...current.connection,protocol:current.protocol}});if(!gap)setStatus(page.disconnected?'会话已断开':'服务输出已同步');}
        }else setStatus('服务就绪 · 尚无活动连接');
        if(!disposed)timer=window.setTimeout(()=>void poll(),100);
      }catch(error){
        if(!disposed&&['StaleGeneration','NotFound'].includes(String(error))){current.writable=false;timer=window.setTimeout(()=>void poll(),100);return;}
        if(!disposed){current.fixture=false;current.writable=false;setFailure('会话服务不可用；未重连或重放输入。请退出后重新启动。');}
      }
    }
    let timer=0;void poll();
    return {runtime:current,clipboard:clip,compose,
      invalidate(){clip.invalidate();update({renderedTarget:undefined});},
      appearance(){const appearance=terminalAppearance();term.options.theme=appearance.theme;term.options.fontFamily=appearance.fontFamily;term.options.fontSize=deps.preferences().font_size;fit.fit();},
      dispose(){disposed=true;clip.invalidate();element.removeEventListener('paste',paste,true);element.removeEventListener('contextmenu',contextMenu,true);clearTimeout(timer);queue.close();clearTimeout(resizeTimer);resize.dispose();observer.disconnect();input.dispose();current.writer.close();term.dispose();}
    };
}
export type TerminalController=ReturnType<typeof createTerminalController>;
