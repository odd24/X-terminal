import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {terminalAppearance} from './appearance';
import type {DesktopPreferences} from './config-api';
import {AdbDeviceDialog, type AdbChoice, type AdbDiagnostic, type AdbIntent} from './local-adb';

export type LocalView = {cwd:string; startup_warning:string|null; task:string|null; running:boolean; bytes:number[]; overflow:boolean;
  message:string|null; command:string|null; exit_code:number|null; script:string|null; script_directory:string|null};
export type LocalTab = {id:string; title:string; initial:LocalView; powershell:boolean};
export type LocalPromptState = {busy:boolean; hasDraft:boolean};
export function terminalAction<T = void>(action: {kind:string; id?:string} & Record<string, unknown>) {
  return invoke<T>('local_terminal', {action});
}

const MAX_HISTORY = 100;
const MAX_SCROLLBACK = 5000;
const localText = (text:string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '�').replaceAll('\n', '\r\n');
const cells = (text:string) => Array.from(text).reduce((count, character)=>
  count + (/\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}|[\uFF01-\uFF60]/u.test(character)?2:1),0);

export function LocalTerminal({tab, visible, focused, preferences, intent, report, focus, shortcutSettled, onDiagnostic}: {
  tab:LocalTab; visible:boolean; focused:boolean; preferences:DesktopPreferences; intent?:AdbIntent;
  report(id:string, state:LocalPromptState):void; focus():void; shortcutSettled(request:string):void;
  onDiagnostic(intent:AdbIntent, diagnostic:AdbDiagnostic):void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);
  const view = useRef(tab.initial);
  const flight = useRef(false);
  const uncertain = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const alive = useRef(false);
  const sentSize = useRef('');
  const line = useRef({text:'', cursor:0});
  const history = useRef<string[]>([]);
  const historyAt = useRef(-1);
  const originalDraft = useRef('');
  const intentSeen = useRef('');
  const launchingShortcut = useRef(false);
  const lastDiagnostic = useRef<{intent:AdbIntent; diagnostic:AdbDiagnostic}|undefined>(undefined);
  const input = useRef({tail:Promise.resolve(), queued:0});
  const [failure, setFailure] = useState('');
  const [atLimit, setAtLimit] = useState(false);
  const [choice, setChoice] = useState<{intent:AdbIntent; devices:AdbChoice['devices']}>();
  const [running, setRunning] = useState(tab.initial.running);
  const [cwd, setCwd] = useState(tab.initial.cwd);
  const latest = useRef({visible, focused, report, onDiagnostic});
  latest.current = {visible, focused, report, onDiagnostic};

  function publish() {
    latest.current.report(tab.id,{busy:tab.powershell||view.current.running||flight.current||!!uncertain.current,
      hasDraft:!!line.current.text||composing.current});
  }

  function redraw() {
    const terminal = term.current;
    if (!terminal || view.current.running || uncertain.current) return;
    const {text,cursor} = line.current;
    const chars = Array.from(text);
    const cwd = Array.from(view.current.cwd);
    const width = Math.max(4, terminal.cols-1);
    const pathWidth = Math.max(1, Math.min(Math.floor(width/2),width-4));
    let startPath=cwd.length, usedPath=0;
    while(startPath>0 && usedPath+cells(cwd[startPath-1])<=pathWidth)usedPath+=cells(cwd[--startPath]);
    const prompt = (startPath?'…':'')+cwd.slice(startPath).join('')+'> ';
    const available = Math.max(1,width-cells(prompt));
    let start=cursor, end=cursor, used=0;
    while(start>0 && used+cells(chars[start-1])<=available) used+=cells(chars[--start]);
    while(end<chars.length && used+cells(chars[end])<=available) used+=cells(chars[end++]);
    const after = cells(chars.slice(cursor,end).join(''));
    terminal.write('\r\x1b[2K'+localText(prompt+chars.slice(start,end).join(''))+(after?'\x1b['+after+'D':''));
  }

  function update(next:LocalView) {
    if (!alive.current) return;
    const terminal = term.current;
    if (next.command) terminal?.writeln('\r\x1b[2K'+localText(next.cwd+' > '+next.command));
    if (next.overflow) {
      terminal?.reset();
      terminal?.writeln('输出积压，已略过部分历史');
    }
    if (next.bytes.length) terminal?.write(Uint8Array.from(next.bytes));
    if (next.message) terminal?.write('\r\n\x1b[0m'+localText(next.message)+'\r\n');
    const diagnostic=lastDiagnostic.current;
    if(diagnostic && (next.exit_code!==null||next.command&&!next.running)) {
      if(next.message && next.exit_code!==0) latest.current.onDiagnostic(diagnostic.intent,{...diagnostic.diagnostic,error:next.message});
      lastDiagnostic.current=undefined;
    }
    view.current = next;
    setRunning(next.running);
    setCwd(next.cwd);
    publish();
    if(!next.running)redraw();
  }

  async function run(command:string) {
    if(!command.trim()||flight.current||uncertain.current)return;
    const request=crypto.randomUUID();
    flight.current=true;
    setFailure('');
    publish();
    term.current?.writeln('\r\x1b[2K'+localText(view.current.cwd+' > '+command));
    try {
      update(await terminalAction<LocalView>({kind:'run',id:tab.id,request,line:command}));
    } catch {
      if(alive.current){
        uncertain.current=request;
        setFailure('启动回执待核对。仅检查本标签的原请求。');
      }
    } finally {
      flight.current=false;
      publish();
    }
  }

  async function launchShortcut(next:AdbIntent, target?:string) {
    if(launchingShortcut.current)return;
    launchingShortcut.current=true;
    setChoice(undefined);
    if(latest.current.focused)term.current?.focus();
    try {
      update(await terminalAction<LocalView>({kind:'run_adb',id:tab.id,request:next.request,target:target??null}));
    } catch {
      if(alive.current){
        uncertain.current=next.request;
        setFailure('ADB 启动回执待核对。仅检查本标签的原请求。');
      }
    } finally {
      flight.current=false;
      launchingShortcut.current=false;
      publish();
      shortcutSettled(next.request);
    }
  }

  async function prepareShortcut(next:AdbIntent) {
    if(view.current.running||flight.current||composing.current||line.current.text){
      setFailure('原标签已有输入或前台任务，本次快捷操作未启动');
      shortcutSettled(next.request);
      return;
    }
    flight.current=true;
    publish();
    setFailure('');
    try {
      const result=await invoke<AdbChoice>('prepare_local_adb',{id:tab.id,...next});
      if(!alive.current)return;
      latest.current.onDiagnostic(next,result.diagnostic);
      if(result.diagnostic.error)throw result.diagnostic.error;
      lastDiagnostic.current={intent:next,diagnostic:result.diagnostic};
      if(result.inherited_target)term.current?.writeln(localText('ANDROID_SERIAL：'+result.inherited_target));
      const available=result.devices.filter(device=>device.state==='device');
      if(result.select&&available.length>1)setChoice({intent:next,devices:result.devices});
      else await launchShortcut(next,available[0]?.serial);
    } catch(error) {
      if(alive.current){
        setFailure(String(error));
        flight.current=false;
        publish();
        if(latest.current.focused)term.current?.focus();
      }
      shortcutSettled(next.request);
    }
  }

  function cancelShortcut(next:AdbIntent) {
    setChoice(undefined);
    lastDiagnostic.current=undefined;
    void terminalAction({kind:'cancel_adb',id:tab.id,request:next.request}).catch(error=>setFailure(String(error)))
      .finally(()=>{
        flight.current=false;
        publish();
        shortcutSettled(next.request);
        if(latest.current.focused)term.current?.focus();
      });
  }

  function edit(data:string) {
    if(flight.current||uncertain.current)return;
    const chars=Array.from(line.current.text);
    let {cursor}=line.current;
    if(data==='\r'){
      const command=line.current.text;
      if(!command.trim()) {line.current={text:'',cursor:0};redraw();publish();return;}
      history.current.push(command);
      if(history.current.length>MAX_HISTORY)history.current.shift();
      historyAt.current=-1;
      line.current={text:'',cursor:0};
      void run(command);
      return;
    }
    if(data==='\x03'){
      line.current={text:'',cursor:0};
      historyAt.current=-1;
      term.current?.writeln('\r\x1b[2K^C');
    }else if (data==='\x1b[A'||data==='\x1b[B'){
      if(!history.current.length)return;
      if(historyAt.current<0){originalDraft.current=line.current.text;historyAt.current=history.current.length;}
      historyAt.current=Math.min(history.current.length,Math.max(0,historyAt.current+(data==='\x1b[A'?-1:1)));
      const text=history.current[historyAt.current]??originalDraft.current;
      line.current={text,cursor:Array.from(text).length};
    }else{
      if(data==='\x7f'||data==='\b'){
        if(cursor>0)chars.splice(--cursor,1);
      }else if(data==='\x1b[3~')chars.splice(cursor,1);
      else if(data==='\x1b[D')cursor=Math.max(0,cursor-1);
      else if(data==='\x1b[C')cursor=Math.min(chars.length,cursor+1);
      else if(data==='\x1b[H')cursor=0;
      else if(data==='\x1b[F')cursor=chars.length;
      else if(!/[\x00-\x1f\x7f]/.test(data)){
        if(new TextEncoder().encode(line.current.text+data).length>8192){setFailure('轻量命令最多接受 8192 字节');return;}
        chars.splice(cursor,0,...Array.from(data));
        cursor+=Array.from(data).length;
      }else return;
      line.current={text:chars.join(''),cursor};
    }
    publish();
    redraw();
  }

  useEffect(()=>{
    alive.current=true;
    const terminal=new Terminal({...terminalAppearance(),scrollback:MAX_SCROLLBACK,cursorBlink:true});
    const addon=new FitAddon();
    const node=host.current!;
    terminal.loadAddon(addon);
    terminal.open(node);
    terminal.textarea?.setAttribute('aria-label','本地终端输入');
    term.current=terminal;
    fit.current=addon;
    function paste(text:string) {
      if(!view.current.running && /[\r\n]/.test(text)){
        setFailure('轻量模式每次只接受一行');
        return;
      }
      terminal.paste(text);
    }
    terminal.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown')return true;
      if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='c'){
        const text=terminal.getSelection();
        if(text)void navigator.clipboard.writeText(text).catch(()=>setFailure('复制失败'));
        return false;
      }
      if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='v'){
        const task=view.current.task;
        void navigator.clipboard.readText().then(text=>{
          if(alive.current&&latest.current.focused&&view.current.task===task)paste(text);
        }).catch(()=>setFailure('读取剪贴板失败'));
        return false;
      }
      return true;
    });
    const data=terminal.onData(text=>{
      if(!latest.current.focused)return;
      const task=view.current.running?view.current.task:null;
      if(!task){edit(text);return;}
      const queue=input.current;
      if(queue.queued>=32){setFailure('本地终端输入队列已满');return;}
      queue.queued++;
      queue.tail=queue.tail.then(async()=>{
        if(alive.current&&view.current.running&&view.current.task===task)
          await terminalAction({kind:'input',id:tab.id,request:task,text});
      }).catch(error=>{if(alive.current)setFailure(String(error));}).finally(()=>{queue.queued--;});
    });
    const written=terminal.onWriteParsed(()=>{
      if(terminal.buffer.normal.baseY>=MAX_SCROLLBACK)setAtLimit(true);
    });
    const compositionStart=()=>{composing.current=true;publish();};
    const compositionEnd=()=>{composing.current=false;publish();};
    const nativePaste=(event:ClipboardEvent)=>{
      if(!view.current.running&&/[\r\n]/.test(event.clipboardData?.getData('text')??'')){
        event.preventDefault();event.stopPropagation();setFailure('轻量模式每次只接受一行');
      }
    };
    node.addEventListener('compositionstart',compositionStart,true);
    node.addEventListener('compositionend',compositionEnd,true);
    node.addEventListener('paste',nativePaste,true);
    function resize(){
      if(!latest.current.visible||!host.current?.clientHeight)return;
      addon.fit();
      redraw();
      const {cols,rows}=terminal;
      const size=cols+':'+rows;
      if(sentSize.current!==size){
        sentSize.current=size;
        void terminalAction({kind:'resize',id:tab.id,cols,rows}).catch(()=>{});
      }
    }
    const observer=new ResizeObserver(resize);
    observer.observe(node);
    update(tab.initial);
    let timer:number;
    async function poll(){
      try{
        if(!flight.current&&(view.current.running||uncertain.current)){
          flight.current=true;
          try{
            const next=await terminalAction<LocalView>({kind:'poll',id:tab.id});
            if(uncertain.current){
              setFailure(next.task===uncertain.current?'':'原请求未出现在终端状态中，请核对后再提交。');
              uncertain.current=undefined;
            }
            update(next);
          }finally{flight.current=false;publish();}
        }
      }catch{if(alive.current)setFailure('本地进程状态读取失败');}
      finally{if(alive.current)timer=window.setTimeout(poll,20);}
    }
    void poll();
    return ()=>{
      alive.current=false;
      clearTimeout(timer);
      observer.disconnect();
      node.removeEventListener('compositionstart',compositionStart,true);
      node.removeEventListener('compositionend',compositionEnd,true);
      node.removeEventListener('paste',nativePaste,true);
      data.dispose();written.dispose();terminal.dispose();term.current=undefined;fit.current=undefined;
    };
  },[tab.id]);

  useLayoutEffect(()=>{
    if(term.current){
      Object.assign(term.current.options,terminalAppearance(),{fontSize:preferences.font_size});
      if(visible){fit.current?.fit();redraw();}
    }
  },[preferences,visible]);
  useEffect(()=>{if(focused)term.current?.focus();},[focused]);
  useEffect(()=>{
    if(!intent||intent.request===intentSeen.current)return;
    intentSeen.current=intent.request;
    void prepareShortcut(intent);
  },[intent]);

  return <div className="local-terminal" hidden={!visible} data-mode={tab.powershell?'powershell':'lightweight'} data-foreground={running} onFocusCapture={focus}>
    {tab.initial.startup_warning&&<small className="local-directory-warning" role="alert">{tab.initial.startup_warning}</small>}
    {tab.initial.script&&<div className="adb-panel-heading local-script-info">
      <span title={tab.initial.script_directory??undefined}>{tab.initial.script} · {tab.initial.script_directory}</span>
      <button type="button" onClick={()=>void terminalAction({kind:'open_script_directory',id:tab.id}).catch(error=>setFailure(String(error)))}>打开工作目录</button>
    </div>}
    <div className="terminal local-terminal-output" ref={host} aria-label="本地命令行输出" title={!tab.powershell?cwd:undefined}/>
    {atLimit&&<small>仅保留最近 {MAX_SCROLLBACK} 行滚动历史及当前屏幕</small>}
    {failure&&<small role="alert">{failure}</small>}
    {choice&&<AdbDeviceDialog devices={choice.devices} choose={serial=>void launchShortcut(choice.intent,serial)} close={()=>cancelShortcut(choice.intent)}/>}
  </div>;
}
