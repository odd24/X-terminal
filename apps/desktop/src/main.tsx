import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalClipboard, type PasteProposal } from './terminal-clipboard';
import { visibleControls } from './log-search';
import { TerminalSearch } from './terminal-search-panel';
import { TerminalWriter } from './terminal-writer';
import { OutputDecoder } from './output-decoder';
import { ConfigPanel } from './config-panel';
import { SshPanel } from './ssh-panel';
import { ExecPanel } from './exec-panel';
import { SerialPanel } from './serial-panel';
import { LoggingPanel } from './logging-panel';
import { serial, serialResult } from './serial-api';
import { InputQueue } from './input-queue';
import { requestId } from './request-id';
import { ssh, dimensions, type Receipt } from './ssh-api';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Connection = { connection_id: string; generation: number; protocol: string; state: string };
type Ref = Pick<Connection, 'connection_id' | 'generation'>;
type ServiceScreen = { connection: Ref; encoding: string; parser: string; resize_reflow: boolean; rows: number; cols: number; contents: string; contents_truncated: boolean; cursor_row: number; cursor_col: number; alternate: boolean; source_cursor: number; completed: boolean; gap_bytes: number; decode_error_events: number };
type Status = { service_id: string; pid: number; fixture: boolean; exit_policy: string };
type Page = { connection: Ref; events: { seq: number; bytes: number[]; gap_bytes?: number }[]; next_cursor: number; available_from: number; truncated: boolean; disconnected: boolean };
const demo = '共享终端 · 服务合成 UTF-8/ANSI 回放\r\n\x1b[32m中文宽字 ✓\x1b[0m\r\n输入通过统一服务追加到合成输出，不发送到设备。\r\n\x1b[?1049h\x1b[2J\x1b[H替代屏幕\x1b[?1049l';

