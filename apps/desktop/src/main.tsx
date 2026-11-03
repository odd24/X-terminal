import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalWriter } from './terminal-writer';
import '@xterm/xterm/css/xterm.css';
import './style.css';

function App() {
  return <TerminalPrototype />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

const demo = '共享终端 · 合成 UTF-8/ANSI 回放\r\n\x1b[32m中文宽字 ✓\x1b[0m\r\n键盘只回显在本地原型，不会发送到设备。\r\n\x1b[?1049h\x1b[2J\x1b[H替代屏幕\x1b[?1049l';

function TerminalPrototype() {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ term: Terminal; writer: TerminalWriter; fit: FitAddon } | null>(null);
  const epoch = useRef(0);
  const [status, setStatus] = useState('准备合成回放');
  const [lastInput, setLastInput] = useState('尚无输入');
  const [fontSize, setFontSize] = useState(15);
  const [snapshot, setSnapshot] = useState('');

  useEffect(() => {
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, fontFamily: 'Consolas, "Microsoft YaHei", monospace', fontSize: 15, scrollback: 512, theme: { background: '#101720', foreground: '#e7edf5' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    const writer = new TerminalWriter(term);
    const current = { term, writer, fit };
    runtime.current = current;
    const input = term.onData(data => {
      setLastInput(JSON.stringify(data));
      const accepted = current.writer.enqueue(new TextEncoder().encode(data === '\r' ? '\r\n' : data));
      if (!accepted) setStatus(`输出缺口：${current.writer.lostBytes} 字节；请重新回放`);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);
    writer.enqueue(new TextEncoder().encode(demo));
    writer.drain().then(() => {
      if (runtime.current === current && current.writer === writer) setStatus('合成回放完成');
    });
    return () => { epoch.current++; runtime.current = null; observer.disconnect(); input.dispose(); current.writer.close(); term.dispose(); };
  }, []);

  useEffect(() => {
    if (runtime.current) { runtime.current.term.options.fontSize = fontSize; runtime.current.fit.fit(); }
  }, [fontSize]);

  async function replay(stress: boolean) {
    const current = runtime.current;
    if (!current) return;
    const token = ++epoch.current;
    current.writer.close();
    // FIFO barrier: settle the old in-flight write before resetting parser state.
    await new Promise<void>(resolve => current.term.write(new Uint8Array(), resolve));
    if (epoch.current !== token) return;
    current.term.reset();
    current.writer = new TerminalWriter(current.term);
    const writer = current.writer;
    setStatus(stress ? '高输出合成回放中' : '逐字节合成回放中');
    setSnapshot('');
    const encoder = new TextEncoder();
    if (!stress) {
      for (const byte of encoder.encode(demo)) {
        if (epoch.current !== token) return;
        writer.enqueue(new Uint8Array([byte]));
        await writer.drain();
      }
    } else {
      for (let batch = 0; batch < 256; batch++) {
        if (epoch.current !== token) return;
        const bytes = encoder.encode(Array.from({ length: 64 }, (_, i) => `${batch * 64 + i}: 中文 ANSI \x1b[36moutput\x1b[0m\r\n`).join(''));
        if (!writer.enqueue(bytes)) break;
        await writer.drain();
      }
    }
    if (epoch.current === token) setStatus(writer.lostBytes ? `输出缺口：${writer.lostBytes} 字节；请重新回放` : '合成回放完成');
  }

  function capture() {
    const term = runtime.current?.term;
    if (!term) return;
    const buffer = term.buffer.active;
    setSnapshot(Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').join('\n').trimEnd());
  }

  return <main>
    <header><span className="eyebrow">共享终端 · P02 渲染原型</span><h1>你的连接，同一个会话。</h1><p>尚无活动连接 · 当前仅为本地合成输出</p></header>
    <nav aria-label="回放控制">
      <button onClick={() => void replay(false)}>逐字节回放</button>
      <button onClick={() => void replay(true)}>高输出回放</button>
      <button onClick={() => { epoch.current++; setStatus('已停止后续合成输出'); }}>停止</button>
      <button onClick={capture}>屏幕快照</button>
      <label>字号 <input aria-label="字号" type="number" min="10" max="28" value={fontSize} onChange={event => setFontSize(Math.max(10, Math.min(28, Number(event.target.value) || 15)))} /></label>
    </nav>
    <div className="terminal" ref={host} aria-label="合成终端" />
    <div className="status" role="status">{status}</div>
    <div className="input-status">本地键盘事件：<output>{lastInput}</output></div>
    {snapshot && <pre aria-label="屏幕快照">{snapshot}</pre>}
    <footer>未连接设备 · 输入只用于原型验证 · 不代表 SSH/串口验收</footer>
  </main>;
}
