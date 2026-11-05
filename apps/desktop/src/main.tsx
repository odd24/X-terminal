import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
import { terminalAppearance, type ThemeChoice, type TerminalFont } from './appearance';
import { AppearancePanel } from './appearance-panel';
import { ComposePanel } from './compose-panel';
import { ComposeDrafts, type ComposeTarget } from './compose-drafts';
import { SessionTree } from './session-tree';
import { config, type DesktopPreferences, type Profile } from './config-api';
import { ConfigPanel } from './config-panel';
import { SshPanel } from './ssh-panel';
import { ExecPanel } from './exec-panel';
import { SerialPanel } from './serial-panel';
import { LoggingPanel } from './logging-panel';
import { serial, serialResult, type SerialStatus } from './serial-api';
import { InputQueue } from './input-queue';
import { requestId } from './request-id';
import { ssh, dimensions, type Receipt, type SshReply } from './ssh-api';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Connection = { connection_id: string; generation: number; protocol: string; state: string };
type Ref = Pick<Connection, 'connection_id' | 'generation'>;
type ServiceScreen = { connection: Ref; encoding: string; parser: string; resize_reflow: boolean; rows: number; cols: number; contents: string; contents_truncated: boolean; cursor_row: number; cursor_col: number; alternate: boolean; source_cursor: number; completed: boolean; gap_bytes: number; decode_error_events: number };
type Status = { service_id: string; pid: number; fixture: boolean; exit_policy: string };
type Page = { connection: Ref; events: { seq: number; bytes: number[]; gap_bytes?: number }[]; next_cursor: number; available_from: number; truncated: boolean; disconnected: boolean };
const demo = '共享终端 · 服务合成 UTF-8/ANSI 回放\r\n\x1b[32m中文宽字 ✓\x1b[0m\r\n输入通过统一服务追加到合成输出，不发送到设备。\r\n\x1b[?1049h\x1b[2J\x1b[H替代屏幕\x1b[?1049l';

