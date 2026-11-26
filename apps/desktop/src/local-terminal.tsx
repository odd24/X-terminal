import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {terminalAppearance} from './appearance';
import type {DesktopPreferences} from './config-api';
import {AdbDeviceDialog, type AdbChoice, type AdbDiagnostic, type AdbIntent} from './local-adb';
import {ContextMenu,Dialog,Panel} from './ui';
import {preparePaste,type PasteProposal} from './terminal-clipboard';
import {visibleControls} from './log-search';
import type {LocalRightClick} from './local-right-click';
import {lightweightDrop, type FileDropRoute} from './local-file-drop';

export type LocalView = {cwd:string; startup_warning:string|null; task:string|null; running:boolean; bytes:number[]|Uint8Array; overflow:boolean;
  message:string|null; command:string|null; exit_code:number|null; script:string|null; script_directory:string|null; close_after_result?:boolean};
export type LocalTab = {id:string; title:string; initial:LocalView; powershell:boolean; origin:'ordinary'|'adb-result'|'script'};
export type LocalPromptState = {busy:boolean; hasDraft:boolean};
export function terminalAction<T = void>(action: {kind:string; id?:string} & Record<string, unknown>) {
  return invoke<T>('local_terminal', {action});
}

const MAX_HISTORY = 100;
const MAX_SCROLLBACK = 5000;
const MAX_LIGHTWEIGHT_LINE=8192;
type ClipboardTarget={route:number;task:string|null;bracketed:boolean;revision:number};
type LocalPaste={target:ClipboardTarget;proposal:PasteProposal;editorEpoch?:number;unsupported?:string};
const outputMetadata=new TextDecoder('utf-8',{fatal:true});
const localText = (text:string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '�').replaceAll('\n', '\r\n');
const cells = (text:string) => Array.from(text).reduce((count, character)=>
  count + (/\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}|[\uFF01-\uFF60]/u.test(character)?2:1),0);