function App() {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [serialOpen, setSerialOpen] = useState(false);
  const [loggingOpen,setLoggingOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const clipboard = useRef<TerminalClipboard | undefined>(undefined);
  const [pasteProposal, setPasteProposal] = useState<PasteProposal>();
  const [clipboardMessage, setClipboardMessage] = useState('');
  function selectConnection(id: string) {
    clipboard.current?.invalidate(); selectedRef.current = id; setSelected(id);
  }
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ term: Terminal; fit: FitAddon; writer: TerminalWriter; connection?: Ref; fixture: boolean; inputs: number; protocol: string; writable: boolean } | null>(null);
  const [service, setService] = useState<Status>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const [status, setStatus] = useState('正在连接会话服务');
  const [failure, setFailure] = useState('');
  const [lastInput, setLastInput] = useState('尚无输入');
  const [inputFailure, setInputFailure] = useState('');
  const [fontSize, setFontSize] = useState(15);
  const [snapshot, setSnapshot] = useState('');
  const [decodeWarning, setDecodeWarning] = useState('');
  const [serviceScreen, setServiceScreen] = useState<ServiceScreen>();
  const [busy, setBusy] = useState(false);
  const stopped = useRef(false);

  useEffect(() => {
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, fontFamily: 'Consolas, "Microsoft YaHei", monospace', fontSize: 15, scrollback: 512, theme: { background: '#101720', foreground: '#e7edf5' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    const current = { term, fit, writer: new TerminalWriter(term), connection: undefined as Ref | undefined, fixture: false, inputs: 0, protocol: '', writable: false };
    runtime.current = current;
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
    const newQueue = () => new InputQueue(error => { if (!disposed) setInputFailure(error instanceof Error && error.message !== 'unknown' ? `${error.message} 已停止本页面后续输入，未重试。` : '输入结果可能未知；已停止本页面后续输入，未重试。请核对远端状态。'); });
    let queue = newQueue();
    let resizeTimer = 0;
    let lastSize = '';
    function submit(action: { bytes: number[] } | { cols: number; rows: number } | { text: string }) {
      const target = current.connection;
      const protocol = current.protocol;
      if (!target || !['SSH2','SERIAL'].includes(protocol) || !current.writable || selectedRef.current !== target.connection_id) return;
      const id = requestId();
      const accepted = queue.enqueue(async () => {
        // A selection change drops unsent input rather than retargeting it.
        if (disposed || current.connection?.connection_id !== target.connection_id || current.connection.generation !== target.generation || selectedRef.current !== target.connection_id) return;
        if (protocol === 'SERIAL') {
          if (!('text' in action)) return;
          const initial = await serial({ op: 'send', connection: target, request_id: id, content: action.text, format: 'text', ending: 'none', pace: { chunk_bytes: 1024, interval_ms: 0 } });
          const receipt = await serialResult(target, initial, () => !disposed && current.connection?.connection_id === target.connection_id && current.connection.generation === target.generation);
          if (receipt.state !== 'DRIVER_ACCEPTED') throw new Error('unknown');
          if (!disposed) setLastInput('串口驱动已接受；不代表设备已执行');
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
          if (disposed || current.connection?.connection_id !== target.connection_id || current.connection.generation !== target.generation) return;
          if (Date.now() > deadline) throw new Error('unknown');
          const result = await ssh({ op: 'input_status', connection: target, request_id: id });
          if (result.result !== 'input') throw new Error('receipt');
          receipt = result;
        }
        if (receipt.state !== 'PIPELINE_QUEUED') throw new Error('unknown');
        if (!disposed) setLastInput('已进入 SSH 发送管线；不代表远端已执行');
      });
      if (!accepted) setInputFailure('输入队列已满或已停止；此次输入未发送。');
    }
    const clip = new TerminalClipboard({
      target: () => current.connection && selectedRef.current === current.connection.connection_id && (current.writable || (current.fixture && current.protocol === 'FIXTURE')) ? { ...current.connection, protocol: current.protocol } : undefined,
      bracketed: () => term.modes.bracketedPasteMode,
      send: data => receiveInput(data), proposal: setPasteProposal, message: setClipboardMessage,
      selection: () => term.getSelection(), read: () => invoke<string>('terminal_clipboard_read'), write: text => navigator.clipboard.writeText(text),
    });
    clipboard.current = clip;
    const paste = (event: ClipboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.clipboardData) void clip.paste(event.clipboardData.getData('text/plain'));
      else setClipboardMessage('剪贴板没有可读取文字；未发送');
    };
    const element = host.current!;
    element.addEventListener('paste', paste, true);
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      if (event.key.toLowerCase() === 'c' && (term.hasSelection() || event.shiftKey)) { event.preventDefault(); void clip.copy(); return false; }
      if (event.key.toLowerCase() === 'v' && event.shiftKey) { event.preventDefault(); void clip.paste(); return false; }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); setSearchOpen(true); return false; }
      return true;
    });
    function receiveInput(data: string) {
      clip.invalidate();
      if (current.protocol === 'SERIAL') {
        if (!current.writable || selectedRef.current !== current.connection?.connection_id) { setLastInput('串口当前不可写，此次输入未发送'); return; }
        if (new TextEncoder().encode(data).length > 65536) { setInputFailure('单次输入超过 64 KiB；此次输入未发送'); return; }
        setLastInput('串口键盘输入已收到，内容不显示；Enter 按终端 CR 发送'); submit({ text: data }); return;
      }
      if (current.protocol === 'SSH2') {
        if (!current.writable || selectedRef.current !== current.connection?.connection_id) { setLastInput('连接当前不可写；此次输入未发送'); return; }
        if (/[\uD800-\uDFFF]/u.test(data)) { setInputFailure('输入包含不完整 Unicode 字符；此次输入未发送'); return; }
        if (new TextEncoder().encode(data).length > 196608) { setInputFailure('单次文本超过输入上限；此次输入未发送'); return; }
        setLastInput('SSH 键盘输入已收到，按连接编码发送；内容不显示');
        submit({ text: data });
        return;
      }
      if (!current.fixture || current.protocol !== 'FIXTURE' || !current.connection) return;
      setLastInput(JSON.stringify(data));
      if (current.inputs >= 16) { setStatus('合成输入队列已满；此次输入未发送'); return; }
      current.inputs++;
      void invoke('fixture_append', { connection: current.connection, bytes: Array.from(new TextEncoder().encode(data === '\r' ? '\r\n' : data)) })
        .catch(() => { if (!disposed) setFailure('合成输入失败；未重试'); })
        .finally(() => current.inputs--);
    }
    const input = term.onData(receiveInput);
    const resize = term.onResize(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const size = dimensions(term.cols, term.rows);
        const key = `${size.cols}:${size.rows}`;
        if (lastSize !== key && current.protocol === 'SSH2' && current.writable) { submit(size); lastSize = key; }
      }, 150);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);
    async function poll() {
      try {
        const native = await invoke<Status>('service_status');
        if (disposed) return;
        current.fixture = native.fixture;
        setService(native);
        const sessions = await invoke<Connection[]>('service_list');
        if (disposed) return;
        setConnections(sessions);
        const wanted = selectedRef.current;
        const connection = sessions.find(item => item.connection_id === wanted) ?? (!wanted ? sessions[0] : undefined);
        if (!connection && wanted && current.connection?.connection_id !== wanted) {
          current.writable = false;
          setStatus('正在刷新所选会话；输入尚未发送');
          timer = window.setTimeout(() => void poll(), 100);
          return;
        }
        if (!connection && current.connection) {
          clip.invalidate(); current.writable = false; queue.close(); queue = newQueue(); lastSize = '';
          current.writer.close();
          current.connection = undefined; current.protocol = '';
          await resetParser();
          if (disposed) return;
          if (selectedRef.current !== wanted) { timer = window.setTimeout(() => void poll(), 0); return; }
          term.reset(); current.writer = new TerminalWriter(term);
          decoder = new OutputDecoder('utf8'); setDecodeWarning('');
          setServiceScreen(undefined);
          cursor = 1; gap = false; setSnapshot(''); setLastInput('尚无输入'); setInputFailure('');
          if (selectedRef.current === wanted) { selectedRef.current = ''; setSelected(''); }
        }
        if (connection && (connection.connection_id !== current.connection?.connection_id || connection.generation !== current.connection?.generation)) {
          let encoding = 'utf8';
          if (connection.protocol === 'SERIAL') {
            const metadata = await serial({ op: 'status', connection: { connection_id: connection.connection_id, generation: connection.generation } });
            if (disposed) return;
            if (metadata.result !== 'status') throw new Error('Invalid serial status');
            encoding = metadata.encoding;
          }
          if (connection.protocol === 'SSH2') {
            const metadata = await ssh({ op: 'status', connection: { connection_id: connection.connection_id, generation: connection.generation } });
            if (disposed) return;
            if (metadata.result !== 'status' || metadata.connection.connection_id !== connection.connection_id || metadata.connection.generation !== connection.generation) throw new Error('Invalid SSH encoding status');
            encoding = metadata.encoding;
          }
          clip.invalidate(); current.writable = false; queue.close(); queue = newQueue(); lastSize = '';
          current.writer.close();
          await resetParser();
          if (disposed) return;
          if (selectedRef.current !== wanted) {
            // A newer user selection wins over a poll suspended in xterm.write.
            current.connection = undefined;
            timer = window.setTimeout(() => void poll(), 0);
            return;
          }
          term.reset();
          current.writer = new TerminalWriter(term);
          decoder = new OutputDecoder(encoding); setDecodeWarning('');
          setServiceScreen(undefined);
          current.connection = { connection_id: connection.connection_id, generation: connection.generation };
          cursor = 1; gap = false; setSnapshot(''); setLastInput('尚无输入'); setInputFailure('');
          selectedRef.current = connection.connection_id; setSelected(connection.connection_id);
        }
        current.protocol = connection?.protocol ?? '';
        if (current.writable && connection?.state !== 'CONNECTED') clip.invalidate();
        current.writable = connection?.state === 'CONNECTED';
        if (current.protocol === 'SSH2' && current.writable && !lastSize) {
          const size = dimensions(term.cols, term.rows);
          submit(size); lastSize = `${size.cols}:${size.rows}`;
        }
        if (current.connection) {
          const page = await invoke<Page>('service_read', { connection: current.connection, cursor });
          if (disposed) return;
          if (page.truncated) await outputGap(`输出缺口：起始游标 ${page.available_from}，历史输出已覆盖`);
          if (disposed) return;
          for (const event of page.events) {
            if (event.gap_bytes) { await outputGap(`设备接收输出缺口：丢失 ${event.gap_bytes} 字节`); if (disposed) return; continue; }
            display(decoder.decode(new Uint8Array(event.bytes)));
          }
          // A disconnected page may still have unread retained events. Flush only after drain.
          if (page.disconnected && page.events.length === 0) display(decoder.finish());
          cursor = page.next_cursor;
          await current.writer.drain();
          if (!disposed && !gap) setStatus(page.disconnected ? '会话已断开' : '服务输出已同步');
        } else setStatus('服务就绪 · 尚无活动连接');
        if (!disposed) timer = window.setTimeout(() => void poll(), 100);
      } catch (error) {
        if (!disposed && ['StaleGeneration', 'NotFound'].includes(String(error))) {
          current.writable = false;
          timer = window.setTimeout(() => void poll(), 100);
          return;
        }
        if (!disposed) { current.fixture = false; current.writable = false; setFailure('会话服务不可用；未重连或重放输入。请退出后重新启动。'); }
      }
    }
    let timer = 0;
    void poll();
    return () => { clip.invalidate(); clipboard.current = undefined; element.removeEventListener('paste', paste, true); disposed = true; stopped.current = true; clearTimeout(timer); runtime.current = null; queue.close(); clearTimeout(resizeTimer); resize.dispose(); observer.disconnect(); input.dispose(); current.writer.close(); term.dispose(); };
  }, []);

  useEffect(() => { if (runtime.current) { runtime.current.term.options.fontSize = fontSize; runtime.current.fit.fit(); } }, [fontSize]);

  async function createFixture() {
    setBusy(true);
    try {
      const connection = await invoke<Connection>('fixture_create');
      selectConnection(connection.connection_id);
      await invoke('fixture_append', { connection: { connection_id: connection.connection_id, generation: connection.generation }, bytes: Array.from(new TextEncoder().encode(demo)) });
    } catch { setFailure('合成会话创建失败；未重试'); }
    finally { setBusy(false); }
  }

  async function stress() {
    const connection = runtime.current?.connection;
    if (!connection) return;
    stopped.current = false; setBusy(true);
    try {
      for (let batch = 0; batch < 64 && !stopped.current; batch++) {
        await invoke('fixture_append', { connection, bytes: Array.from(new TextEncoder().encode(Array.from({ length: 16 }, (_, i) => `${batch * 16 + i}: 中文 ANSI \x1b[36moutput\x1b[0m\r\n`).join(''))) });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch { setFailure('合成输出失败；未重试'); }
    finally { setBusy(false); }
  }

  function capture() {
    const term = runtime.current?.term;
    if (!term) return;
    const buffer = term.buffer.active;
    setSnapshot(Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').join('\n').trimEnd());
  }

  async function captureServiceScreen() {
    const target = runtime.current?.connection;
    if (!target || selectedRef.current !== target.connection_id) return;
    try {
      const screen = await invoke<ServiceScreen>('service_screen', { connection: target });
      if (runtime.current?.connection?.connection_id === target.connection_id && runtime.current.connection.generation === target.generation && selectedRef.current === target.connection_id) setServiceScreen(screen);
    } catch { setInputFailure('服务端屏幕读取失败；未重试。'); }
  }

  return <main>
    <header><span className="eyebrow">共享终端 · 开发预览</span><h1>你的连接，同一个会话。</h1><p>{connections.length ? connections.every(item => item.protocol === 'FIXTURE') ? `${connections.length} 个合成会话 · 未连接设备` : `${connections.length} 个会话 · 连接状态见对应面板` : '尚无活动连接'}</p></header>
    <nav aria-label="会话控制">
      <button onClick={() => setConfigurationOpen(open => !open)}>连接配置</button>
      <button onClick={() => setSshOpen(open => !open)}>SSH2 连接</button>
      <button onClick={() => setExecOpen(open => !open)}>exec 任务</button>
      <button onClick={() => setSerialOpen(open => !open)}>串口连接</button>
      <button onClick={() => setLoggingOpen(open => !open)}>终端日志</button>
      <select aria-label="会话" value={selected} onChange={event => selectConnection(event.target.value)}>
        {!connections.length && <option value="">尚无会话</option>}
        {connections.map(connection => <option key={connection.connection_id} value={connection.connection_id}>{connection.protocol} · {connection.connection_id.slice(0, 8)} · 代次 {connection.generation}</option>)}
      </select>
      {service?.fixture && <><button disabled={busy || !!failure} onClick={() => void createFixture()}>新建合成会话</button><button disabled={busy || !selected || !!failure} onClick={() => void stress()}>高输出回放</button><button onClick={() => { stopped.current = true; }}>停止后续回放</button></>}
      <button onClick={() => void clipboard.current?.copy()}>复制选区</button>
      <button disabled={!selected} onClick={() => void clipboard.current?.paste()}>粘贴到终端</button>
      <button onClick={() => setSearchOpen(open => !open)}>查找终端</button>
      <button onClick={capture}>屏幕快照</button>
      <button disabled={!selected} onClick={() => void captureServiceScreen()}>服务端屏幕</button>
      <button onClick={() => void getCurrentWindow().close()}>退出桌面</button>
      <label>字号 <input aria-label="字号" type="number" min="10" max="28" value={fontSize} onChange={event => setFontSize(Math.max(10, Math.min(28, Number(event.target.value) || 15)))} /></label>
    </nav>
    {configurationOpen && <ConfigPanel close={() => setConfigurationOpen(false)} />}
    {sshOpen && <SshPanel connection={connections.find(item => item.connection_id === selected)} select={selectConnection} size={() => dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24)} />}
    <ExecPanel open={execOpen} connection={connections.find(item => item.connection_id === selected)} />
    {serialOpen && <SerialPanel connection={connections.find(item => item.connection_id === selected)} select={selectConnection} />}
    {searchOpen && <TerminalSearch key={`${selected}:${connections.find(item => item.connection_id === selected)?.generation}`} terminal={() => runtime.current?.term} close={() => setSearchOpen(false)} />}
    {pasteProposal && <section className="config-panel" aria-label="粘贴确认">
      <h2>确认粘贴到终端</h2>
      <small>目标 {pasteProposal.target.protocol} · {pasteProposal.target.connection_id} / 代次 {pasteProposal.target.generation}</small>
      <p>内容可能执行多条命令。CR/LF按原样发送，不自动添加换行；{pasteProposal.bracketed ? '使用终端请求的括号粘贴模式，不能保证远端安全。' : '当前未启用括号粘贴模式。'}继续键盘输入或切换目标会取消此预览。</p>
      <small>{pasteProposal.text.length} 个UTF-16单元 · CR {pasteProposal.text.split('\r').length - 1} · LF {pasteProposal.text.split('\n').length - 1} · 转义预览（最多8192个单元）</small>
      <pre aria-label="粘贴内容预览">{visibleControls(JSON.stringify(pasteProposal.text.slice(0,8192)))}{pasteProposal.text.length > 8192 && ' …预览已截断'}</pre>
      <div className="config-actions"><button onClick={() => clipboard.current?.confirm(pasteProposal)}>确认发送粘贴</button><button autoFocus onClick={() => { clipboard.current?.invalidate(); setClipboardMessage('已取消粘贴；未发送'); runtime.current?.term.focus(); }}>取消粘贴</button></div>
    </section>}
    {clipboardMessage && <div role="status" aria-label="剪贴板状态">{clipboardMessage}</div>}
    <div className="terminal" ref={host} aria-label="服务终端" />
    <div className="status" role="status">{failure || inputFailure || status}</div>
    {decodeWarning && <div role="status" aria-label="接收解码提示">{decodeWarning}</div>}
    <div className="input-status">{connections.find(item => item.connection_id === selected)?.protocol === 'SSH2' ? 'SSH2 输入' : connections.find(item => item.connection_id === selected)?.protocol === 'SERIAL' ? '串口输入' : service?.fixture ? '合成键盘事件' : '尚无设备输入'}：<output>{lastInput}</output></div>
    <LoggingPanel connection={connections.find(item=>item.connection_id===selected)} open={loggingOpen} close={()=>setLoggingOpen(false)} />
    {snapshot && <pre aria-label="屏幕快照">{snapshot}</pre>}
    {serviceScreen && <details open><summary>服务端屏幕快照</summary><small>{serviceScreen.connection.connection_id} / {serviceScreen.connection.generation} · {serviceScreen.encoding} · {serviceScreen.rows}×{serviceScreen.cols} · 来源游标 {serviceScreen.source_cursor} · {serviceScreen.parser} · 宽度变化不重排，可能与桌面显示不同 · 接收缺口 {serviceScreen.gap_bytes} 字节 · 解码错误事件 {serviceScreen.decode_error_events}{serviceScreen.contents_truncated && ' · 快照文本已截断'}{serviceScreen.completed && ' · 输出已结束'}</small><pre aria-label="服务端屏幕快照">{serviceScreen.contents || '空屏幕'}</pre></details>}
    <footer>{service && <span>服务 {service.service_id} · </span>}关闭桌面将停止服务 · 重载页面保留服务会话 · 未完成 SSH/串口验收</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
