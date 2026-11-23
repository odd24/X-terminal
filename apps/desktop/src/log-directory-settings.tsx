import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';

type Current = { result: 'current'; revision: string; directory: string | null; effective: string };
type Selection = { result: 'selected'; selection_id: string; path: string };
type Reply = Current | Selection | { result: 'cancelled' };
type Action = { kind: 'read' | 'choose' } | { kind: 'restore'; revision: string } |
  { kind: 'save'; revision: string; selection_id: string };
const settings = (action: Action) => invoke<Reply>('log_directory_settings', { action });

export function LogDirectorySettings() {
  const [current, setCurrent] = useState<Current>();
  const [selection, setSelection] = useState<Selection>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const flight = useRef(false);

  useEffect(() => {
    let active = true;
    void settings({ kind: 'read' }).then(reply => {
      if (active && reply.result === 'current') setCurrent(reply);
    }).catch(() => {
      if (active) setError('无法读取日志目录设置。');
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, []);

  async function act(action: Action | { kind: 'open' }) {
    if (flight.current || busy) return;
    flight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const update = action.kind === 'save' || action.kind === 'restore';
    if (update || action.kind === 'choose' || action.kind === 'read') setSelection(undefined);
    try {
      if (action.kind === 'open') {
        await invoke('open_managed_log_directory');
        return;
      }
      const reply = await settings(action);
      if (reply.result === 'selected') setSelection(reply);
      if (reply.result === 'current') {
        setCurrent(reply);
        if (update) setMessage('已保存。下次开始录制时使用此目录。');
      }
    } catch (reason) {
      if (update) {
        try {
          const reply = await settings({ kind: 'read' });
          if (reply.result !== 'current') throw new Error('INVALID_LOG_REPLY');
          setCurrent(reply);
          const applied = action.kind === 'restore' ? reply.directory === null : reply.directory === selection?.path;
          if (applied) setMessage('已重新读取并确认当前目录。');
          else setError(String(reason) === 'InvalidArgument'
            ? '无法写入所选目录或保存设置。当前目录已重新读取。'
            : '保存未确认。当前目录已重新读取，请核对后再操作。');
        } catch {
          setCurrent(undefined);
          setError('保存结果未确认，请重新读取当前目录。');
        }
      } else {
        setError(action.kind === 'open' ? '无法打开当前日志目录。' :
          action.kind === 'choose' ? '无法选择日志目录。' : '无法读取日志目录设置。');
      }
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  return <section aria-label="日志保存位置" className="log-viewer-settings log-directory-settings">
    <strong>日志保存位置</strong>
    {current && <p aria-label="当前日志保存位置">{current.effective}</p>}
    {selection && <p aria-label="待保存日志目录">{selection.path}</p>}
    <div className="config-actions">
      <button disabled={busy || !current} onClick={() => void act({ kind: 'choose' })}>选择文件夹</button>
      {selection && current && <button disabled={busy} onClick={() => void act({
        kind: 'save', revision: current.revision, selection_id: selection.selection_id,
      })}>保存日志目录</button>}
      <button disabled={busy || !current} onClick={() => void act({ kind: 'open' })}>打开当前目录</button>
      <button disabled={busy || !current?.directory} onClick={() => {
        if (current) void act({ kind: 'restore', revision: current.revision });
      }}>恢复默认目录</button>
      {!current && <button disabled={busy} onClick={() => void act({ kind: 'read' })}>重新读取</button>}
    </div>
    <small>正在录制的日志继续写入原文件。</small>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
