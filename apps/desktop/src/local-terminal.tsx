import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {terminalAppearance} from './appearance';
import type {DesktopPreferences} from './config-api';
import {AdbDeviceDialog, type AdbChoice, type AdbIntent} from './local-adb';

export type LocalView = {cwd:string; task:string|null; running:boolean; bytes:number[]; overflow:boolean; message:string|null; command:string|null};
export type LocalTab = {id:string; title:string; initial:LocalView};
export function terminalAction<T = void>(action: {kind:string; id?:string} & Record<string, unknown>) {
  return invoke<T>('local_terminal', {action});
}

const MAX_HISTORY = 100;
const MAX_SCROLLBACK = 5000;
const localText = (text:string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '�').replaceAll('\n', '\r\n');

export type LocalPromptState = {busy:boolean; hasDraft:boolean};
export function LocalTerminal({tab, visible, focused, preferences, intent, report, focus, shortcutSettled}: {
  tab:LocalTab; visible:boolean; focused:boolean; preferences:DesktopPreferences; intent?:AdbIntent;
  report(id:string, state:LocalPromptState):void; focus():void;
  shortcutSettled(request:string):void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);
  const view = useRef(tab.initial);
  const flight = useRef(false);
  const uncertain = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const alive = useRef(false);
  const sentSize = useRef('');
  const history = useRef<string[]>([]);
  const historyAt = useRef(-1);
  const originalDraft = useRef('');
  const intentSeen = useRef('');
  const launchingShortcut = useRef(false);
  const [working, setWorking] = useState(false);
  const [cwd, setCwd] = useState(tab.initial.cwd);
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState('');
  const [atLimit, setAtLimit] = useState(false);
  const [choice, setChoice] = useState<{intent:AdbIntent; devices:AdbChoice['devices']}>();
  const latest = useRef({visible, focused, report});
  latest.current = {visible, focused, report};

  function update(next:LocalView) {
    if (!alive.current) return;
    const terminal = term.current;
    if (next.command) terminal?.writeln(localText(next.cwd + '> ' + next.command));
    if (next.overflow) {
      terminal?.reset();
      terminal?.writeln('输出积压，已略过部分历史');
    }
    if (next.bytes.length) terminal?.write(Uint8Array.from(next.bytes));
    if (next.message) terminal?.write('\r\n\x1b[0m' + localText(next.message) + '\r\n', () => {
      if (latest.current.focused && !view.current.running && document.activeElement === document.body) field.current?.focus();
    });
    const changed = view.current.running !== next.running;
    view.current = next;
    setCwd(next.cwd);
    setWorking(next.running);
    if (changed && latest.current.focused && next.running) terminal?.focus();
  }

  async function run(line:string, request:string) {
    if (!line.trim() || view.current.running || flight.current || uncertain.current) return;
    flight.current = true;
    latest.current.report(tab.id, {busy:true, hasDraft:false});
    setWorking(true);
    setFailure('');
    term.current?.writeln(localText(view.current.cwd + '> ' + line));
    try {
      const next = await terminalAction<LocalView>({kind:'run', id:tab.id, request, line});
      update(next);
    } catch {
      if (!alive.current) return;
      uncertain.current = request;
      setFailure('启动回执待核对。仅检查本标签的原请求。');
    } finally {
      flight.current = false;
    }
  }

  async function launchShortcut(next:AdbIntent, target?:string) {
    if (launchingShortcut.current) return;
    launchingShortcut.current = true;
    setChoice(undefined);
    try {
      const result = await terminalAction<LocalView>({kind:'run_adb', id:tab.id, request:next.request, target:target??null});
      update(result);
    } catch {
      if (!alive.current) return;
      uncertain.current = next.request;
      setFailure('ADB 启动回执待核对。仅检查本标签的原请求。');
    } finally {
      flight.current = false;
      launchingShortcut.current = false;
      shortcutSettled(next.request);
    }
  }

  async function prepareShortcut(next:AdbIntent) {
    if (view.current.running || flight.current || composing.current || draft) {
      setFailure('原标签已有输入或前台任务，本次快捷操作未启动');
      shortcutSettled(next.request);
      return;
    }
    flight.current = true;
    setWorking(true);
    setFailure('');
    try {
      const result = await invoke<AdbChoice>('prepare_local_adb', {id:tab.id, ...next});
      if (!alive.current) return;
      if (result.inherited_target) term.current?.writeln(localText('ANDROID_SERIAL：'+result.inherited_target));
      const available = result.devices.filter(device=>device.state==='device');
      if (result.select && available.length > 1) {
        setChoice({intent:next, devices:result.devices});
      } else {
        await launchShortcut(next, available[0]?.serial);
      }
    } catch(error) {
      if (alive.current) {
        setFailure(String(error));
        setWorking(false);
        flight.current = false;
      }
      shortcutSettled(next.request);
    }
  }

  function cancelShortcut(next:AdbIntent) {
    setChoice(undefined);
    void terminalAction({kind:'cancel_adb', id:tab.id, request:next.request}).catch(error=>setFailure(String(error)))
      .finally(()=>{flight.current=false;setWorking(false);shortcutSettled(next.request);});
  }

  useEffect(() => {
    alive.current = true;
    const terminal = new Terminal({...terminalAppearance(), scrollback:MAX_SCROLLBACK, cursorBlink:true});
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(host.current!);
    term.current = terminal;
    fit.current = addon;
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        const text = terminal.getSelection();
        if (text) void navigator.clipboard.writeText(text).catch(() => setFailure('复制失败'));
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        const task = view.current.running ? view.current.task : null;
        if (task) void navigator.clipboard.readText().then(text => {
          if (alive.current && latest.current.focused && view.current.running && view.current.task === task) terminal.paste(text);
        }).catch(() => setFailure('读取剪贴板失败'));
        return false;
      }
      return true;
    });
    const data = terminal.onData(text => {
      const task = view.current.running ? view.current.task : null;
      if (task && latest.current.focused) void terminalAction({kind:'input', id:tab.id, request:task, text})
        .catch(error => {if(alive.current) setFailure(String(error));});
    });
    const written = terminal.onWriteParsed(() => {
      if (terminal.buffer.normal.baseY >= MAX_SCROLLBACK) setAtLimit(true);
    });
    function resize() {
      if (!latest.current.visible || !host.current?.clientHeight) return;
      addon.fit();
      const {cols, rows} = terminal;
      const size = cols + ':' + rows;
      if (sentSize.current === size) return;
      sentSize.current = size;
      void terminalAction({kind:'resize', id:tab.id, cols, rows}).catch(() => {});
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    let timer:number;
    async function poll() {
      try {
        if (!flight.current && (view.current.running || uncertain.current)) {
          flight.current = true;
          try {
            const next = await terminalAction<LocalView>({kind:'poll', id:tab.id});
            if (uncertain.current) {
              setFailure(next.task === uncertain.current ? '' : '原请求未出现在终端状态中，请核对后再提交。');
              uncertain.current = undefined;
            }
            update(next);
          } finally {
            flight.current = false;
          }
        }
      } catch {
        if (alive.current) setFailure('本地进程状态读取失败');
      } finally {
        if (alive.current) timer = window.setTimeout(poll, 20);
      }
    }
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
      observer.disconnect();
      data.dispose();
      written.dispose();
      terminal.dispose();
      term.current = undefined;
      fit.current = undefined;
    };
  }, [tab.id]);

  useLayoutEffect(() => {
    if (term.current) {
      Object.assign(term.current.options, terminalAppearance(), {fontSize:preferences.font_size});
      if (visible) fit.current?.fit();
    }
  }, [preferences, visible]);
  useEffect(() => {
    if (!focused) return;
    if (working) term.current?.focus();
    else field.current?.focus();
  }, [focused, working]);
  useEffect(() => {
    report(tab.id, {busy:working, hasDraft:draft.length > 0 || composing.current});
  }, [working, draft, tab.id, report]);
  useEffect(() => {
    if (!intent || intent.request === intentSeen.current) return;
    intentSeen.current = intent.request;
    void prepareShortcut(intent);
  }, [intent]);

  function submit() {
    if (!draft.trim() || composing.current || flight.current || working) return;
    history.current.push(draft);
    if (history.current.length > MAX_HISTORY) history.current.shift();
    historyAt.current = -1;
    setDraft('');
    void run(draft, crypto.randomUUID());
  }

  return <div className="local-terminal" hidden={!visible} onFocusCapture={focus}>
    <div className="terminal local-terminal-output" ref={host} aria-label="本地命令行输出"/>
    {atLimit&&<small>仅保留最近 {MAX_SCROLLBACK} 行滚动历史及当前屏幕</small>}
    {failure&&<small role="alert">{failure}</small>}
    {choice&&<AdbDeviceDialog devices={choice.devices} choose={serial=>void launchShortcut(choice.intent,serial)}
      close={()=>cancelShortcut(choice.intent)}/>}
    {working
      ? <small className="local-prompt" aria-label="当前 Windows 工作目录">{cwd} · 前台进程运行中</small>
      : <form className="local-prompt" onSubmit={event=>{event.preventDefault();submit();}}>
        <span title={cwd}>{cwd}&gt;</span>
        <input ref={field} aria-label="本地命令输入" value={draft} maxLength={8192} spellCheck={false} autoComplete="off"
          onChange={event=>setDraft(event.target.value)}
          onPaste={event=>{
            if (/[\r\n]/.test(event.clipboardData.getData('text'))) {
              event.preventDefault();
              setFailure('本地提示符每次接受一条命令，请分别粘贴和提交');
            }
          }}
          onCompositionStart={()=>{composing.current=true;report(tab.id,{busy:false,hasDraft:true});}}
          onCompositionEnd={()=>{composing.current=false;report(tab.id,{busy:false,hasDraft:!!field.current?.value});}}
          onKeyDown={event=>{
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') {event.preventDefault();submit();return;}
            if (event.ctrlKey && event.key.toLowerCase() === 'c' && field.current?.selectionStart === field.current?.selectionEnd) {
              event.preventDefault();setDraft('');historyAt.current=-1;term.current?.writeln('^C');return;
            }
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            if (!history.current.length) return;
            event.preventDefault();
            if (historyAt.current < 0) {
              originalDraft.current = draft;
              historyAt.current = history.current.length;
            }
            historyAt.current = Math.min(history.current.length, Math.max(0, historyAt.current + (event.key === 'ArrowUp' ? -1 : 1)));
            setDraft(history.current[historyAt.current] ?? originalDraft.current);
          }}/>
      </form>}
  </div>;
}
