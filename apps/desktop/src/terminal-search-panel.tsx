import { Field, Panel } from './ui';
import { useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { searchTerminal, type TerminalMatch } from './terminal-search';

export function TerminalSearch({ terminal, close, closeFromKeyboard }: {
  terminal: () => Terminal | undefined;
  close: () => void;
  closeFromKeyboard: () => void;
}) {
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('仅搜索当前终端保留的缓冲区；区分大小写，不搜索日志。');
  const [previous, setPrevious] = useState<TerminalMatch>();
  function find(backward: boolean) {
    const term = terminal();
    if (!term) return;
    const { matches, limited } = searchTerminal(term.buffer.active, term.cols, query);
    if (!query) { term.clearSelection(); setMessage('请输入查找文字'); return; }
    if (!matches.length) { term.clearSelection(); setPrevious(undefined); setMessage(limited ? '扫描上限内未找到' : '未找到'); return; }
    const position = previous && matches.findIndex(item => item.row === previous.row && item.col === previous.col);
    const index = position === undefined || position < 0 ? (backward ? matches.length - 1 : 0) : (position + (backward ? -1 : 1) + matches.length) % matches.length;
    const match = matches[index];
    term.select(match.col, match.row, match.length); term.scrollToLine(match.row);
    setPrevious(match); setMessage(`${index + 1} / ${matches.length}${limited ? '（已达扫描或1000条显示上限）' : ''} · 当前保留缓冲区`);
  }
  return <Panel title="终端查找" closeLabel="关闭查找" close={() => { terminal()?.clearSelection(); close(); terminal()?.focus(); }}>
    <Field label="查找文字"><input autoFocus aria-label="终端查找文字" maxLength={256} value={query} onChange={event => { setQuery(event.target.value); setPrevious(undefined); }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); }
      if (event.key === 'Escape') { event.preventDefault(); closeFromKeyboard(); }
    }} /></Field>
    <div className="config-actions"><button onClick={() => find(true)}>上一个匹配</button><button onClick={() => find(false)}>下一个匹配</button><button onClick={() => { terminal()?.scrollToBottom(); terminal()?.focus(); }}>回到底部</button></div>
    <div role="status" aria-label="终端查找状态">{message}</div>
  </Panel>;
}