export function LocalTerminal({tab, visible, focused, preferences, intent, report, focus, register, shortcutSettled, onDiagnostic,onResultSuccess,rightClick,routeEpoch,clipboardRoute,fileDropRoutes,fileDropRoute}: {
  tab:LocalTab; visible:boolean; focused:boolean; preferences:DesktopPreferences; intent?:AdbIntent;
  report(id:string, state:LocalPromptState):void; focus():void; shortcutSettled(request:string):void;
  register(id:string,terminal?:Terminal):void;
  onDiagnostic(intent:AdbIntent, diagnostic:AdbDiagnostic):void;
  onResultSuccess(id:string):void;
  rightClick?:LocalRightClick; routeEpoch:number; clipboardRoute():number|undefined;
  fileDropRoutes:Map<HTMLElement,FileDropRoute>; fileDropRoute():number|undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const fitVisible = useRef<()=>void>(()=>{});
  const view = useRef(tab.initial);
  const flight = useRef(false);
  const uncertain = useRef<string | undefined>(undefined);
  const armOutput = useRef<()=>void>(()=>{});
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
  const clipboardRevision=useRef(0);
  const dropRevision=useRef(0);
  const shellEdit=useRef<{task:string; generation:number}|undefined>(undefined);
  const selectionRevision=useRef(0);
  const pendingPaste=useRef<LocalPaste>(undefined);
  const [pastePreview,setPastePreview]=useState<LocalPaste>();
  const [clipboardMenu,setClipboardMenu]=useState<{target:ClipboardTarget;x:number;y:number;anchor:HTMLElement;selection:string}>();
  const [failure, setFailure] = useState('');
  const [clipboardStatus,setClipboardStatus]=useState('');
  const [atLimit, setAtLimit] = useState(false);
  const [choice, setChoice] = useState<{intent:AdbIntent; devices:AdbChoice['devices']}>();
  const [running, setRunning] = useState(tab.initial.running);
  const [cwd, setCwd] = useState(tab.initial.cwd);
  const latest = useRef({visible, focused, report, onDiagnostic,onResultSuccess,focus,rightClick,clipboardRoute,fileDropRoute});
  latest.current = {visible, focused, report, onDiagnostic,onResultSuccess,focus,rightClick,clipboardRoute,fileDropRoute};

  function invalidateClipboard(){
    clipboardRevision.current++;
    pendingPaste.current=undefined;
    setPastePreview(undefined);
    setClipboardMenu(undefined);
  }
  function clipboardTarget():ClipboardTarget|undefined{
    const route=latest.current.clipboardRoute(), current=view.current;
    if(!alive.current||route===undefined||flight.current||uncertain.current||composing.current
      ||current.running&&!current.task)return;
    return {route,task:current.running?current.task:null,
      bracketed:current.running&&!!term.current?.modes.bracketedPasteMode,revision:clipboardRevision.current};
  }
  function clipboardCurrent(target:ClipboardTarget){
    const current=clipboardTarget();
    return current?.route===target.route&&current.task===target.task&&current.bracketed===target.bracketed&&current.revision===target.revision;
  }
  async function copySelection(clear:boolean){
    const terminal=term.current;
    const text=terminal?.getSelection(),route=latest.current.clipboardRoute(),version=selectionRevision.current;
    if(!terminal||!text||route===undefined)return;
    invalidateClipboard();
    setClipboardStatus('');
    try{
      await navigator.clipboard.writeText(text);
      if(clear&&alive.current&&term.current===terminal&&route===latest.current.clipboardRoute()
        &&selectionRevision.current===version&&terminal.getSelection()===text){
        terminal.clearSelection();
        terminal.focus();
      }
    }catch {
      if(alive.current&&route===latest.current.clipboardRoute())setClipboardStatus('复制失败，选区已保留。');
    }
  }
  function queueInput(task:string,send:()=>Promise<void>,guard?:()=>boolean){
    const queue=input.current;
    if(queue.queued>=32){setFailure('本地终端输入队列已满');return;}
    queue.queued++;
    queue.tail=queue.tail.then(async()=>{
      if(alive.current&&view.current.running&&view.current.task===task&&(!guard||guard()))
        await send();
    }).catch(error=>{if(alive.current)setFailure(String(error));}).finally(()=>{queue.queued--;});
  }
  function enqueue(text:string,task:string,guard?:()=>boolean,keyboard=false){
    queueInput(task,()=>terminalAction({kind:'input',id:tab.id,request:task,text,keyboard}),guard);
  }
  function dropIdentity(){
    const route=latest.current.fileDropRoute();
    const current=view.current, editor=shellEdit.current;
    if(!alive.current||!latest.current.visible||route===undefined||flight.current||uncertain.current||composing.current
      ||tab.origin!=='ordinary')return;
    if(tab.powershell){
      if(!current.running||!editor||editor.task!==current.task)return;
      return route+':'+editor.task+':'+editor.generation;
    }
    if(!current.running)return route+':'+dropRevision.current;
  }
  function insertDrop(paths:string[],identity:string){
    if(dropIdentity()!==identity)return;
    invalidateClipboard();
    const editor=shellEdit.current;
    if(tab.powershell&&editor){
      const {task,generation}=editor;
      queueInput(task,()=>terminalAction({kind:'file_drop',id:tab.id,request:task,generation,paths}),
        ()=>dropIdentity()===identity);
      return;
    }
    const {text,cursor}=line.current;
    const insertion=lightweightDrop(paths,text,cursor);
    if(insertion===undefined){setFailure('当前光标在引号内，无法插入独立路径参数');return;}
    edit(insertion);
  }
  function sendPaste(item:LocalPaste){
    if(!clipboardCurrent(item.target)||item.unsupported)return;
    const {text,payload}=item.proposal;
    if(item.target.task){
      // Confirming closes the preview. Route and task are checked again when input reaches the head of the queue.
      const {route,task,bracketed}=item.target;
      const current=()=>latest.current.clipboardRoute()===route
        &&!!term.current?.modes.bracketedPasteMode===bracketed;
      if(item.editorEpoch!==undefined){
        const generation=item.editorEpoch;
        const content=generation===0?payload:text.replace(/\r\n?/g,'\n');
        queueInput(task,()=>terminalAction({kind:'power_shell_paste',id:tab.id,request:task,generation,text:content}),current);
      }else{
        enqueue(payload,task,current);
      }
    }else {
      const lineText=text.replace(/(?:\r\n|\r|\n)$/,'');
      if(lineText)edit(lineText);
    }
    term.current?.focus();
  }
  async function pasteClipboard(text?:string){
    invalidateClipboard();
    const target=clipboardTarget();
    if(!target)return;
    setClipboardStatus('');
    try{
      const [value,editorEpoch]=await Promise.all([
        text??invoke<string>('terminal_clipboard_read'),
        tab.powershell&&target.task
          ?terminalAction<number|null>({kind:'power_shell_paste_epoch',id:tab.id,request:target.task}).catch(()=>null)
          :null,
      ]);
      if(!clipboardCurrent(target))return;
      const proposal=preparePaste(value,{protocol:'LOCAL',connection_id:tab.id,generation:0},target.revision,target.bracketed);
      const draftText=value.replace(/(?:\r\n|\r|\n)$/,'');
      let unsupported:string|undefined;
      if(!target.task){
        if(/[\x00-\x1f\x7f]/.test(draftText))unsupported='轻量命令行空闲时只接受一条命令。多行或控制字符请在前台进程中粘贴。';
        else if(new TextEncoder().encode(line.current.text+draftText).length>MAX_LIGHTWEIGHT_LINE)unsupported='轻量命令最多接受 8192 字节。';
      }else if(tab.powershell&&proposal.confirm){
        if(editorEpoch===null)unsupported='当前无法核对 PowerShell 粘贴目标。请等待提示符或前台应用就绪后重试。';
        else if(editorEpoch>0&&/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value))unsupported='PowerShell 编辑区只接受文本、换行和制表符。';
      }
      const item={target,proposal,unsupported,editorEpoch:proposal.confirm?editorEpoch??undefined:undefined};
      if(proposal.confirm){pendingPaste.current=item;setPastePreview(item);}
      else if(unsupported)setClipboardStatus(unsupported);
      else sendPaste(item);
    }catch(error){
      if(clipboardCurrent(target))setClipboardStatus(typeof error==='string'?error:error instanceof Error?error.message:'读取剪贴板失败。');
    }
  }
  function confirmPaste(item:LocalPaste){
    if(pendingPaste.current!==item)return;
    pendingPaste.current=undefined;
    setPastePreview(undefined);
    sendPaste(item);
  }

  function cancelPaste(){
    const item=pendingPaste.current;
    const restore=item&&clipboardCurrent(item.target);
    invalidateClipboard();
    if(restore)term.current?.focus();
  }

  function publish() {
    const starting=flight.current||!!uncertain.current;
    latest.current.report(tab.id,{busy:tab.powershell||view.current.running||starting,
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

  function update(next:LocalView, expectedTask=view.current.task) {
    if (!alive.current) return;
    const terminal = term.current;
    if (next.command) terminal?.writeln('\r\x1b[2K'+localText(next.cwd+' > '+next.command));
    if (next.overflow) {
      terminal?.reset();
      terminal?.writeln('输出积压，已略过部分历史');
    }
    if (next.bytes.length) terminal?.write(next.bytes instanceof Uint8Array?next.bytes:Uint8Array.from(next.bytes));
    if (next.message) terminal?.write('\r\n\x1b[0m'+localText(next.message)+'\r\n');
    const diagnostic=lastDiagnostic.current;
    if(diagnostic && (next.exit_code!==null||next.command&&!next.running)) {
      if(next.message && next.exit_code!==0) latest.current.onDiagnostic(diagnostic.intent,{...diagnostic.diagnostic,error:next.message});
      lastDiagnostic.current=undefined;
    }
    if(view.current.task!==next.task||view.current.running!==next.running){
      dropRevision.current++;
      shellEdit.current=undefined;
      invalidateClipboard();
    }
    view.current = next;
    setRunning(next.running);
    setCwd(next.cwd);
    publish();
    if(!next.running)redraw();
    if(next.close_after_result&&next.task&&next.task===expectedTask&&next.exit_code!==null&&!next.running)latest.current.onResultSuccess(tab.id);
  }

  async function run(command:string) {
    if(!command.trim()||flight.current||uncertain.current)return;
    const request=crypto.randomUUID();
    dropRevision.current++;
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
      armOutput.current();
    }
  }

  async function launchShortcut(next:AdbIntent, target?:string) {
    if(launchingShortcut.current)return;
    launchingShortcut.current=true;
    setChoice(undefined);
    if(latest.current.focused)term.current?.focus();
    try {
      update(await terminalAction<LocalView>({kind:'run_adb',id:tab.id,request:next.request,target:target??null}),next.request);
    } catch {
      if(alive.current){
        uncertain.current=next.request;
        setFailure('ADB 启动回执待核对。仅检查本标签的原请求。');
      }
    } finally {
      flight.current=false;
      launchingShortcut.current=false;
      publish();
      armOutput.current();
      shortcutSettled(next.request);
    }
  }

  async function prepareShortcut(next:AdbIntent) {
    if(view.current.running||flight.current||composing.current||line.current.text){
      setFailure('原标签已有输入或前台任务，本次快捷操作未启动');
      shortcutSettled(next.request);
      return;
    }
    dropRevision.current++;
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
        if(new TextEncoder().encode(line.current.text+data).length>MAX_LIGHTWEIGHT_LINE){setFailure('轻量命令最多接受 8192 字节');return;}
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
    const terminal=new Terminal({...terminalAppearance(),fontSize:preferences.font_size,scrollback:MAX_SCROLLBACK,cursorBlink:true});
    const addon=new FitAddon();
    const node=host.current!;
    terminal.loadAddon(addon);
    terminal.open(node);
    terminal.textarea?.setAttribute('aria-label','本地终端输入');
    term.current=terminal;
    register(tab.id,terminal);
    fileDropRoutes.set(node,{identity:dropIdentity,insert:insertDrop});
    publish();
    function openClipboardMenu(x:number,y:number) {
      invalidateClipboard();
      const target=clipboardTarget();
      if(target)setClipboardMenu({target,x,y,anchor:terminal.textarea??node,selection:terminal.getSelection()});
    }
    let keyboardData:string|undefined;
    const keypress=terminal.onKey(({key,domEvent})=>{
      if(!domEvent.isComposing){
        keyboardData=key;
        queueMicrotask(()=>{keyboardData=undefined;});
      }
    });
    terminal.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown')return true;
      if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){
        event.preventDefault();event.stopPropagation();
        const bounds=node.getBoundingClientRect();
        if(!event.repeat)openClipboardMenu(bounds.left+12,bounds.top+12);
        return false;
      }
      if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='c'){
        event.preventDefault();event.stopPropagation();
        void copySelection(false);
        return false;
      }
      if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='v'){
        event.preventDefault();event.stopPropagation();
        void pasteClipboard();
        return false;
      }
      return true;
    });
    const data=terminal.onData(text=>{
      if(!latest.current.focused)return;
      const keyboard=text===keyboardData;
      keyboardData=undefined;
      invalidateClipboard();
      const task=view.current.running?view.current.task:null;
      if(!task){edit(text);return;}
      enqueue(text,task,undefined,keyboard);
    });
    const selection=terminal.onSelectionChange(()=>{selectionRevision.current++;});
    let atScrollLimit=false;
    const written=terminal.onWriteParsed(()=>{
      if(!atScrollLimit&&terminal.buffer.normal.baseY>=MAX_SCROLLBACK){
        atScrollLimit=true;
        setAtLimit(true);
      }
    });
    const compositionStart=()=>{invalidateClipboard();composing.current=true;publish();};
    const compositionEnd=()=>{composing.current=false;publish();};
    const nativePaste=(event:ClipboardEvent)=>{
      event.preventDefault();event.stopPropagation();
      if(event.clipboardData)void pasteClipboard(event.clipboardData.getData('text/plain'));
    };
    const context=(event:MouseEvent)=>{
      event.preventDefault();event.stopPropagation();
      latest.current.focus();
      const text=terminal.getSelection();
      if(latest.current.rightClick==='smart'){
        if(text)void copySelection(true);
        else void pasteClipboard();
      }else openClipboardMenu(event.clientX,event.clientY);
    };
    const rightDown=(event:MouseEvent)=>{
      if(event.button===2){event.preventDefault();event.stopPropagation();}
    };
    node.addEventListener('compositionstart',compositionStart,true);
    node.addEventListener('compositionend',compositionEnd,true);
    node.addEventListener('paste',nativePaste,true);
    node.addEventListener('contextmenu',context,true);
    node.addEventListener('mousedown',rightDown,true);
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
    fitVisible.current=resize;
    observer.observe(node);
    update(tab.initial);
    let timer=0,waiting=false,disposed=false;
    function arm(delay=20){
      if(disposed||timer||waiting||(!view.current.running&&!uncertain.current))return;
      timer=window.setTimeout(poll,delay);
    }
    async function poll(){
      timer=0;
      if(flight.current){arm();return;}
      waiting=true;
      let retry=20;
      try{
        const original=uncertain.current;
        if(original){
          flight.current=true;
          try{
            const next=await terminalAction<LocalView>({kind:'poll',id:tab.id});
            if(disposed)return;
            setFailure(next.task===original?'':'原请求未出现在终端状态中，请核对后再提交。');
            uncertain.current=undefined;
            update(next,original);
          }finally{if(!disposed){flight.current=false;publish();}}
        }else if(view.current.running&&view.current.task){
          const task=view.current.task;
          const buffer=await invoke<ArrayBuffer>('poll_local_output',{id:tab.id,task});
          if(disposed||view.current.task!==task||!buffer.byteLength)return;
          const length=new DataView(buffer).getUint32(0,true);
          if(!length||length>buffer.byteLength-4)throw new Error('Invalid local output metadata');
          const meta=JSON.parse(outputMetadata.decode(new Uint8Array(buffer,4,length))) as Omit<LocalView,'bytes'>;
          if(meta.task!==task)throw new Error('Invalid local output task');
          update({...meta,bytes:new Uint8Array(buffer,4+length)});
        }
      }catch{if(!disposed){setFailure('本地进程状态读取失败');retry=100;}}
      finally{waiting=false;arm(retry);}
    }
    armOutput.current=()=>arm(0);
    arm(0);
    if(latest.current.focused)terminal.focus();
    return ()=>{
      disposed=true;
      alive.current=false;
      fileDropRoutes.delete(node);
      register(tab.id);
      armOutput.current=()=>{};
      fitVisible.current=()=>{};
      clearTimeout(timer);
      observer.disconnect();
      node.removeEventListener('compositionstart',compositionStart,true);
      node.removeEventListener('compositionend',compositionEnd,true);
      node.removeEventListener('paste',nativePaste,true);
      node.removeEventListener('contextmenu',context,true);
      node.removeEventListener('mousedown',rightDown,true);
      data.dispose();keypress.dispose();written.dispose();selection.dispose();terminal.dispose();term.current=undefined;
    };
  },[tab.id]);
  useEffect(()=>{
    if(!tab.powershell||tab.origin!=='ordinary'||!visible||!running)return;
    let disposed=false,timer=0;
    async function refresh(){
      const task=view.current.task;
      if(!task||!view.current.running)return;
      const generation=await terminalAction<number|null>({kind:'file_drop_epoch',id:tab.id,request:task}).catch(()=>null);
      if(disposed||task!==view.current.task||!view.current.running)return;
      shellEdit.current=generation===null?undefined:{task,generation};
      timer=window.setTimeout(refresh,120);
    }
    void refresh();
    return ()=>{disposed=true;clearTimeout(timer);shellEdit.current=undefined;};
  },[tab.id,tab.powershell,tab.origin,visible,running]);
  useLayoutEffect(()=>{
    if(pendingPaste.current?.target.route!==routeEpoch){pendingPaste.current=undefined;setPastePreview(undefined);}
    setClipboardMenu(previous=>previous?.target.route===routeEpoch?previous:undefined);
  },[routeEpoch]);

  useLayoutEffect(()=>{
    if(term.current){
      Object.assign(term.current.options,terminalAppearance(),{fontSize:preferences.font_size});
      fitVisible.current();
    }
  },[preferences]);
  useLayoutEffect(()=>{if(visible)fitVisible.current();},[visible]);
  useLayoutEffect(()=>{if(focused)term.current?.focus();},[focused]);
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
    {clipboardStatus&&<small className="local-clipboard-status" role="alert">{clipboardStatus}</small>}
    {focused&&clipboardMenu&&<ContextMenu {...clipboardMenu} label="本地终端右键菜单" close={()=>setClipboardMenu(undefined)}>
      <button role="menuitem" disabled={!clipboardMenu.selection} onClick={()=>{
        if(clipboardCurrent(clipboardMenu.target)&&term.current?.getSelection()===clipboardMenu.selection)void copySelection(true);
        else setClipboardMenu(undefined);
      }}>复制</button>
      <button role="menuitem" onClick={()=>{
        if(clipboardCurrent(clipboardMenu.target))void pasteClipboard();
        else setClipboardMenu(undefined);
      }}>粘贴</button>
    </ContextMenu>}
    {focused&&pastePreview&&<Dialog label="本地粘贴确认" modal={false} close={cancelPaste}>
      <Panel title="确认粘贴到本地终端">
        <p>目标：{tab.title} · {pastePreview.editorEpoch?'PowerShell 编辑区':pastePreview.target.task?'当前前台进程':'轻量命令行'}</p>
        <p>{pastePreview.unsupported??(pastePreview.editorEpoch||!pastePreview.target.task
          ?'确认后可继续编辑。按 Enter 提交命令。'
          :'内容可能执行命令。继续输入、切换标签或结束当前任务会取消预览。')}</p>
        <pre aria-label="本地粘贴内容预览">{visibleControls(JSON.stringify(pastePreview.proposal.text.slice(0,8192)))}{pastePreview.proposal.text.length>8192?' …预览已截断':''}</pre>
        <div className="config-actions" onKeyDown={event=>{
          if(event.key==='Enter'&&!event.nativeEvent.isComposing)event.preventDefault();
        }} onKeyUp={event=>{
          if(event.key!=='Enter'||event.nativeEvent.isComposing||!(event.target instanceof HTMLButtonElement))return;
          event.preventDefault();
          event.target.click();
        }}>
          <button data-dialog-autofocus={!pastePreview.unsupported||undefined} disabled={!!pastePreview.unsupported} onClick={()=>confirmPaste(pastePreview)}>确认粘贴</button>
          <button data-dialog-autofocus={!!pastePreview.unsupported||undefined} onClick={cancelPaste}>取消粘贴</button>
        </div>
      </Panel>
    </Dialog>}
    {atLimit&&<small>仅保留最近 {MAX_SCROLLBACK} 行滚动历史及当前屏幕</small>}
    {failure&&<small role="alert">{failure}</small>}
    {choice&&<AdbDeviceDialog devices={choice.devices} choose={serial=>void launchShortcut(choice.intent,serial)} close={()=>cancelShortcut(choice.intent)}/>}
  </div>;
}