function App() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeEpoch, setComposeEpoch] = useState(0);
  const [renderedTarget, setRenderedTarget] = useState<ComposeTarget>();
  const drafts = useRef(new ComposeDrafts());
  const composeSend = useRef<((target: ComposeTarget, text: string) => boolean) | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navigationWidth, setNavigationWidth] = useState(260);
  const tabList = useRef<HTMLDivElement>(null);
  const [treeRevision, setTreeRevision] = useState(0);
  const [requestedProfile, setRequestedProfile] = useState<Profile>();
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
  const hiddenRef = useRef<string[]>([]);
  const [tabNames, setTabNames] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState<Connection>();
  const [tabMessage, setTabMessage] = useState('');
  const [tabBusy, setTabBusy] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  const allowExit = useRef(false);
  const liveConnections = useRef<Connection[]>([]);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [preferences, setPreferences] = useState<DesktopPreferences>({ theme: 'dark', terminal_font: 'consolas', font_size: 15, ctrl_c_copy: true, ctrl_v_paste: false, right_click_paste: false });
  const preferenceRef = useRef(preferences); preferenceRef.current = preferences;
  const theme: ThemeChoice = preferences.theme, terminalFont: TerminalFont = preferences.terminal_font;
  const fontSize = preferences.font_size;
  const [preferencesBusy, setPreferencesBusy] = useState(true);
  const preferenceFlight = useRef(false), preferenceEpoch = useRef(0);
  const [preferenceRevision, setPreferenceRevision] = useState<string>();
  const [preferenceMessage, setPreferenceMessage] = useState('正在读取本数据目录偏好');
  function updatePreferences(patch: Partial<DesktopPreferences>) {
    if (preferenceFlight.current) return;
    clipboard.current?.invalidate();
    setPreferences(previous => ({ ...previous, ...patch }));
    setPreferenceMessage('本窗口调整尚未保存；关闭或重载会丢弃未保存的调整');
  }
  const setTheme = (theme: ThemeChoice) => updatePreferences({ theme });
  const setTerminalFont = (terminal_font: TerminalFont) => updatePreferences({ terminal_font });
  const setFontSize = (font_size: number) => updatePreferences({ font_size });
  async function preferenceOperation(save: boolean) {
    if (preferenceFlight.current || (save && !preferenceRevision)) return;
    preferenceFlight.current = true; setPreferencesBusy(true);
    const epoch = ++preferenceEpoch.current;
    setPreferenceMessage(save ? '正在保存本数据目录偏好' : '正在读取本数据目录偏好');
    try {
      const reply = await config(save ? { op: 'save_preferences', preferences: preferenceRef.current, revision: preferenceRevision! } : { op: 'preferences' });
      if (epoch !== preferenceEpoch.current) return;
      if (reply.result !== 'preferences') throw new Error('偏好响应不匹配');
      clipboard.current?.invalidate(); setPreferences(reply.preferences); setPreferenceRevision(reply.revision);
      setPreferenceMessage(save ? '已保存到本数据目录；重载或下次启动自动读取' : '已读取本数据目录偏好；未发送任何终端输入');
    } catch (error) {
      if (epoch !== preferenceEpoch.current) return;
      setPreferenceRevision(undefined);
      setPreferenceMessage(`${error instanceof Error ? error.message : '偏好请求失败'} ${save ? '保存结果可能未知；请重新读取核对，未自动重试。' : '当前显示保留，未覆盖存储；可重新读取。'}`);
    } finally {
      if (epoch === preferenceEpoch.current) { preferenceFlight.current = false; setPreferencesBusy(false); }
    }
  }
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
    setRenderedTarget(undefined);
    hiddenRef.current = hiddenRef.current.filter(item => item !== id); setHiddenTabs(hiddenRef.current);
    drafts.current.invalidate(); clipboard.current?.invalidate(); selectedRef.current = id; setSelected(id);
  }
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ term: Terminal; fit: FitAddon; writer: TerminalWriter; connection?: Ref; fixture: boolean; inputs: number; protocol: string; writable: boolean } | null>(null);
  const [service, setService] = useState<Status>();
  const [connections, setConnections] = useState<Connection[]>([]);
  liveConnections.current = connections;
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const [status, setStatus] = useState('正在连接会话服务');
  const [failure, setFailure] = useState('');
  const [lastInput, setLastInput] = useState('尚无输入');
  const [inputFailure, setInputFailure] = useState('');
  const [snapshot, setSnapshot] = useState('');
  const [decodeWarning, setDecodeWarning] = useState('');
  const [serviceScreen, setServiceScreen] = useState<ServiceScreen>();
  const [busy, setBusy] = useState(false);
  const stopped = useRef(false);

  useEffect(() => {
    if (!service?.service_id) return;
    preferenceFlight.current = false;
    void preferenceOperation(false);
    return () => { preferenceEpoch.current++; preferenceFlight.current = false; };
  }, [service?.service_id]);

  useEffect(() => {
    const tab = Array.from(tabList.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).find(item => item.dataset.connectionId === selected);
    const reveal = () => tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal(); const observer = new ResizeObserver(reveal);
    if (tabList.current) observer.observe(tabList.current);
    return () => observer.disconnect();
  }, [selected, tabOrder]);

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(event => {
      if (!allowExit.current && liveConnections.current.some(item => ['SSH2', 'SERIAL'].includes(item.protocol) && !['DISCONNECTED', 'FAILED'].includes(item.state))) {
        event.preventDefault(); setExitConfirm(true);
      }
    });
    return () => { void unlisten.then(dispose => dispose()); };
  }, []);

  useEffect(() => {
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, ...terminalAppearance(), fontSize: 15, scrollback: 512 });
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
      if (!target || !['SSH2','SERIAL'].includes(protocol) || !current.writable || selectedRef.current !== target.connection_id) return false;
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
      // Error text can resize the terminal, enqueueing another resize against a
      // stopped queue. Keep the original dispatch failure visible.
      if (!accepted) setInputFailure(previous => previous || '输入队列已满或已停止；此次输入未发送。');
      return accepted;
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
    const contextMenu = (event: MouseEvent) => {
      if (!preferenceRef.current.right_click_paste) return;
      event.preventDefault(); event.stopImmediatePropagation(); void clip.paste();
    };
    element.addEventListener('paste', paste, true);
    element.addEventListener('contextmenu', contextMenu, true);
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      if (event.key.toLowerCase() === 'c' && ((preferenceRef.current.ctrl_c_copy && term.hasSelection()) || event.shiftKey)) { event.preventDefault(); void clip.copy(); return false; }
      if (event.key.toLowerCase() === 'v' && (event.shiftKey || preferenceRef.current.ctrl_v_paste)) { event.preventDefault(); void clip.paste(); return false; }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); setSearchOpen(true); return false; }
      return true;
    });
    function receiveInput(data: string, compose = false): boolean {
      if (!compose) setComposeEpoch(value => value + 1);
      drafts.current.invalidate(); clip.invalidate();
      if (current.protocol === 'SERIAL') {
        if (!current.writable || selectedRef.current !== current.connection?.connection_id) { setLastInput('串口当前不可写，此次输入未发送'); return false; }
        if (new TextEncoder().encode(data).length > 65536) { setInputFailure('单次输入超过 64 KiB；此次输入未发送'); return false; }
        setLastInput('串口键盘输入已收到，内容不显示；Enter 按终端 CR 发送'); return submit({ text: data });
      }
      if (current.protocol === 'SSH2') {
        if (!current.writable || selectedRef.current !== current.connection?.connection_id) { setLastInput('连接当前不可写；此次输入未发送'); return false; }
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
    composeSend.current = (target, text) => {
      if (disposed || !current.connection || selectedRef.current !== target.connection_id || current.connection.connection_id !== target.connection_id || current.connection.generation !== target.generation || current.protocol !== target.protocol || !current.writable) return false;
      return receiveInput(text, true);
    };
    const input = term.onData(data => receiveInput(data));
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
        const connection = sessions.find(item => item.connection_id === wanted) ?? (!wanted ? sessions.find(item => !hiddenRef.current.includes(item.connection_id)) : undefined);
        if (!connection && wanted && current.connection?.connection_id !== wanted) {
          current.writable = false;
          setStatus('正在刷新所选会话；输入尚未发送');
          timer = window.setTimeout(() => void poll(), 100);
          return;
        }
        if (!connection && current.connection) {
          drafts.current.invalidate(); clip.invalidate(); current.writable = false; queue.close(); queue = newQueue(); lastSize = '';
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
            // Keep structured read errors: removal/reconnect may race the list.
            // The user-facing wrappers translate these codes into prose.
            const metadata = await invoke<SerialStatus>('serial_request', { request: { op: 'status', connection: { connection_id: connection.connection_id, generation: connection.generation } } });
            if (disposed) return;
            if (metadata.result !== 'status') throw new Error('Invalid serial status');
            encoding = metadata.encoding;
          }
          if (connection.protocol === 'SSH2') {
            const metadata = await invoke<SshReply>('ssh_request', { request: { op: 'status', connection: { connection_id: connection.connection_id, generation: connection.generation } } });
            if (disposed) return;
            if (metadata.result !== 'status' || metadata.connection.connection_id !== connection.connection_id || metadata.connection.generation !== connection.generation) throw new Error('Invalid SSH encoding status');
            encoding = metadata.encoding;
          }
          drafts.current.invalidate(); clip.invalidate(); current.writable = false; queue.close(); queue = newQueue(); lastSize = '';
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
          if (!disposed && current.connection && selectedRef.current === current.connection.connection_id) setRenderedTarget({ ...current.connection, protocol: current.protocol });
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
    return () => { composeSend.current = undefined; drafts.current.invalidate(); clip.invalidate(); clipboard.current = undefined; element.removeEventListener('paste', paste, true); element.removeEventListener('contextmenu', contextMenu, true); disposed = true; stopped.current = true; clearTimeout(timer); runtime.current = null; queue.close(); clearTimeout(resizeTimer); resize.dispose(); observer.disconnect(); input.dispose(); current.writer.close(); term.dispose(); };
  }, []);

  useEffect(() => {
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.terminalFont = terminalFont;
      if (runtime.current) {
        const appearance = terminalAppearance();
        runtime.current.term.options.theme = appearance.theme;
        runtime.current.term.options.fontFamily = appearance.fontFamily;
        runtime.current.fit.fit();
      }
    };
    apply();
    systemTheme.addEventListener('change', apply);
    return () => systemTheme.removeEventListener('change', apply);
  }, [theme, terminalFont]);

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
    const lines = Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true, 0, term.cols) ?? '');
    while (lines.at(-1) === '') lines.pop();
    setSnapshot(lines.join('\n'));
  }

  async function captureServiceScreen() {
    const target = runtime.current?.connection;
    if (!target || selectedRef.current !== target.connection_id) return;
    try {
      const screen = await invoke<ServiceScreen>('service_screen', { connection: target });
      if (runtime.current?.connection?.connection_id === target.connection_id && runtime.current.connection.generation === target.generation && selectedRef.current === target.connection_id) setServiceScreen(screen);
    } catch { setInputFailure('服务端屏幕读取失败；未重试。'); }
  }

  const tabs = [...connections.filter(item => !hiddenTabs.includes(item.connection_id))].sort((a, b) => {
    const rank = (id: string) => tabOrder.includes(id) ? tabOrder.indexOf(id) : tabOrder.length + connections.findIndex(item => item.connection_id === id);
    return rank(a.connection_id) - rank(b.connection_id);
  });
  const active = connections.find(item => item.connection_id === selected);
  const tabName = (connection: Connection) => tabNames[connection.connection_id] ?? `${connection.protocol} · ${connection.connection_id.slice(0, 8)}`;
  function moveTab(offset: number) {
    const ids = tabs.map(item => item.connection_id); const index = ids.indexOf(selected);
    if (index < 0 || index + offset < 0 || index + offset >= ids.length) return;
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; setTabOrder(ids);
  }
  function hideTab(connection: Connection) {
    hiddenRef.current = [...new Set([...hiddenRef.current, connection.connection_id])]; setHiddenTabs(hiddenRef.current);
    if (selectedRef.current === connection.connection_id) selectConnection(tabs.find(item => item.connection_id !== connection.connection_id)?.connection_id ?? '');
  }
  async function confirmClose() {
    if (!closing || tabBusy) return;
    const target = closing; setTabBusy(true);
    try {
      const latest = connections.find(item => item.connection_id === target.connection_id);
      if (!latest || latest.generation !== target.generation) throw new Error('连接代次已变化；未关闭新连接。');
      if (!['DISCONNECTED', 'FAILED'].includes(latest.state)) {
        if (target.protocol === 'SSH2') await ssh({ op: 'close', connection: { connection_id: target.connection_id, generation: target.generation } });
        else if (target.protocol === 'SERIAL') await serial({ op: 'close', connection: { connection_id: target.connection_id, generation: target.generation } });
        else throw new Error('此连接请使用对应控制面板关闭；可选择保留连接隐藏标签。');
      }
      hideTab(target); setClosing(undefined); setTabMessage('关闭请求已提交，标签已隐藏；服务状态以全部连接列表为准，已发送动作不会撤销。');
    } catch (error) { setTabMessage((error as Error).message + ' 未自动重试；可在对应连接面板核对实际状态。'); }
    finally { setTabBusy(false); }
  }
  async function connectProfile(profile: Profile) {
    if (tabBusy) return;
    setRequestedProfile(profile);
    if (profile.settings.protocol === 'serial') { setSerialOpen(true); setTabMessage('请在串口面板刷新并核对设备身份与控制线后显式打开。'); return; }
    if (profile.settings.protocol === 'ssh1') { setTabMessage('SSH1 正式适配尚未完成；不会改用 SSH2 或自动降级。'); return; }
    setTabBusy(true); setSshOpen(true);
    try {
      const reply = await ssh({ op: 'start', profile_id: profile.id, request_id: requestId(), ...dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24) });
      if (reply.result !== 'started') throw new Error('连接响应不匹配；请在连接面板核对。');
      setTabNames(values => ({ ...values, [reply.connection.connection_id]: profile.name }));
      selectConnection(reply.connection.connection_id); setTabMessage('已建立独立连接实例；请在 SSH2 面板核对身份与认证。');
    } catch (error) { setTabMessage((error as Error).message); }
    finally { setTabBusy(false); }
  }

  return <main className="desktop-shell" style={{ '--navigation-width': `${navigationWidth}px` } as CSSProperties}>
    <header className="app-bar"><strong>共享终端</strong><button aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>会话导航</button><span>{connections.length} 个服务连接</span></header>
    <nav aria-label="会话控制">
      <button onClick={() => setConfigurationOpen(open => !open)}>连接配置</button>
      <button onClick={() => setSshOpen(open => !open)}>SSH2 连接</button>
      <button onClick={() => setExecOpen(open => !open)}>exec 任务</button>
      <button onClick={() => setSerialOpen(open => !open)}>串口连接</button>
      <button onClick={() => { drafts.current.invalidate(); setComposeOpen(open => !open); }}>基础撰写</button>
      <button onClick={() => setLoggingOpen(open => !open)}>终端日志</button>
      <select aria-label="会话" value={selected} onChange={event => selectConnection(event.target.value)}>
        <option value="">{connections.length ? '请选择会话' : '尚无会话'}</option>
        {connections.map(connection => <option key={connection.connection_id} value={connection.connection_id}>{connection.protocol} · {connection.connection_id.slice(0, 8)} · 代次 {connection.generation}</option>)}
      </select>
      {service?.fixture && <><button disabled={busy || !!failure} onClick={() => void createFixture()}>新建合成会话</button><button disabled={busy || !selected || !!failure} onClick={() => void stress()}>高输出回放</button><button onClick={() => { stopped.current = true; }}>停止后续回放</button></>}
      <button onClick={() => void clipboard.current?.copy()}>复制选区</button>
      <button disabled={!selected} onClick={() => void clipboard.current?.paste()}>粘贴到终端</button>
      <button onClick={() => setSearchOpen(open => !open)}>查找终端</button>
      <details className="diagnostic-menu"><summary>诊断</summary><button onClick={capture}>屏幕快照</button><button disabled={!selected} onClick={() => void captureServiceScreen()}>服务端屏幕</button></details>
      <button onClick={() => setAppearanceOpen(open => !open)}>外观</button>
      <button onClick={() => void getCurrentWindow().close()}>退出桌面</button>
      <label>字号 <input aria-label="字号" disabled={preferencesBusy} type="number" min="10" max="28" value={fontSize} onChange={event => setFontSize(Math.max(10, Math.min(28, Number(event.target.value) || 15)))} /></label>
    </nav>
    <div className={`desktop-body${sidebarOpen ? '' : ' sidebar-hidden'}`}>
    <aside className="session-sidebar" aria-label="会话导航"><SessionTree revision={treeRevision} connect={profile => void connectProfile(profile)} configure={() => setConfigurationOpen(true)} /><label>导航宽度<input aria-label="导航宽度" type="range" min="210" max="360" value={navigationWidth} onChange={event => setNavigationWidth(Number(event.target.value))} /></label></aside>
    <section className="terminal-workspace" aria-label="终端工作区">
    <div className="tab-tools"><div role="tablist" aria-label="连接标签" ref={tabList}>{tabs.map(connection => <div className="connection-tab" key={connection.connection_id}><button role="tab" data-connection-id={connection.connection_id} tabIndex={selected === connection.connection_id ? 0 : -1} onKeyDown={event => {
      const index = tabs.findIndex(item => item.connection_id === connection.connection_id);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return; event.preventDefault(); selectConnection(tabs[next].connection_id);
      tabList.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    }} aria-selected={selected === connection.connection_id} title={`${tabName(connection)} · ${connection.protocol} · ${connection.state} · ${connection.connection_id} / ${connection.generation}`} onClick={() => selectConnection(connection.connection_id)}>{tabName(connection)}<small>{connection.state} · 代次 {connection.generation}</small></button><button aria-label={`关闭标签 ${connection.connection_id}`} onClick={() => { setTabMessage(''); setClosing(connection); }}>×</button></div>)}</div><button disabled={!selected || tabs[0]?.connection_id === selected} onClick={() => moveTab(-1)}>标签左移</button><button disabled={!selected || tabs.at(-1)?.connection_id === selected} onClick={() => moveTab(1)}>标签右移</button></div>
    {!tabs.length && <p className="terminal-empty">从会话树选择配置连接，或在上方打开 SSH2 / 串口面板。隐藏标签保留在“会话”完整列表中。</p>}
    <div className="terminal" ref={host} aria-label="服务终端" />
    <div className="status" role="status">{failure || inputFailure || status}</div>
    {decodeWarning && <div role="status" aria-label="接收解码提示">{decodeWarning}</div>}
    <div className="input-status">{active?.protocol === 'SSH2' ? 'SSH2 输入' : active?.protocol === 'SERIAL' ? '串口输入' : service?.fixture ? '合成键盘事件' : '尚无设备输入'}：<output>{lastInput}</output></div>
    {clipboardMessage && <div role="status" aria-label="剪贴板状态">{clipboardMessage}</div>}
    {tabMessage && <div role="status" aria-label="标签操作状态">{tabMessage}</div>}
    </section>
    <aside className="auxiliary-panels" aria-label="辅助工具">
    {exitConfirm && <section className="config-panel" aria-label="退出桌面确认"><h2>退出并停止会话服务</h2><p>尚有设备连接未结束。退出将停止全部连接与未发送输入，已执行动作不会撤销；没有后台驻留模式。</p><button autoFocus onClick={() => setExitConfirm(false)}>取消退出</button><button onClick={() => { allowExit.current = true; void getCurrentWindow().close(); }}>确认退出并停止服务</button></section>}
    {closing && <section className="config-panel" aria-label="关闭标签确认"><h2>关闭连接标签</h2><p>{tabName(closing)} · {closing.protocol} · {closing.connection_id} / 代次 {closing.generation}</p><p>关闭连接会停止未发送输入；已发送动作不会撤销。保留连接仅隐藏标签，输出仍由服务有界保留，之后可从完整列表重新打开。</p><button disabled={tabBusy} onClick={() => void confirmClose()}>关闭连接并隐藏标签</button><button disabled={tabBusy} onClick={() => { hideTab(closing); setClosing(undefined); }}>保留连接隐藏标签</button><button disabled={tabBusy} autoFocus onClick={() => setClosing(undefined)}>取消关闭标签</button></section>}
    {composeOpen && <ComposePanel key={`${selected}:${active?.generation}:${active?.state}:${composeEpoch}`} drafts={drafts.current} target={active} ready={!!active && active.state === 'CONNECTED' && renderedTarget?.connection_id === active.connection_id && renderedTarget.generation === active.generation && !failure && !inputFailure} send={(target, text) => composeSend.current?.(target, text) ?? false} close={() => setComposeOpen(false)} />}
    {appearanceOpen && <AppearancePanel theme={theme} font={terminalFont} setTheme={setTheme} setFont={setTerminalFont} preferences={preferences} busy={preferencesBusy} canSave={!!preferenceRevision} message={preferenceMessage} update={updatePreferences} save={() => void preferenceOperation(true)} read={() => void preferenceOperation(false)} close={() => setAppearanceOpen(false)} />}
    {configurationOpen && <ConfigPanel onRestored={async () => { preferenceEpoch.current++; preferenceFlight.current = false; await preferenceOperation(false); setTreeRevision(value => value + 1); }} close={() => { setConfigurationOpen(false); setTreeRevision(value => value + 1); }} />}
    {sshOpen && <SshPanel connection={connections.find(item => item.connection_id === selected)} select={selectConnection} size={() => dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24)} />}
    <ExecPanel open={execOpen} connection={connections.find(item => item.connection_id === selected)} />
    {serialOpen && <SerialPanel requestedProfile={requestedProfile?.settings.protocol === 'serial' ? requestedProfile.id : undefined} connection={active} select={selectConnection} />}
    {searchOpen && <TerminalSearch key={`${selected}:${connections.find(item => item.connection_id === selected)?.generation}`} terminal={() => runtime.current?.term} close={() => setSearchOpen(false)} />}
    {pasteProposal && <section className="config-panel" aria-label="粘贴确认">
      <h2>确认粘贴到终端</h2>
      <small>目标 {pasteProposal.target.protocol} · {pasteProposal.target.connection_id} / 代次 {pasteProposal.target.generation}</small>
      <p>内容可能执行多条命令。CR/LF按原样发送，不自动添加换行；{pasteProposal.bracketed ? '使用终端请求的括号粘贴模式，不能保证远端安全。' : '当前未启用括号粘贴模式。'}继续键盘输入或切换目标会取消此预览。</p>
      <small>{pasteProposal.text.length} 个UTF-16单元 · CR {pasteProposal.text.split('\r').length - 1} · LF {pasteProposal.text.split('\n').length - 1} · 转义预览（最多8192个单元）</small>
      <pre aria-label="粘贴内容预览">{visibleControls(JSON.stringify(pasteProposal.text.slice(0,8192)))}{pasteProposal.text.length > 8192 && ' …预览已截断'}</pre>
      <div className="config-actions"><button onClick={() => clipboard.current?.confirm(pasteProposal)}>确认发送粘贴</button><button autoFocus onClick={() => { clipboard.current?.invalidate(); setClipboardMessage('已取消粘贴；未发送'); runtime.current?.term.focus(); }}>取消粘贴</button></div>
    </section>}
    <LoggingPanel connection={connections.find(item=>item.connection_id===selected)} open={loggingOpen} close={()=>setLoggingOpen(false)} />
    {snapshot && <section className="config-panel"><button onClick={() => setSnapshot('')}>关闭屏幕快照</button><pre aria-label="屏幕快照">{snapshot}</pre></section>}
    {serviceScreen && <details open><summary>服务端屏幕快照</summary><button onClick={() => setServiceScreen(undefined)}>关闭服务端快照</button><small>{serviceScreen.connection.connection_id} / {serviceScreen.connection.generation} · {serviceScreen.encoding} · {serviceScreen.rows}×{serviceScreen.cols} · 来源游标 {serviceScreen.source_cursor} · {serviceScreen.parser} · {serviceScreen.resize_reflow ? '普通屏支持重排；复杂调整可能与桌面不同' : '宽度变化不重排，可能与桌面显示不同'} · 接收缺口 {serviceScreen.gap_bytes} 字节 · 解码错误事件 {serviceScreen.decode_error_events}{serviceScreen.contents_truncated && ' · 快照文本已截断'}{serviceScreen.completed && ' · 输出已结束'}</small><pre aria-label="服务端屏幕快照">{serviceScreen.contents || '空屏幕'}</pre></details>}
    </aside></div>
    <footer>{active && <span>{tabName(active)} · {active.protocol} · {active.state} · {active.connection_id} / {active.generation} · </span>}{service && <span>服务 {service.service_id} · </span>}关闭桌面将停止服务 · 重载页面保留服务会话 · 未完成 SSH/串口验收</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
