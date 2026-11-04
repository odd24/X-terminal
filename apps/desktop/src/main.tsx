import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalWriter } from './terminal-writer';
import { ConfigPanel } from './config-panel';
import { SshPanel } from './ssh-panel';
import { ExecPanel } from './exec-panel';
import { InputQueue } from './input-queue';
import { requestId } from './request-id';
import { ssh, dimensions, type Receipt } from './ssh-api';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Connection = { connection_id: string; generation: number; protocol: string; state: string };
type Ref = Pick<Connection, 'connection_id' | 'generation'>;
type Status = { service_id: string; pid: number; fixture: boolean; exit_policy: string };
type Page = { connection: Ref; events: { seq: number; bytes: number[]; gap_bytes?: number }[]; next_cursor: number; available_from: number; truncated: boolean; disconnected: boolean };
const demo = '共享终端 · 服务合成 UTF-8/ANSI 回放\r\n\x1b[32m中文宽字 ✓\x1b[0m\r\n输入通过统一服务追加到合成输出，不发送到设备。\r\n\x1b[?1049h\x1b[2J\x1b[H替代屏幕\x1b[?1049l';

function App() {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
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
    const newQueue = () => new InputQueue(() => { if (!disposed) setInputFailure('输入结果可能未知；已停止本页面后续输入，未重试。请核对远端状态。'); });
    let queue = newQueue();
    let resizeTimer = 0;
    let lastSize = '';
    function submit(action: { bytes: number[] } | { cols: number; rows: number }) {
      const target = current.connection;
      if (!target || current.protocol !== 'SSH2' || !current.writable || selectedRef.current !== target.connection_id) return;
      const id = requestId();
      const accepted = queue.enqueue(async () => {
        // A selection change drops unsent input rather than retargeting it.
        if (disposed || current.connection?.connection_id !== target.connection_id || current.connection.generation !== target.generation || selectedRef.current !== target.connection_id) return;
        const reply = await ssh('bytes' in action
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
    const input = term.onData(data => {
      if (current.protocol === 'SSH2') {
        if (!current.writable || selectedRef.current !== current.connection?.connection_id) { setLastInput('连接当前不可写；此次输入未发送'); return; }
        const bytes = Array.from(new TextEncoder().encode(data));
        if (bytes.length > 65536) { setInputFailure('单次输入超过 64 KiB；此次输入未发送'); return; }
        setLastInput(`收到 ${bytes.length} 字节输入；内容不显示`);
        submit({ bytes });
        return;
      }
      if (!current.fixture || current.protocol !== 'FIXTURE' || !current.connection) return;
      setLastInput(JSON.stringify(data));
      if (current.inputs >= 16) { setStatus('合成输入队列已满；此次输入未发送'); return; }
      current.inputs++;
      void invoke('fixture_append', { connection: current.connection, bytes: Array.from(new TextEncoder().encode(data === '\r' ? '\r\n' : data)) })
        .catch(() => { if (!disposed) setFailure('合成输入失败；未重试'); })
        .finally(() => current.inputs--);
    });
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
          current.writable = false; queue.close(); queue = newQueue(); lastSize = '';
          current.writer.close();
          current.connection = undefined; current.protocol = '';
          await new Promise<void>(resolve => term.write(new Uint8Array(), resolve));
          if (disposed) return;
          if (selectedRef.current !== wanted) { timer = window.setTimeout(() => void poll(), 0); return; }
          term.reset(); current.writer = new TerminalWriter(term);
          cursor = 1; gap = false; setSnapshot(''); setLastInput('尚无输入'); setInputFailure('');
          if (selectedRef.current === wanted) { selectedRef.current = ''; setSelected(''); }
        }
        if (connection && (connection.connection_id !== current.connection?.connection_id || connection.generation !== current.connection?.generation)) {
          current.writable = false; queue.close(); queue = newQueue(); lastSize = '';
          current.writer.close();
          await new Promise<void>(resolve => term.write(new Uint8Array(), resolve));
          if (disposed) return;
          if (selectedRef.current !== wanted) {
            // A newer user selection wins over a poll suspended in xterm.write.
            current.connection = undefined;
            timer = window.setTimeout(() => void poll(), 0);
            return;
          }
          term.reset();
          current.writer = new TerminalWriter(term);
          current.connection = { connection_id: connection.connection_id, generation: connection.generation };
          cursor = 1; gap = false; setSnapshot(''); setLastInput('尚无输入'); setInputFailure('');
          selectedRef.current = connection.connection_id; setSelected(connection.connection_id);
        }
        current.protocol = connection?.protocol ?? '';
        current.writable = connection?.state === 'CONNECTED';
        if (current.protocol === 'SSH2' && current.writable && !lastSize) {
          const size = dimensions(term.cols, term.rows);
          submit(size); lastSize = `${size.cols}:${size.rows}`;
        }
        if (current.connection) {
          const page = await invoke<Page>('service_read', { connection: current.connection, cursor });
          if (disposed) return;
          if (page.truncated) { gap = true; setStatus(`输出缺口：起始游标 ${page.available_from}，历史输出已覆盖`); }
          for (const event of page.events) {
            if (event.gap_bytes) { gap = true; setStatus(`设备接收输出缺口：丢失 ${event.gap_bytes} 字节`); continue; }
            if (!current.writer.enqueue(new Uint8Array(event.bytes))) { gap = true; setStatus('渲染队列输出缺口；请重载后读取保留输出'); }
          }
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
    return () => { disposed = true; stopped.current = true; clearTimeout(timer); runtime.current = null; queue.close(); clearTimeout(resizeTimer); resize.dispose(); observer.disconnect(); input.dispose(); current.writer.close(); term.dispose(); };
  }, []);

  useEffect(() => { if (runtime.current) { runtime.current.term.options.fontSize = fontSize; runtime.current.fit.fit(); } }, [fontSize]);

  async function createFixture() {
    setBusy(true);
    try {
      const connection = await invoke<Connection>('fixture_create');
      selectedRef.current = connection.connection_id;
      setSelected(connection.connection_id);
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

  return <main>
    <header><span className="eyebrow">共享终端 · 开发预览</span><h1>你的连接，同一个会话。</h1><p>{connections.length ? connections.every(item => item.protocol === 'FIXTURE') ? `${connections.length} 个合成会话 · 未连接设备` : `${connections.length} 个会话 · SSH2 连接状态见面板` : '尚无活动连接'}</p></header>
    <nav aria-label="会话控制">
      <button onClick={() => setConfigurationOpen(open => !open)}>连接配置</button>
      <button onClick={() => setSshOpen(open => !open)}>SSH2 连接</button>
      <button onClick={() => setExecOpen(open => !open)}>exec 任务</button>
      <select aria-label="会话" value={selected} onChange={event => { selectedRef.current = event.target.value; setSelected(event.target.value); }}>
        {!connections.length && <option value="">尚无会话</option>}
        {connections.map(connection => <option key={connection.connection_id} value={connection.connection_id}>{connection.protocol} · {connection.connection_id.slice(0, 8)} · 代次 {connection.generation}</option>)}
      </select>
      {service?.fixture && <><button disabled={busy || !!failure} onClick={() => void createFixture()}>新建合成会话</button><button disabled={busy || !selected || !!failure} onClick={() => void stress()}>高输出回放</button><button onClick={() => { stopped.current = true; }}>停止后续回放</button></>}
      <button onClick={capture}>屏幕快照</button>
      <button onClick={() => void getCurrentWindow().close()}>退出桌面</button>
      <label>字号 <input aria-label="字号" type="number" min="10" max="28" value={fontSize} onChange={event => setFontSize(Math.max(10, Math.min(28, Number(event.target.value) || 15)))} /></label>
    </nav>
    {configurationOpen && <ConfigPanel close={() => setConfigurationOpen(false)} />}
    {sshOpen && <SshPanel connection={connections.find(item => item.connection_id === selected)} select={id => { selectedRef.current = id; setSelected(id); }} size={() => dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24)} />}
    <ExecPanel open={execOpen} connection={connections.find(item => item.connection_id === selected)} />
    <div className="terminal" ref={host} aria-label="服务终端" />
    <div className="status" role="status">{failure || inputFailure || status}</div>
    <div className="input-status">{connections.find(item => item.connection_id === selected)?.protocol === 'SSH2' ? 'SSH2 输入' : service?.fixture ? '合成键盘事件' : '尚无设备输入'}：<output>{lastInput}</output></div>
    {snapshot && <pre aria-label="屏幕快照">{snapshot}</pre>}
    <footer>{service && <span>服务 {service.service_id} · </span>}关闭桌面将停止服务 · 重载页面保留服务会话 · 未完成 SSH/串口验收</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
