import {ShortcutExecution, sameShortcutSource, type ShortcutSource} from './shortcut-execution';
import {ImportConfigPanel} from './import-config-panel';
import {CloseReceiptPanel} from './close-receipt-panel';
import {sameConnectionList, sameService, snapshotCursor, subscribeSessionSnapshots,
  type ServiceStatus as Status, type SessionSnapshot} from './session-snapshot';
import type {Connection} from './ssh-api';
import {SaveRecoveryPanel, saveRecoveryAttention, type SaveRecoverySnapshot} from './save-recovery-panel';
import {BatchConfigPanel} from './batch-config-panel';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalClipboard, type PasteProposal } from './terminal-clipboard';
import { visibleControls } from './log-search';
import {LocalRightClickSetting,useLocalRightClick} from './local-right-click';
import { TerminalSearch } from './terminal-search-panel';
import {desktopShortcut,shortcutEditor} from './desktop-shortcuts';
import { initialTerminalView, type TerminalController, type TerminalView, type PaneSelection } from './terminal-controller';
import { type ThemeChoice, type TerminalFont } from './appearance';
import { SoftwareSettings } from './software-settings';
import { isTerminalFontSize, TerminalFontSizeControl, useTerminalFontSize } from './terminal-font-size';
import { AgentPanel } from './agent-panel';
import { ComposePanel } from './compose-panel';
import type { ComposePacing } from './compose-pacing';
import {QuickCommandsPanel} from './quick-commands-panel';
import {TriggerPanel} from './trigger-panel';
import {Triggers} from './triggers';
import {triggerDependencies} from './trigger-api';
import {ContinuousInputPanel} from './continuous-input-panel';
import {ContinuousInput} from './continuous-input';
import {continuousTargetReady} from './broadcast-api';
import {BroadcastPanel} from './broadcast-panel';
import {BroadcastRun,type BroadcastSeed} from './broadcast';
import {broadcastTargetReady,sendBroadcastTarget,queryBroadcastTarget} from './broadcast-api';
import {sameQuickContext,type QuickContext} from './quick-commands';
import { ComposeDrafts, type ComposeTarget, type Ending } from './compose-drafts';
import {ComposeHistory} from './compose-history';
import { revealProfileConnectionFocus, SessionTree } from './session-tree';
import { ConnectionCatalog } from './connection-catalog';
import { config, readConfiguration, type DesktopPreferences, type Profile, type Settings, type Workspace } from './config-api';
import { ConfigPanel } from './config-panel';
import { SshPanel } from './ssh-panel';
import { QuickConnect, type SavedConnectIntent } from './quick-connect';
import { SessionTabClosures } from './session-tab-closures';
import { SessionCopy, copyRouteCurrent, type CopyRead, type CopyRoute } from './session-copy';
import { TabGroups } from './tab-groups';
import { TabGroupsPanel } from './tab-groups-panel';
import { SessionTabs, localDragSource } from './session-tabs';
import { WindowChrome } from './window-chrome';
import type { TabDrop } from './tab-drag';
import { SessionDragPreview, useSessionDrag } from './session-drag';
import { PaneGrid } from './pane-grid';
import { WorkspaceSession, captureWorkspace } from './workspace-session';
import { WorkspacesPanel } from './workspaces-panel';
import { useTabLogging, logBadge } from './tab-logging';
import { ControlIcon, ToolbarMenu, Dialog, Panel } from './ui';
import { TerminalLogMenu } from './terminal-log-menu';
import {RecordingNotice,useOpenLogDirectory,useRecordingNotices} from './recording-notice';
import {CornerNotice,CornerNoticeFailure,CornerNoticeHost} from './corner-notice';
import type {TerminalMenuContext,RememberedLogTask} from './log-menu';
import { TerminalPane } from './terminal-pane';
import { PaneLayout, type PaneKey } from './pane-layout';
import { ExecPanel } from './exec-panel';
import { SerialPanel } from './serial-panel';
import { QuickSerial } from './quick-serial';
import {LocalTerminal, terminalAction, type LocalPromptState, type LocalTab, type LocalView} from './local-terminal';
import {AdbShortcutPanel, loadAdbSettings, type AdbDiagnostic, type AdbIntent, type AdbSettings, type AdbShortcut} from './local-adb';
import { LoggingPanel } from './logging-panel';
import { serial, type SerialStatus } from './serial-api';
import { requestId } from './request-id';
import { ssh, dimensions, disconnectSsh1, type SshReply } from './ssh-api';
import { Ssh1Connect, type Ssh1Intent } from './ssh1-connect';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Ref = Pick<Connection, 'connection_id' | 'generation'>;
type CopySource = {owner:string;connection:Connection;settings:Settings;saved_profile:string|null};
const sameRef=(a:Ref,b:Ref)=>a.connection_id===b.connection_id&&a.generation===b.generation;
type ServiceScreen = { connection: Ref; encoding: string; parser: string; resize_reflow: boolean; rows: number; cols: number; contents: string; contents_truncated: boolean; cursor_row: number; cursor_col: number; alternate: boolean; source_cursor: number; completed: boolean; gap_bytes: number; decode_error_events: number };
const demo = '共享终端 · 服务合成 UTF-8/ANSI 回放\r\n\x1b[32m中文宽字 ✓\x1b[0m\r\n输入通过统一服务追加到合成输出，不发送到设备。\r\n\x1b[?1049h\x1b[2J\x1b[H替代屏幕\x1b[?1049l';
const appWindow = getCurrentWindow();
const detached = appWindow.label !== 'main';

function App() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeEpoch, setComposeEpoch] = useState(0);
  const [composeEnding,setComposeEnding]=useState<Ending>('none'),[composeOrigin,setComposeOrigin]=useState<string>();
  const [quickCommandsOpen,setQuickCommandsOpen]=useState(false);
  const [broadcastOpen,setBroadcastOpen]=useState(false);
  const [continuousOpen,setContinuousOpen]=useState(false);
  const [triggersOpen,setTriggersOpen]=useState(false);
  const [batchConfigOpen,setBatchConfigOpen]=useState(false);
  const [importConfigOpen,setImportConfigOpen]=useState(false);
  const [triggerNotice,setTriggerNotice]=useState<{id:string;text:string}>();
  const dismissTriggerNotice=()=>setTriggerNotice(current=>current===triggerNotice?undefined:current);
  const [broadcastSeed,setBroadcastSeed]=useState<BroadcastSeed>();
  const panes=useRef(new PaneLayout());
  const [splitRatios,setSplitRatios]=useState<Record<number,number>>({});
  const [dockHover,setDockHover]=useState(false);
  const [paneEpoch,setPaneEpoch]=useState(0);
  const [terminalMenu,setTerminalMenu]=useState<TerminalMenuContext>();
  const controllers=useRef(new Map<PaneKey,TerminalController>());
  const detachedInputFocused=useRef(false);
  const [paneViews,setPaneViews]=useState<Partial<Record<PaneKey,TerminalView>>>({});
  const terminalView=paneViews[panes.current.active]??initialTerminalView();
  const {renderedTarget,viewport,status,lastInput,inputFailure,decodeWarning}=terminalView;
  const setInputFailure=(inputFailure:string)=>setPaneViews(v=>({...v,[panes.current.active]:{...(v[panes.current.active]??initialTerminalView()),inputFailure}}));
  const drafts = useRef(new ComposeDrafts());
  const composeHistory=useRef(new ComposeHistory());
  const composeSend = useRef<((target: ComposeTarget, text: string, pacing?:ComposePacing) => boolean) | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('navigation-open') !== 'false'; } catch { return true; }
  });
  const [navigationWidth, setNavigationWidth] = useState(260);
  const connectionEntry = useRef<HTMLElement>(null);
  const paneLaunch = useRef<{key:PaneKey;owner:string}|undefined>(undefined);
  const sessionCopy=useRef(new SessionCopy());
  const [copySource,setCopySource]=useState<CopySource&{route:CopyRoute}>();
  const [copyTarget,setCopyTarget]=useState<Ref>();
  const [treeRevision, setTreeRevision] = useState(0);
  const [requestedProfile, setRequestedProfile] = useState<Profile>();
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const tabClosures=useRef(new SessionTabClosures());
  const tabGroups=useRef(new TabGroups());
  const [,setGroupEpoch]=useState(0),[groupsOpen,setGroupsOpen]=useState(false);
  const workspaceSession=useRef(new WorkspaceSession());
  const [workspaceOpen,setWorkspaceOpen]=useState(false),[workspaceEpoch,setWorkspaceEpoch]=useState(0);
  const workspaceLaunch=useRef<{slot:string;nonce:string;owner:string;protocol:'SSH2'|'SERIAL'}|undefined>(undefined);
  const restoredFocus=useRef<{key:PaneKey;epoch:number;connection:Ref}|undefined>(undefined);
  const workspacePlacements=useRef(new Map<string,{owner:string;connection:Connection}>());
  const [serialNonce,setSerialNonce]=useState('');
  const [,setTabEpoch]=useState(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const catalog = useRef(new ConnectionCatalog());
  const [, setCatalogEpoch] = useState(0);
  const [tabMessage, setTabMessage] = useState('');
  const tabCloseFeedback=useRef(0);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const allowExit = useRef(false);
  const closingDesktop = useRef<symbol>(undefined);
  const pendingExitCheck = useRef(false);
  const transferring = useRef<string>(undefined);
  const liveConnections = useRef<Connection[]>([]);
  const latestSnapshot = useRef<SessionSnapshot | undefined>(undefined);
  const [softwareSettingsOpen, setSoftwareSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [closeInfoOpen,setCloseInfoOpen]=useState(false);
  const [closeNoticeDismissed,setCloseNoticeDismissed]=useState(false);
  const [saveRecovery,setSaveRecovery]=useState<SaveRecoverySnapshot>();
  const [saveRecoveryOpen,setSaveRecoveryOpen]=useState(false);
  const [saveRecoveryDismissed,setSaveRecoveryDismissed]=useState(false);
  useEffect(()=>{
    let disposed=false;
    void invoke<SaveRecoverySnapshot>('save_recovery_status').then(
      value=>{if(!disposed)setSaveRecovery(value);},
      ()=>{if(!disposed)setSaveRecovery({availability:'IO',items:[]});},
    );
    return ()=>{disposed=true;};
  },[]);
  const [preferences, setPreferences] = useState<DesktopPreferences>({ theme: 'light', terminal_font: 'consolas', terminal_palette: 'black_white', font_size: 15, ctrl_c_copy: true, ctrl_v_paste: false, right_click_paste: false });
  const preferenceRef = useRef(preferences); preferenceRef.current = preferences;
  const theme: ThemeChoice = preferences.theme, terminalFont: TerminalFont = preferences.terminal_font;
  const fontSize = preferences.font_size;
  const [preferencesBusy, setPreferencesBusy] = useState(true);
  const preferenceFlight = useRef(false), preferenceEpoch = useRef(0);
  const preferenceRevision = useRef<string>(undefined);
  const preferencesOwner = useRef<string>(undefined);
  const remoteFontEpoch = useRef(0);
  const [preferenceMessage, setPreferenceMessage] = useState('正在读取本数据目录偏好');
  function updatePreferences(patch: Partial<DesktopPreferences>) {
    if (preferenceFlight.current) return;
    clipboard.current?.invalidate();
    setPreferences(previous => ({ ...previous, ...patch }));
    setPreferenceMessage('桌面偏好尚未保存，退出应用或重载会丢弃这些调整');
  }
  async function announceFontSize(fontSize:number) {
    const owner=serviceRef.current?.service_id;
    if(!detached&&owner)await emit('terminal-font-size-saved',{owner,fontSize}).catch(()=>{});
  }
  const fontSizing=useTerminalFontSize(font_size=>{
    clipboard.current?.invalidate();
    setPreferences(previous=>({...previous,font_size}));
  },receipt=>{
    // Advancing the full-save baseline is safe only if it was the one we patched.
    if(receipt.previous_revision&&receipt.previous_revision===preferenceRevision.current){
      preferenceRevision.current=receipt.revision;
    }
    return announceFontSize(receipt.font_size);
  });
  function setFontSize(size:number) {
    if(!preferencesBusy&&!preferenceFlight.current&&!closingDesktop.current)fontSizing.change(size);
  }
  useEffect(()=>{
    if(!detached)return;
    const unlisten=listen<{owner:string;fontSize:number}>('terminal-font-size-saved',event=>{
      const {owner,fontSize}=event.payload;
      if(owner!==serviceRef.current?.service_id||!isTerminalFontSize(fontSize))return;
      remoteFontEpoch.current++;
      setPreferences(previous=>({...previous,font_size:fontSize}));
    });
    return()=>{void unlisten.then(stop=>stop());};
  },[]);
  async function preferenceOperation(save: boolean) {
    if (preferenceFlight.current || (save && !preferenceRevision.current)) return;
    preferenceFlight.current = true; setPreferencesBusy(true);
    const epoch = ++preferenceEpoch.current;
    const owner = serviceRef.current?.service_id;
    setPreferenceMessage(save ? '正在保存本数据目录偏好' : '正在读取本数据目录偏好');
    try {
      await fontSizing.settled();
      if(epoch!==preferenceEpoch.current)return;
      const observedFontEpoch=remoteFontEpoch.current;
      const reply = await config(save ? { op: 'save_preferences', preferences: preferenceRef.current, revision: preferenceRevision.current! } : { op: 'preferences' });
      if (epoch !== preferenceEpoch.current) return;
      if (reply.result !== 'preferences') throw new Error('偏好响应不匹配');
      clipboard.current?.invalidate();
      setPreferences(previous=>observedFontEpoch===remoteFontEpoch.current
        ? reply.preferences : {...reply.preferences,font_size:previous.font_size});
      preferenceRevision.current=reply.revision;
      fontSizing.reset();
      await announceFontSize(reply.preferences.font_size);
      if(epoch!==preferenceEpoch.current)return;
      setPreferenceMessage(save ? '已保存到本数据目录；重载或下次启动自动读取' : '已读取本数据目录偏好；未发送任何终端输入');
    } catch (error) {
      if (epoch !== preferenceEpoch.current) return;
      preferenceRevision.current=undefined;
      setPreferenceMessage(`${error instanceof Error ? error.message : '偏好请求失败'} ${save ? '保存结果可能未知；请重新读取核对，未自动重试。' : '当前显示保留，未覆盖存储；可重新读取。'}`);
    } finally {
      if (epoch === preferenceEpoch.current) {
        preferencesOwner.current=owner;
        preferenceFlight.current = false;
        setPreferencesBusy(false);
      }
    }
  }
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const toolsReturnDialog = useRef<'configuration' | 'settings' | 'closeInfo' | 'saveRecovery' | 'workspace' | 'batchConfig' | undefined>(undefined);
  const toolsSummary = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const dialog = toolsReturnDialog.current;
    if (!dialog) return;
    const open = { configuration: configurationOpen, settings: softwareSettingsOpen, closeInfo: closeInfoOpen,
      saveRecovery: saveRecoveryOpen, workspace: workspaceOpen, batchConfig: batchConfigOpen };
    if (open[dialog]) return;
    toolsReturnDialog.current = undefined;
    toolsSummary.current?.focus();
  }, [configurationOpen, softwareSettingsOpen, closeInfoOpen, saveRecoveryOpen, workspaceOpen, batchConfigOpen]);
  const [configurationTarget,setConfigurationTarget]=useState<string>();
  const [configurationCreation,setConfigurationCreation]=useState<{protocol:'ssh2'|'serial';folder:string;key:PaneKey;owner:string}>();
  const creationRoute=useRef<typeof configurationCreation>(undefined);
  function closeConfiguration(){
    creationRoute.current=undefined;
    setConfigurationCreation(undefined);
    setConfigurationOpen(false);
    setTreeRevision(value=>value+1);
  }
  const [sshOpen, setSshOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [savedIntent,setSavedIntent]=useState<SavedConnectIntent>();
  const savedIntentFlight=useRef<SavedConnectIntent|undefined>(undefined);
  const [ssh1Intent,setSsh1Intent]=useState<Ssh1Intent>();
  const ssh1Flight=useRef(false);
  const firstSsh1Fit = useRef<{ owner: string; connection: Ref; pane: PaneKey; epoch: number; size: ReturnType<typeof dimensions> } | undefined>(undefined);
  function closeSsh1(){ssh1Flight.current=false;setSsh1Intent(undefined);}
  function closeQuick(connected=false){if(!finishCopyDialog(connected))return;if(workspaceLaunch.current?.protocol==='SSH2')workspaceLaunch.current=undefined;savedIntentFlight.current=undefined;setSavedIntent(undefined);setQuickOpen(false);setCopySource(undefined);setCopyTarget(undefined);setTabMessage(previous=>previous.startsWith('正在连接 ')?'':previous);}
  const [execOpen, setExecOpen] = useState(false);
  const [serialOpen, setSerialOpen] = useState(false);
  const [serialDialog,setSerialDialog]=useState(false);
  const [serialToolsOpen,setSerialToolsOpen]=useState(false);
  const [loggingOpen,setLoggingOpen] = useState(false);
  const [search, setSearch] = useState<{local?:{pane:PaneKey;id:string}}>();
  const [shortcutHelp,setShortcutHelp]=useState(false);
  const clipboard = useRef<TerminalClipboard | undefined>(undefined);
  const localClipboardEpoch=useRef(0);
  const localRightClick=useLocalRightClick(!detached,()=>{localClipboardEpoch.current++;});
  const [pasteProposal, setPasteProposal] = useState<PasteProposal>();
  const [clipboardMessage, setClipboardMessage] = useState('');
  function cancelPaste(){clipboard.current?.invalidate();setClipboardMessage('已取消粘贴；未发送');runtime.current?.term.focus();}
  function selectConnection(id: string, expected?:Ref) {
    localSelected.current.delete(panes.current.active);
    if(!workspaceLaunch.current)cancelWorkspaceSplit();
    const target=liveConnections.current.find(c=>c.connection_id===id);if(target)tabClosures.current.show(target);setTabEpoch(value=>value+1);
    panes.current.select(id,target,expected?.generation);routeChanged();
  }
  const runtime = useRef<{ term: Terminal; fit: FitAddon; connection?: Ref; fixture: boolean; inputs: number; protocol: string; writable: boolean } | null>(null);
  const [service, setService] = useState<Status>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const [serviceFailure, setFailure] = useState('');
  const failure=serviceFailure||terminalView.failure;
  const [snapshot, setSnapshot] = useState('');
  const [serviceScreen, setServiceScreen] = useState<ServiceScreen>();
  const [busy, setBusy] = useState(false);
  const [localTabs, setLocalTabs] = useState<(LocalTab&{surface:HTMLDivElement})[]>([]);
  const liveLocalTabs=useRef(localTabs);
  liveLocalTabs.current=localTabs;
  const localSelected = useRef(new Map<PaneKey,string>());
  const localRenderers=useRef(new Map<string,Terminal>());
  function registerLocal(id:string,term?:Terminal){
    if(term)localRenderers.current.set(id,term);
    else localRenderers.current.delete(id);
  }
  const localCount = useRef(0);
  const nextLocal = useRef(0);
  const openingLocal = useRef(false);
  const [adbSettings,setAdbSettings]=useState<AdbSettings>();
  const adbSettingsEpoch=useRef(0);
  const [adbDefaultOpen]=useState(()=>{
    try {return localStorage.getItem('local-adb-shortcuts-open')==='true';}
    catch {return false;}
  });
  const [adbPanels,setAdbPanels]=useState<Partial<Record<PaneKey,boolean>>>({});
  const [adbKeyboardFocus,setAdbKeyboardFocus]=useState<{pane:PaneKey;request:number}>();
  const adbFocusNumber=useRef(0);
  const [adbIntent,setAdbIntent]=useState<AdbIntent&{id:string}>();
  const [adbStarting,setAdbStarting]=useState(false);
  const [adbDiagnostics,setAdbDiagnostics]=useState<Record<string,AdbDiagnostic>>({});
  const [shortcutExecution]=useState(()=>new ShortcutExecution());
  const promptStates=useRef(new Map<string,LocalPromptState>());
  const reportLocalPrompt=useRef((id:string,state:LocalPromptState)=>{promptStates.current.set(id,state);});
  const closingLocal=useRef(new Set<string>());
  function shortcutSettled(request:string) {
    if(shortcutExecution.settle(request))setAdbStarting(false);
  }
  async function loadAdb() {
    const epoch=++adbSettingsEpoch.current;
    try {
      const settings=await loadAdbSettings();
      if(epoch===adbSettingsEpoch.current)setAdbSettings(settings);
    } catch(error) {if(epoch===adbSettingsEpoch.current)setTabMessage(String(error));}
  }
  useEffect(()=>{
    if(detached)return;
    void loadAdb();
    const unlisten=appWindow.listen<string>('local-shortcuts-changed',()=>void loadAdb());
    return()=>{void unlisten.then(stop=>stop(),()=>{});};
  },[]);
  function setAdbPanel(pane:PaneKey,open:boolean) {
    setAdbPanels(previous=>({...previous,[pane]:open}));
    try {localStorage.setItem('local-adb-shortcuts-open',String(open));}
    catch { /* the current window still remembers the choice */ }
    if(open)void loadAdb();
    else document.querySelector<HTMLElement>(`[data-pane="${pane}"] .adb-panel-toggle`)?.focus();
  }
  function toggleAdbFromKeyboard(pane:PaneKey){
    const open=adbPanels[pane]??adbDefaultOpen;
    setAdbPanel(pane,!open);
    if(open){
      setAdbKeyboardFocus(undefined);
      focusPane(pane,true);
    }else setAdbKeyboardFocus({pane,request:++adbFocusNumber.current});
  }
  function findTerminal(){
    const pane=panes.current.active, id=localSelected.current.get(pane);
    const term=id?localRenderers.current.get(id):serviceSearchRenderer();
    if(!term)return;
    if(search){
      document.querySelector<HTMLElement>('[aria-label="终端查找文字"]')?.focus();
      return;
    }
    setSearch(id?{local:{pane,id}}:{});
  }
  function searchRenderer(){
    const local=search?.local;
    if(!local)return serviceSearchRenderer();
    if(panes.current.active===local.pane&&localSelected.current.get(local.pane)===local.id)return localRenderers.current.get(local.id);
  }
  function serviceSearchRenderer(){
    const pane=panes.current.current, terminal=runtime.current;
    if(localSelected.current.has(pane.key)||pane.pending||pane.retired||!pane.binding||!terminal?.connection)return;
    if(sameRef(pane.binding,terminal.connection)&&pane.binding.protocol===terminal.protocol)return terminal.term;
  }
  function closeSearch(keyboard=false){
    if(search?.local){
      const term=searchRenderer();
      term?.clearSelection();
      term?.scrollToBottom();
      term?.focus();
    }else if(keyboard)toolsSummary.current?.focus();
    setSearch(undefined);
  }
  useLayoutEffect(()=>{
    if(!search)return;
    const local=search.local, active=panes.current.active;
    if(local?(active!==local.pane||localSelected.current.get(active)!==local.id):localSelected.current.has(active)){
      if(local)localRenderers.current.get(local.id)?.clearSelection();
      setSearch(undefined);
    }
  },[search,paneEpoch]);
  function ownsLocalTab(pane:PaneKey,id:string) {
    return !closingLocal.current.has(id)&&liveLocalTabs.current.some(tab=>tab.id===id)&&panes.current.paneOf(id)===pane;
  }
  async function openLocal(pane:PaneKey,powershell=true,{inherit,script,beside=false,adbResult=false,shortcutSource}:{
    inherit?:string;script?:{button:string;revision:string};beside?:boolean;adbResult?:boolean;shortcutSource?:ShortcutSource;
  }={}) {
    if (openingLocal.current||closingDesktop.current) return undefined;
    openingLocal.current=true;
    const id=crypto.randomUUID();
    try {
      const initial=await terminalAction<LocalView>({kind:'open',id,inherit:inherit??null,powershell,script:script??null});
      if(!panes.current.slots.some(slot=>slot.key===pane)||beside&&inherit&&!ownsLocalTab(pane,inherit)) {
        await terminalAction({kind:'close',id});return;
      }
      const title=initial.script??'本地 '+(++nextLocal.current);
      localCount.current++;
      const surface=document.createElement('div');
      surface.className='local-terminal-surface';
      panes.current.placeLocal(id,pane);
      if(shortcutSource)shortcutExecution.origins.set(id,shortcutSource);
      setLocalTabs(previous=>[...previous,{id,title,initial,surface,powershell,origin:script?'script':adbResult?'adb-result':'ordinary'}]);
      if(beside&&inherit)insertTab(id,inherit,true);
      if(!shortcutSource||sourceSelected(shortcutSource))selectLocal(pane,id);
      if(!adbSettings)void loadAdb();
      return id;
    } catch(error) {setTabMessage(String(error));}
    finally {openingLocal.current=false;}
  }
  function copyLocalTab(pane:PaneKey,id:string,gesture:'menu'|'double-click') {
    const tab=liveLocalTabs.current.find(item=>item.id===id);
    if(!tab||tab.origin==='script'||!ownsLocalTab(pane,id))return;
    if(gesture==='double-click'&&(tab.origin!=='ordinary'||!tab.powershell&&
      (shortcutExecution.startingTab(id)||promptStates.current.get(id)?.busy!==false)))return;
    void openLocal(pane,tab.powershell,{inherit:id,beside:true});
  }
  function selectLocal(pane:PaneKey,id:string) {
    localSelected.current.set(pane,id);
    panes.current.focus(pane);
    routeChanged();
  }
  async function closeLocal(id:string,successfulShortcut=false) {
    if(closingLocal.current.has(id))return;
    closingLocal.current.add(id);
    try {
      await terminalAction({kind:'close',id});
      const pane=panes.current.paneOf(id);
      const {restore,released}=shortcutExecution.closeResult(id,panes.current.active,localSelected.current.get(panes.current.active),successfulShortcut&&pane===panes.current.active);
      if(released)setAdbStarting(false);
      panes.current.forgetLocal(id);
      if (localSelected.current.get(pane)===id) {
        const next=localPeers(pane,id)[0];
        if(next)localSelected.current.set(pane,next.id);
        else localSelected.current.delete(pane);
      }
      promptStates.current.delete(id);
      localCount.current=Math.max(0,localCount.current-1);
      setLocalTabs(previous=>previous.filter(tab=>tab.id!==id));
      setTabOrder(previous=>previous.filter(other=>other!==id));
      if(restore&&restoreShortcutOrigin(restore))return;
      if(!liveConnections.current.some(tab=>!tabClosures.current.isHidden(tab)&&panes.current.paneOf(tab.connection_id)===pane)&&!localPeers(pane,id).length)
        panes.current.closePane(pane,panes.current.active);
      routeChanged();
    } catch(error) {setTabMessage(String(error));}
    finally {closingLocal.current.delete(id);}
  }
  function shortcutSource(pane:PaneKey):ShortcutSource|undefined {
    if(panes.current.active!==pane)return;
    const local=localSelected.current.get(pane);
    if(local)return ownsLocalTab(pane,local)?{pane,local}:undefined;
    const route=paneSelection(pane);
    if(route.connection&&['SSH1','SSH2','SERIAL'].includes(route.connection.protocol))
      return {pane,owner:route.owner,connection:route.connection};
  }
  function sourceSelected(source:ShortcutSource) {
    return sameShortcutSource(source,shortcutSource(source.pane));
  }
  function restoreShortcutOrigin(source:ShortcutSource) {
    const id='local' in source?source.local:source.connection.connection_id;
    const destination=panes.current.paneOf(id);
    if('local' in source){
      if(!ownsLocalTab(destination,source.local))return false;
      selectLocal(destination,source.local);
    }else{
      const target=liveConnections.current.find(c=>sameRef(c,source.connection)&&c.protocol===source.connection.protocol);
      if(serviceStopped.current||source.owner!==serviceRef.current?.service_id||!target||tabClosures.current.isHidden(target))return false;
      panes.current.focus(destination);
      selectConnection(target.connection_id,target);
    }
    requestAnimationFrame(()=>{if(sourceSelected({...source,pane:destination}))focusPane(destination,true);});
    return true;
  }
  async function executeShortcut(pane:PaneKey,item:AdbShortcut,revision:string) {
    const source=shortcutSource(pane);
    if(!source||closingDesktop.current)return;
    await shortcutExecution.execute(source,item,revision,{
      selected:sourceSelected,epoch:()=>panes.current.epoch,writable:shortcutSendReady,
      readText:request=>invoke('local_shortcut_text',{request}),
      send(key,target,text){
        if(controllers.current.get(key)?.compose(target,text))focusPane(key,true);
        else setTabMessage('当前会话不可写，快捷文本未发送');
      },
      error:setTabMessage,prompt:id=>promptStates.current.get(id),
      open:(key,options)=>openLocal(key,false,options),starting:setAdbStarting,dispatch:setAdbIntent,
    });
  }
  function shortcutSendReady(pane:PaneKey) {
    const route=paneSelection(pane), view=paneViews[pane];
    const target=route.connection;
    return !!target&&!!route.owner&&['SSH1','SSH2','SERIAL'].includes(target.protocol)&&target.state==='CONNECTED'&&
      !!view?.renderedTarget&&sameRef(target,view.renderedTarget)&&!view.failure&&!view.inputFailure&&!serviceStopped.current;
  }
  function reportAdbDiagnostic(intent:AdbIntent,diagnostic:AdbDiagnostic) {
    if(shortcutExecution.acceptsDiagnostic(intent))
      setAdbDiagnostics(previous=>({...previous,[intent.button]:diagnostic}));
  }
  const stopped = useRef(false);
  const connectionStates=JSON.stringify(connections.map(c=>[c.connection_id,c.generation,c.state]));
  const connectionIdentities = JSON.stringify(connections.map(({ connection_id, generation, protocol }) => ({ connection_id, generation, protocol })));

  useEffect(() => {
    const owner = service?.service_id ?? '';
    const retained: Connection[] = JSON.parse(connectionIdentities);
    catalog.current.retain(owner, retained);
    const ids = new Set(retained.map(item => item.connection_id));
    for(const tab of liveLocalTabs.current)ids.add(tab.id);
    setTabOrder(previous => previous.filter(id => ids.has(id)));
    tabClosures.current.retain(owner,retained);
    tabGroups.current.retain(owner,retained);setGroupEpoch(value=>value+1);
    workspaceSession.current.retain(owner,retained);
    setCatalogEpoch(value => value + 1);
    let disposed = false, timer = 0;
    async function readDetails() {
      for (const connection of retained) {
        if (disposed) return;
        if (!['SSH1', 'SSH2', 'SERIAL'].includes(connection.protocol) || catalog.current.get(connection)) continue;
        try {
          const request = { op: 'status', connection: { connection_id: connection.connection_id, generation: connection.generation } };
          const reply = await invoke<SshReply | SerialStatus>(connection.protocol === 'SERIAL' ? 'serial_request' : 'ssh_request', { request });
          if (disposed) return;
          if (reply.result === 'status' && reply.connection.connection_id === connection.connection_id && reply.connection.generation === connection.generation && reply.connection.protocol === connection.protocol && catalog.current.put(owner, connection, reply)) setCatalogEpoch(value => value + 1);
        } catch { /* Display metadata may race removal; output polling owns service failures. */ }
      }
      if (!disposed) timer = window.setTimeout(() => void readDetails(), 2000);
    }
    if (owner) void readDetails();
    return () => { disposed = true; clearTimeout(timer); };
  }, [service?.service_id, connectionIdentities]);

  useEffect(()=>{
    const live=liveConnections.current;
    const placement=sessionCopy.current.takePlacement(service?.service_id,live);
    if(!placement||!copyStillCurrent(placement.route))return;
    const {anchor,child}=placement;
    if(!assignTab(child,tabGroups.current.groupOf(anchor.connection_id)))return;
    setTabOrder(previous=>{
      const current=[...live.map(c=>c.connection_id).filter(id=>id!==child.connection_id),...liveLocalTabs.current.map(tab=>tab.id)];
      const ordered=previous.filter(id=>current.includes(id));
      ordered.push(...current.filter(id=>!ordered.includes(id)));
      ordered.splice(ordered.indexOf(anchor.connection_id)+1,0,child.connection_id);
      return ordered;
    });
  },[service?.service_id,connectionIdentities,copyTarget?.connection_id,copyTarget?.generation]);

  useEffect(()=>{const owner=service?.service_id??'';let placed=false;for(const [slot,item] of workspacePlacements.current){if(item.owner!==owner){workspacePlacements.current.delete(slot);continue;}const live=liveConnections.current.find(c=>c.connection_id===item.connection.connection_id&&c.generation===item.connection.generation&&c.protocol===item.connection.protocol);if(!live)continue;const tab=workspaceSession.current.layout?.tabs.find(t=>t.id===slot);if(tab){try{tabGroups.current.assign(owner,live,tab.group_id??'');placed=true;}catch{/* a removed group is presentation-only */}}workspacePlacements.current.delete(slot);}
    if(placed){
      setTabOrder(previous=>{
        const base=[...liveConnections.current].sort((a,b)=>(previous.indexOf(a.connection_id)<0?previous.length:previous.indexOf(a.connection_id))-(previous.indexOf(b.connection_id)<0?previous.length:previous.indexOf(b.connection_id)));
        const remote=workspaceSession.current.order(base).map(c=>c.connection_id);
        const local=new Set(liveLocalTabs.current.map(tab=>tab.id));
        const order=previous.filter(id=>local.has(id)||remote.includes(id)).map(id=>local.has(id)?id:remote.shift()!);
        return [...order,...remote];
      });
      setGroupEpoch(v=>v+1);
    }
    if(!serviceStopped.current){const plan=workspaceSession.current.claimSplit(owner,liveConnections.current);if(plan){try{panes.current.restore(owner,plan.first,plan.second,plan.direction,plan.active);routeChanged();focusRenderedTerminal(plan.active);setTabMessage('两个指定目标已明确连接，已恢复保存的分屏与活动项；没有重放输入。');setWorkspaceEpoch(v=>v+1);}catch{workspaceSession.current.cancelSplit(true);setTabMessage('目标已变化，未恢复分屏。当前连接保留，可手动分屏。');}}}
  },[workspaceEpoch,connectionIdentities,connectionStates,service?.service_id]);
  function focusRenderedTerminal(connection: Ref) {
    restoredFocus.current={key:panes.current.active,epoch:panes.current.epoch,connection};
  }
  useEffect(()=>{
    const focus=restoredFocus.current;
    if(!focus)return;
    const {active,epoch}=panes.current;
    if(focus.epoch!==epoch||focus.key!==active){restoredFocus.current=undefined;return;}
    if(quickOpen||serialDialog||ssh1Intent)return;
    const rendered=paneViews[focus.key]?.renderedTarget;
    const term=controllers.current.get(focus.key)?.runtime.term;
    if(rendered?.connection_id===focus.connection.connection_id&&rendered.generation===focus.connection.generation&&term?.textarea?.getClientRects().length){
      restoredFocus.current=undefined;
      term.focus();
    }
  },[paneViews,paneEpoch,workspaceEpoch,quickOpen,serialDialog,ssh1Intent]);

  useEffect(()=>{const rechecked=(event:Event)=>{const id=(event as CustomEvent<{service_id:string}>).detail?.service_id;if(serviceStopped.current||!id||id!==serviceRef.current?.service_id)return;void preferenceOperation(false);setTreeRevision(value=>value+1);};window.addEventListener('configuration-rechecked',rechecked);return()=>window.removeEventListener('configuration-rechecked',rechecked);},[]);

  useEffect(() => {
    if (!service?.service_id) return;
    preferenceFlight.current = false;
    void preferenceOperation(false);
    return () => { preferenceEpoch.current++; preferenceFlight.current = false; };
  }, [service?.service_id]);

  useEffect(() => {
    if(detached)return;
    const unlisten = appWindow.onCloseRequested(event => {
      if(allowExit.current)return;
      event.preventDefault();
      if(pendingExitCheck.current)return;
      pendingExitCheck.current=true;
      void invoke<boolean>('desktop_live_sessions').then(live=>{
        if(live||localCount.current){setExitConfirm(true);return;}
        return finishDesktopClose();
      }).catch(()=>{
        allowExit.current=false;
        setExitConfirm(true);
      }).finally(()=>{pendingExitCheck.current=false;});
    });
    return () => { void unlisten.then(dispose => dispose()); };
  }, []);
  async function finishDesktopClose(){
    if(closingDesktop.current)return;
    const attempt=Symbol();
    closingDesktop.current=attempt;
    try{
      await fontSizing.settled();
      if(closingDesktop.current!==attempt)return;
      await terminalAction({kind:'close_all'});
      allowExit.current=true;
      await appWindow.close();
    }catch(error){
      closingDesktop.current=undefined;
      allowExit.current=false;
      throw error;
    }
  }
  function cancelDesktopClose(){
    if(!allowExit.current){closingDesktop.current=undefined;setExitConfirm(false);}
  }

  const serviceRef=useRef<Status|undefined>(undefined);
  const serviceStopped=useRef(false);
  const broadcastRun=useRef(new BroadcastRun({alive:owner=>!serviceStopped.current&&serviceRef.current?.service_id===owner,id:requestId,ready:broadcastTargetReady,send:sendBroadcastTarget,query:queryBroadcastTarget}));
  const continuousRun=useRef(new ContinuousInput({alive:owner=>!serviceStopped.current&&serviceRef.current?.service_id===owner,id:requestId,ready:continuousTargetReady,send:sendBroadcastTarget,query:queryBroadcastTarget}));
  const triggers=useRef(new Triggers({...triggerDependencies,alive:owner=>!serviceStopped.current&&serviceRef.current?.service_id===owner,
    notify:text=>setTriggerNotice(previous=>previous?.text===text?previous:{id:crypto.randomUUID(),text})}));
  function closeBroadcast(){broadcastRun.current.cancel();setBroadcastOpen(false);setBroadcastSeed(undefined);}
  function syncRoute(){
    for(const [key,id] of localSelected.current){
      const pane=panes.current.paneOf(id);
      if(pane===key)continue;
      localSelected.current.delete(key);
      if(!localSelected.current.has(pane)&&!panes.current.slots.find(slot=>slot.key===pane)?.requested)
        localSelected.current.set(pane,id);
    }
    for(const slot of panes.current.slots){
      if(slot.requested||localSelected.current.has(slot.key))continue;
      const first=localPeers(slot.key,'')[0];
      if(first)localSelected.current.set(slot.key,first.id);
    }
    const current=panes.current.current,local=localSelected.current.has(panes.current.active);
    selectedRef.current=local?'':current.requested;setSelected(selectedRef.current);
    const c=local?undefined:controllers.current.get(panes.current.active);runtime.current=c?.runtime??null;clipboard.current=c?.clipboard;composeSend.current=c?.compose;setPaneEpoch(v=>v+1);
  }
  function routeChanged(){localClipboardEpoch.current++;firstSsh1Fit.current=undefined;setTerminalMenu(undefined);setComposeEnding('none');setComposeOrigin(undefined);drafts.current.invalidate();for(const c of controllers.current.values())c.invalidate();setPasteProposal(undefined);setClipboardMessage('');setServiceScreen(undefined);setSnapshot('');setComposeEpoch(v=>v+1);syncRoute();}
  function focusPane(key:PaneKey,keyboard=false){if(panes.current.active!==key&&panes.current.focus(key))routeChanged();if(keyboard){if(localSelected.current.has(key)){document.querySelector<HTMLElement>(`[data-pane="${key}"] .local-terminal:not([hidden]) .xterm-helper-textarea`)?.focus();}else controllers.current.get(key)?.runtime.term.focus();}}
  function cancelWorkspaceSplit(){workspaceSession.current.cancelSplit();restoredFocus.current=undefined;setWorkspaceEpoch(v=>v+1);}
  function collapseSplit(keep?:PaneKey){cancelWorkspaceSplit();panes.current.collapse(keep);routeChanged();}
  function paneSelection(key:PaneKey):PaneSelection{const slot=panes.current.slots.find(p=>p.key===key),binding=slot?.binding;
    const index=binding?liveConnections.current.findIndex(c=>c.connection_id===binding.connection_id&&c.generation===binding.generation&&c.protocol===binding.protocol):-1;
    const live=liveConnections.current[index];
    const serviceOwner=serviceRef.current?.service_id;
    const owner=serviceStopped.current||preferencesOwner.current!==serviceOwner?'':serviceOwner??'';
    const pending=firstSsh1Fit.current;
    const initialSsh1Fit=pending&&pending.owner===owner&&pending.pane===key&&pending.epoch===panes.current.epoch
      && binding?.protocol==='SSH1'&&binding.connection_id===pending.connection.connection_id&&binding.generation===pending.connection.generation
      ? { size: pending.size, take: () => {
        if(firstSsh1Fit.current!==pending)return false;
        firstSsh1Fit.current=undefined;
        return true;
      } } : undefined;
    const local=localSelected.current.has(key);
    return {owner,outputCursor:snapshotCursor(latestSnapshot.current,owner,live),connection:binding&&{...binding,state:!slot?.pending&&!slot?.retired&&live?live.state:'DISCONNECTED'},active:!local&&panes.current.active===key&&!slot?.pending&&!slot?.retired,epoch:panes.current.epoch,fixture:serviceRef.current?.fixture??false,suspended:local||!!binding&&(!!slot?.retired||!!slot?.pending||binding.connection_id===transferring.current),initialSsh1Fit};
  }
  function registerPane(key:PaneKey,c?:TerminalController){if(c)controllers.current.set(key,c);else controllers.current.delete(key);if(panes.current.active===key&&!localSelected.current.has(key)){runtime.current=c?.runtime??null;clipboard.current=c?.clipboard;composeSend.current=c?.compose;}}
  useLayoutEffect(()=>{
    if(!detached||detachedInputFocused.current||!renderedTarget)return;
    detachedInputFocused.current=true;
    runtime.current?.term.focus();
  },[renderedTarget]);
  useEffect(()=>subscribeSessionSnapshots({
    read: () => invoke<SessionSnapshot>('desktop_session_snapshot'),
    epoch: () => panes.current.epoch,
    apply(snapshot, epoch) {
      const {service:native,sessions}=snapshot;
      composeHistory.current.retain(native.service_id);
      if (!sameService(serviceRef.current, native)) {
        serviceRef.current = native;
        setService(native);
      }
      latestSnapshot.current=snapshot;
      if (!sameConnectionList(liveConnections.current, sessions)) {
        liveConnections.current = sessions;
        setConnections(sessions);
      }
      for(const [key,controller] of controllers.current){
        const route=paneSelection(key);
        if(!route.suspended&&route.owner)controller.notifyOutput(route.outputCursor);
      }
      triggers.current.validate(native.service_id,sessions);
      const beforeRetain=panes.current.epoch;
      if(panes.current.retain(native.service_id,sessions,epoch===beforeRetain)){
        if(panes.current.epoch!==beforeRetain)routeChanged();
        else syncRoute();
      }
      if(panes.current.direction==='single'&&!panes.current.current.requested){
        const first=sessions.find(c=>!tabClosures.current.isHidden(c));
        if(first){
          panes.current.select(first.connection_id);
          panes.current.retain(native.service_id,sessions);
          syncRoute();
        }
      }
    },
    failed() {
      serviceStopped.current=true;
      triggers.current.stop('服务不可用，已停用触发器');
      composeHistory.current.retain('');
      panes.current.epoch++;
      routeChanged();
      setFailure('会话服务不可用；未重连或重放输入。请退出后重新启动。');
    },
  }),[]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(!detached&&event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&event.key.toLowerCase()==='k'&&!document.querySelector('dialog:modal')){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)openQuickCommands();return;}if(event.key!=='F6'||document.querySelector('dialog:modal')||panes.current.slots.length<2)return;event.preventDefault();event.stopImmediatePropagation();const slots=panes.current.slots,index=slots.findIndex(p=>p.key===panes.current.active);focusPane(slots[(index+(event.shiftKey?slots.length-1:1))%slots.length].key,true);};window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);},[]);
  const handleDesktopShortcut=useRef<(event:KeyboardEvent)=>void>(()=>{});
  handleDesktopShortcut.current=event=>{
    const action=desktopShortcut(event);
    if(!action)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if(event.repeat||closingDesktop.current||document.querySelector('dialog:modal'))return;
    if(shortcutEditor(event.target)){
      if(action.kind==='search'&&(event.target as Element).closest('[aria-label="查找终端内容"]'))findTerminal();
      return;
    }
    const pane=panes.current.active, local=localSelected.current.get(pane);
    if(action.kind==='openLocal'){if(!detached)void openLocal(pane);return;}
    if(action.kind==='sidebar'){if(!detached&&shortcutSource(pane))toggleAdbFromKeyboard(pane);return;}
    if(action.kind==='search'){findTerminal();return;}
    if(action.kind!=='cycle'&&action.kind!=='index')return;
    // This is the published tab order, including the effects of groups and drag/drop.
    const rail=document.querySelector(`[data-pane="${pane}"] .pane-tab-bar [role="tablist"]`);
    const buttons=Array.from(rail?.querySelectorAll<HTMLButtonElement>('[role="tab"][data-connection-id]:not([hidden])')??[]);
    if(!buttons.length)return;
    const current=buttons.findIndex(button=>button.getAttribute('aria-selected')==='true');
    const index=action.kind==='index'?action.index
      :current<0?(action.step>0?0:buttons.length-1):(current+action.step+buttons.length)%buttons.length;
    const id=buttons[index]?.dataset.connectionId;
    if(!id)return;
    if(liveLocalTabs.current.some(tab=>tab.id===id&&panes.current.paneOf(tab.id)===pane)){
      if(closingLocal.current.has(id))return;
      if(local!==id)selectLocal(pane,id);
      else focusPane(pane,true);
      return;
    }
    const target=liveConnections.current.find(item=>item.connection_id===id&&panes.current.paneOf(id)===pane);
    if(!target||tabClosures.current.pending(target))return;
    if(index===current){focusPane(pane,true);return;}
    selectConnection(id,target);
    focusRenderedTerminal(target);
    controllers.current.get(pane)?.wakeOutput();
  };
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>handleDesktopShortcut.current(event);
    window.addEventListener('keydown',key,true);
    return()=>window.removeEventListener('keydown',key,true);
  },[]);

  useEffect(() => {
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.terminalFont = terminalFont;
      document.documentElement.dataset.terminalPalette = preferences.terminal_palette;
      for(const c of controllers.current.values())c.appearance();
    };
    apply();
    systemTheme.addEventListener('change', apply);
    return () => systemTheme.removeEventListener('change', apply);
  }, [theme, terminalFont, preferences.terminal_palette]);

  useEffect(() => {for(const c of controllers.current.values())c.appearance();}, [fontSize]);

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

  const tabs = tabGroups.current.order([...connections.filter(item => !tabClosures.current.isHidden(item))].sort((a, b) => {
    const rank = (id: string) => tabOrder.includes(id) ? tabOrder.indexOf(id) : tabOrder.length + connections.findIndex(item => item.connection_id === id);
    return rank(a.connection_id) - rank(b.connection_id);
  }));
  const paneSlots=panes.current.slots;
  const localIds=localTabs.map(tab=>tab.id);
  const drag=useSessionDrag([...tabs,...localIds.map(localDragSource)],service?.service_id??'',dropTab,detached);
  const visibleIds=[...tabs.map(tab=>tab.connection_id),...localIds];
  const orderedIds=[...tabOrder.filter(id=>visibleIds.includes(id)),...visibleIds.filter(id=>!tabOrder.includes(id))];
  const dockDragging=detached&&drag.preview?.destination?.kind==='detach';
  useEffect(()=>{
    if(!dockDragging)return;
    const preview=()=>{void invoke('preview_session_dock',{active:true}).catch(()=>{});};
    preview();
    const timer=window.setInterval(preview,100);
    return()=>{clearInterval(timer);void invoke('preview_session_dock',{active:false}).catch(()=>{});};
  },[dockDragging]);
  useEffect(()=>{
    if(detached)return;
    let timeout=0;
    const unlisten=appWindow.listen<boolean>('session-dock-hover',event=>{
      setDockHover(event.payload);
      clearTimeout(timeout);
      if(event.payload)timeout=window.setTimeout(()=>setDockHover(false),350);
    });
    return()=>{clearTimeout(timeout);void unlisten.then(stop=>stop());};
  },[]);
  const paneBinding=panes.current.current.binding;
  const localActive=localSelected.current.has(panes.current.active);
  const active = !localActive&&!panes.current.current.pending&&!panes.current.current.retired?connections.find(item => item.connection_id === paneBinding?.connection_id&&item.generation===paneBinding.generation&&item.protocol===paneBinding.protocol):undefined;
  const currentWorkspace=workspaceSession.current.layout;
  const pendingWorkspaceTabs=currentWorkspace?.tabs.filter(t=>{const ref=workspaceSession.current.binding(t.id),live=ref&&connections.find(c=>c.connection_id===ref.connection_id);return !live||['FAILED','DISCONNECTED'].includes(live.state);})??[];
  const activeDetails = active && catalog.current.get(active);
  const logOwner=serviceStopped.current?'':service?.service_id??'';
  const logDirectory=useOpenLogDirectory();
  const recordingNotices=useRecordingNotices(logOwner,logDirectory.openForNotice);
  const tabLogs=useTabLogging(logOwner,tabs,active,target=>!serviceStopped.current&&serviceRef.current?.service_id===target.service_id&&
    transferring.current!==target.connection.connection_id&&liveConnections.current.some(c=>c.protocol===target.protocol&&
      c.connection_id===target.connection.connection_id&&c.generation===target.connection.generation),tabName,recordingNotices.notify);
  const activeLogSummary=active?tabLogs.summary(active):undefined;
  const activeLog=active?activeLogSummary?.text??'正在查询本次日志状态':'尚无活动连接';
  const activeLogBadge=logBadge(activeLogSummary);
  const inputReady = !!active && active.state === 'CONNECTED' && renderedTarget?.connection_id === active.connection_id && renderedTarget.generation === active.generation && !failure && !inputFailure;
  const statusAttention=failure||inputFailure||decodeWarning||
    (['服务输出已同步','服务就绪 · 尚无活动连接','正在连接会话服务'].includes(status)?'':status)||
    (activeLogBadge==='状态未知'||activeLogBadge==='记录失败'?activeLog:'');
  const profileName = (connection: Connection) => {
    const details = catalog.current.get(connection);
    const profile = details && profiles.find(item => item.id === details.profile_id && item.settings.protocol.toUpperCase() === connection.protocol);
    return details?.target_label ?? profile?.name;
  };
  function tabName(connection: Connection) {
    return connection.protocol==='SSH2'||connection.protocol==='SSH1'
      ? catalog.current.get(connection)?.host??'正在读取地址'
      : connection.protocol==='SERIAL'?catalog.current.get(connection)?.target_label??'正在读取端口':'合成终端';
  }
  const connectionLabel = (connection: Connection) => profileName(connection) ? `${profileName(connection)} · ${connection.protocol}` : tabName(connection);
  function moveTab(offset: number) {
    const peers=paneTabs(panes.current.active);
    const index=peers.findIndex(tab=>tab.connection_id===selected);
    if(!canMoveTab(offset))return;
    dropTab(peers[index],{kind:'insert',anchor:peers[index+offset].connection_id,after:offset>0});
  }
  function paneTabs(key:PaneKey){return tabs.filter(tab=>panes.current.paneOf(tab.connection_id)===key);}
  function tabInsertion(id:string,anchor:string,after:boolean){
    const order=orderedIds.filter(other=>other!==id);
    const index=order.indexOf(anchor);
    if(index<0)return;
    order.splice(index+(after?1:0),0,id);
    return order;
  }
  function insertTab(id:string,anchor:string,after:boolean){
    const order=tabInsertion(id,anchor,after);
    if(order)setTabOrder(order);
  }
  function localPeers(pane:PaneKey,except:string){
    return liveLocalTabs.current.filter(tab=>tab.id!==except&&panes.current.paneOf(tab.id)===pane&&!closingLocal.current.has(tab.id));
  }
  function dropLocal(id:string,destination:TabDrop){
    if(closingLocal.current.has(id)||!localIds.includes(id)||destination.kind==='detach')return;
    const layout=panes.current;
    const origin=layout.paneOf(id);
    const peers=localPeers(origin,id);
    const sourceHasPeers=!!(paneTabs(origin).length||peers.length);
    let target=origin;
    if(destination.kind==='insert'){
      const order=tabInsertion(id,destination.anchor,destination.after);
      if(!order)return;
      target=layout.paneOf(destination.anchor);
      if(!layout.hasPane(target))return;
      setTabOrder(order);
    }else{
      target=destination.pane;
      if(!layout.hasPane(target))return;
      if(destination.kind==='split'){
        const added=layout.splitLocalDrop(id,target,destination.edge,sourceHasPeers);
        if(!added)return;
        if(added==='full'){setTabMessage('已达到四窗格上限。');return;}
        target=added;
      }
    }
    if(origin!==target){
      if(localSelected.current.get(origin)===id){
        if(peers.length)localSelected.current.set(origin,peers[0].id);
        else localSelected.current.delete(origin);
      }
      layout.moveLocalDrop(id,target,sourceHasPeers);
    }
    cancelWorkspaceSplit();
    selectLocal(target,id);
    requestAnimationFrame(()=>{if(panes.current.active===target&&localSelected.current.get(target)===id)focusPane(target,true);});
  }
  function dropTab(source:Connection,destination:TabDrop,expectedOwner?:string) {
    if(source.protocol==='LOCAL'){dropLocal(source.connection_id,destination);return;}
    const owner=serviceRef.current?.service_id;
    const live=liveConnections.current.find(c=>c.connection_id===source.connection_id&&c.generation===source.generation&&c.protocol===source.protocol);
    if(!owner||expectedOwner!==undefined&&owner!==expectedOwner||!live||serviceStopped.current)return;
    const id=live.connection_id;
    if(detached){
      if(destination.kind==='detach')void dockSession(owner,live);
      return;
    }
    if(destination.kind==='group'){
      if(!panes.current.hasPane(destination.pane))return;
      if(assignTab(live,destination.group))mergeTab(live,destination.pane);
      return;
    }
    if(destination.kind==='insert'){
      const order=tabInsertion(id,destination.anchor,destination.after);
      const target=panes.current.paneOf(destination.anchor);
      if(!order||!panes.current.hasPane(target))return;
      if(!localIds.includes(destination.anchor)){
        const group=tabGroups.current.groupOf(destination.anchor);
        if(tabGroups.current.groupOf(id)!==group&&!assignTab(live,group))return;
      }
      setTabOrder(order);
      mergeTab(live,target);
      return;
    }
    if(destination.kind==='detach'){void openSessionWindow(owner,live);return;}
    if(destination.kind==='merge'){mergeTab(live,destination.pane);return;}
    const layout=panes.current;
    if(localSelected.current.has(destination.pane)){
      const origin=layout.paneOf(id);
      const next=layout.splitDropBesideLocal(live,destination.pane,destination.edge,tabs,localPeers(origin,'').map(tab=>tab.id));
      if(next==='full')setTabMessage('已达到四窗格上限。');
      else if(next===origin){layout.focus(next);selectConnection(id,live);}
      else if(next)mergeTab(live,next);
      else setTabMessage('分屏需要两个仍在连接的 SSH2 或串口会话。');
      return;
    }
    const visible=tabs.flatMap(tab=>{
      const current=liveConnections.current.find(candidate=>candidate.connection_id===tab.connection_id&&candidate.generation===tab.generation&&candidate.protocol===tab.protocol);
      return current?[current]:[];
    });
    const split=layout.splitRemoteDrop(owner,destination.pane,live,destination.edge,visible,localIds);
    if(split==='missing-peer'){
      setTabMessage('分屏需要两个仍在连接的 SSH2 或串口会话。');
      return;
    }
    if(!split){setTabMessage('会话已变化，未创建分屏。');return;}
    cancelWorkspaceSplit();
    routeChanged();
    if(layout.current.binding)focusRenderedTerminal(layout.current.binding);
  }
  function mergeTab(source:Connection,destination:PaneKey){
    if(!panes.current.hasPane(destination))return;
    if(panes.current.move(source,destination,tabs,localIds)){
      cancelWorkspaceSplit();
      panes.current.focus(destination);
      selectConnection(source.connection_id,source);
    }
  }
  function assignTab(target:Ref&{protocol:string},group:string){
    try{
      tabGroups.current.assign(serviceRef.current?.service_id??'',target,group);
      setGroupEpoch(value=>value+1);
      return true;
    }catch(error){setTabMessage(error instanceof Error?error.message:'标签移动未完成。');return false;}
  }
  async function dockSession(owner:string, connection:Connection){
    if(transferring.current)return;
    transferring.current=connection.connection_id;
    try{
      await invoke('dock_session',{serviceId:owner,connection:{connection_id:connection.connection_id,generation:connection.generation}});
    }catch{
      setTabMessage('拖到主窗口的可见区域，松开即可移回。');
    }finally{transferring.current=undefined;}
  }
  async function openSessionWindow(owner:string, connection:Connection){
    if(transferring.current)return;
    if(connection.state!=='CONNECTED'||!['SSH1','SSH2','SERIAL'].includes(connection.protocol)){
      setTabMessage('此会话当前无法移到独立窗口。');
      return;
    }
    transferring.current=connection.connection_id;
    for(const pane of panes.current.slots)if(pane.binding?.connection_id===connection.connection_id)controllers.current.get(pane.key)?.invalidate();
    try {
      await invoke('detach_session',{serviceId:owner,connection:{connection_id:connection.connection_id,generation:connection.generation}});
      if(serviceRef.current?.service_id!==owner)return;
      liveConnections.current=liveConnections.current.filter(item=>item.connection_id!==connection.connection_id);
      setConnections(liveConnections.current);
      cancelWorkspaceSplit();
      if(panes.current.remove(connection,tabs,localIds))routeChanged();
    } catch {
      setTabMessage('没有打开独立窗口，会话仍在主窗口。');
    } finally {
      transferring.current=undefined;
    }
  }
  function hideTab(connection: Connection) {
    if(!tabClosures.current.hide(connection))return;setTabEpoch(value=>value+1);
    if(panes.current.remove(connection,tabs,localIds))routeChanged();
  }
  async function closeTab(target:Connection) {
    const decision=tabClosures.current.begin(target,liveConnections.current);
    if(decision==='stale'){setTabMessage('连接代次已变化；未关闭新连接。');return;}
    if(decision==='pending')return;
    if(decision==='unknown'){setTabMessage('关闭结果尚未确认，未重复发送。请在连接面板核对当前状态。');return;}
    workspaceSession.current.cancelSplitFor(target);restoredFocus.current=undefined;setWorkspaceEpoch(v=>v+1);
    if(decision==='hide'){hideTab(target);setTabMessage('已结束的会话标签已关闭。');return;}
    const feedback=++tabCloseFeedback.current;
    const progress='正在关闭会话…';
    const finishFeedback=(message:string)=>setTabMessage(previous=>feedback===tabCloseFeedback.current&&previous===progress?message:previous);
    setTabEpoch(value=>value+1);setTabMessage(progress);
    try {
      if (target.protocol === 'SSH2') await ssh({ op: 'close', connection: { connection_id: target.connection_id, generation: target.generation } });
      else if (target.protocol === 'SSH1') await disconnectSsh1({ connection_id: target.connection_id, generation: target.generation });
      else if (target.protocol === 'SERIAL') await serial({ op: 'close', connection: { connection_id: target.connection_id, generation: target.generation } });
      else throw new Error('此连接请使用对应控制面板关闭。');
      tabClosures.current.finish(target,'accepted');hideTab(target);finishFeedback('关闭请求已提交；只关闭原代次标签，实际连接状态以服务为准。');
    } catch (error) { tabClosures.current.finish(target,'unknown');finishFeedback((error instanceof Error?error.message:'关闭未获确认。') + ' 结果可能未知，未自动重试；请在连接面板核对实际状态。'); }
    finally { setTabEpoch(value=>value+1); }
  }
  function connectProfile(profile: Profile,slot?:string,configRevision?:string) {
    if (savedIntentFlight.current||ssh1Flight.current) return;
    if(!slot)cancelWorkspaceSplit();
    if(slot&&workspaceSession.current.layout?.tabs.find(t=>t.id===slot)?.profile_id!==profile.id){setTabMessage('布局配置引用已变化，请重新打开布局。');return;}
    workspaceLaunch.current=undefined;
    setRequestedProfile(profile);
    if (profile.settings.protocol === 'serial') {const nonce=crypto.randomUUID();setSerialNonce(nonce);if(slot)workspaceLaunch.current={slot,nonce,owner:service?.service_id??'',protocol:'SERIAL'};setSerialDialog(true); return; }
    if (profile.settings.protocol === 'ssh1') {
      const owner = serviceRef.current;
      if (slot || !configRevision || !owner?.ssh1_preview || !profile.settings.explicitly_enabled) {
        setTabMessage('启用 SSH1 的本机预览可从会话树连接已保存的 SSH1 配置。');
        return;
      }
      ssh1Flight.current=true;
      setSshOpen(false);
      setSsh1Intent({profile:{...profile,settings:{...profile.settings}},revision:configRevision,request_id:requestId(),owner:owner.service_id});
      return;
    }
    const intent={profile_id:profile.id,request_id:requestId()};savedIntentFlight.current=intent;setSavedIntent(intent);setSshOpen(false);setQuickOpen(true);setTabMessage(`正在连接 ${profile.name}…`);
    if(slot)workspaceLaunch.current={slot,nonce:intent.request_id,owner:service?.service_id??'',protocol:'SSH2'};
  }
  async function prepareSsh1Reconnect() {
    if (!active || active.protocol !== 'SSH1' || !['DISCONNECTED', 'FAILED'].includes(active.state)
      || !activeDetails?.profile_id || !serviceRef.current?.ssh1_preview || serviceStopped.current
      || ssh1Flight.current || savedIntentFlight.current || quickOpen || serialDialog) return;
    const owner = serviceRef.current.service_id;
    const previous = { connection_id: active.connection_id, generation: active.generation };
    const epoch = panes.current.epoch;
    const profileId = activeDetails.profile_id;
    const stillSelected = () => !serviceStopped.current && serviceRef.current?.service_id === owner
      && panes.current.epoch === epoch && selectedRef.current === previous.connection_id
      && liveConnections.current.some(c => c.protocol === 'SSH1' && c.connection_id === previous.connection_id
        && c.generation === previous.generation && ['DISCONNECTED', 'FAILED'].includes(c.state));
    ssh1Flight.current = true;
    let prepared = false;
    try {
      const snapshot = await readConfiguration();
      if (!stillSelected()) return;
      const profile = snapshot.profiles.find(p => p.id === profileId);
      if (profile?.settings.protocol !== 'ssh1' || !profile.settings.explicitly_enabled) {
        setTabMessage('原保存配置已删除、改变协议或停用 SSH1，未重连。');
        return;
      }
      setTabMessage('');
      setSsh1Intent({ profile: { ...profile, settings: { ...profile.settings } }, revision: snapshot.revision,
        owner, request_id: requestId(), previous });
      prepared = true;
    } catch {
      if (stillSelected()) setTabMessage('无法读取原 SSH1 保存配置，未重连。');
    } finally {
      if (!prepared) ssh1Flight.current = false;
    }
  }
  function closeSerial(connected=false){if(!finishCopyDialog(connected))return;if(workspaceLaunch.current?.protocol==='SERIAL')workspaceLaunch.current=undefined;setSerialDialog(false);setCopySource(undefined);setCopyTarget(undefined);}
  function finishWorkspace(connection:Ref,profileId:string,protocol:'SSH2'|'SERIAL',nonce:string){const pending=workspaceLaunch.current;if(!pending||pending.protocol!==protocol||pending.nonce!==nonce)return;
    const target={...connection,protocol,state:'CONNECTED'};if(pending.owner===service?.service_id&&workspaceSession.current.bind(pending.owner,pending.slot,profileId,target)){workspacePlacements.current.set(pending.slot,{owner:pending.owner,connection:target});setWorkspaceEpoch(v=>v+1);}else {cancelWorkspaceSplit();setTabMessage('本次参数或布局已改变，连接作为独立会话保留，布局引用未改变。');}workspaceLaunch.current=undefined;
  }
  function openWorkspace(workspace:Workspace,available:Profile[]){try{collapseSplit();workspacePlacements.current.clear();tabGroups.current.replace(workspace.groups);workspaceSession.current.open(workspace,service?.service_id??'',liveConnections.current);setProfiles(available);setSidebarOpen(workspace.navigation_open);setWorkspaceEpoch(v=>v+1);setGroupEpoch(v=>v+1);setTabMessage('布局已打开，待连接项需明确连接；当前会话保留，没有自动登录或发送。');}catch{setTabMessage('布局无法打开，原连接保持。');}}
  function captureCurrentWorkspace(name:string,available:Profile[]){const layout=panes.current.slots;const view=panes.current.direction==='single'?undefined:{direction:panes.current.direction,connections:panes.current.owner===serviceRef.current?.service_id?layout.filter(p=>p.binding&&!p.pending&&!p.retired).map(p=>p.binding!):[]};return captureWorkspace(name,tabs.filter(c=>c.protocol!=='SSH1').map(c=>({...c,profile_id:catalog.current.get(c)?.profile_id})),available,tabGroups.current.list(),id=>tabGroups.current.groupOf(id),panes.current.current.requested,sidebarOpen,view);}


  function quickContext():QuickContext|undefined {const slot=panes.current.current,binding=slot.binding,owner=serviceRef.current?.service_id;if(!owner||serviceStopped.current||slot.pending||slot.retired||!binding)return;
    const live=liveConnections.current.find(c=>c.connection_id===binding.connection_id&&c.generation===binding.generation&&c.protocol===binding.protocol&&c.state==='CONNECTED');const c=controllers.current.get(slot.key),view=paneViews[slot.key];
    if(!live||!c?.runtime.writable||view?.failure||view?.inputFailure||view?.renderedTarget?.connection_id!==live.connection_id||view.renderedTarget.generation!==live.generation||c.runtime.connection?.connection_id!==live.connection_id||c.runtime.connection.generation!==live.generation||!['SSH2','SERIAL','FIXTURE'].includes(live.protocol))return;
    return {owner,pane:slot.key,epoch:panes.current.epoch,target:{connection_id:live.connection_id,generation:live.generation,protocol:live.protocol},draftVersion:drafts.current.revision};
  }
  function openQuickCommands(){drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setQuickCommandsOpen(true);}
  function prepareQuickDraft(context:QuickContext,text:string,ending:Ending,replace:boolean,name:string){const now=quickContext();if(!sameQuickContext(context,now)||drafts.current.get(context.target)&&!replace)return false;try{drafts.current.edit(context.target,text);}catch{return false;}setComposeEnding(ending);setComposeOrigin(name);setComposeEpoch(v=>v+1);setComposeOpen(true);setQuickCommandsOpen(false);return true;}
  const commandContext=quickContext();

  function canMoveTab(offset: number) {
    const peers=paneTabs(panes.current.active);
    const index=peers.findIndex(tab=>tab.connection_id===selected);
    const neighbor=peers[index+offset];
    return index>=0&&!!neighbor&&tabGroups.current.groupOf(selected)===tabGroups.current.groupOf(neighbor.connection_id);
  }
  function preparePaneConnection(key:PaneKey, button:HTMLButtonElement) {
    focusPane(key);
    connectionEntry.current=button.closest("details")?.querySelector("summary")??null;
    const owner=serviceRef.current?.service_id;
    if(owner)paneLaunch.current={key,owner};
  }
  function connectNewProfile(profile:Profile){
    const route=configurationCreation;
    if(!route||creationRoute.current!==route)return;
    creationRoute.current=undefined;
    if(!route.owner||route.owner!==serviceRef.current?.service_id||serviceStopped.current
      ||quickOpen||serialDialog||savedIntentFlight.current||ssh1Flight.current
      ||!panes.current.slots.some(slot=>slot.key===route.key)){
      setTabMessage('配置已保存。连接条件已变化，请从会话树连接。');
      return;
    }
    focusPane(route.key);
    paneLaunch.current={key:route.key,owner:route.owner};
    connectProfile(profile);
  }
  function copyDialogBusy(){
    return quickOpen||serialDialog||savedIntentFlight.current||ssh1Flight.current||!!document.querySelector('dialog:modal');
  }
  function finishCopyDialog(connected:boolean){
    const route=copySource?.route;
    if(!route)return true;
    if(!sessionCopy.current.close(route,connected))return false;
    if(paneLaunch.current===route)paneLaunch.current=undefined;
    return true;
  }
  function copyStillCurrent(launch:CopyRoute){
    const {source}=launch;
    return copyRouteCurrent(launch,serviceStopped.current?undefined:serviceRef.current?.service_id,
      panes.current,liveConnections.current,!tabClosures.current.isHidden(source)&&!tabClosures.current.pending(source)
        &&transferring.current!==source.connection_id);
  }
  function beginCopy(read:CopyRead,source:CopySource){
    if(copyDialogBusy()||read.owner!==source.owner||!copyStillCurrent({...read,source:source.connection}))return false;
    if(source.settings.protocol!=='ssh2'&&source.settings.protocol!=='serial')return false;
    const launch=sessionCopy.current.open(read,source.connection);
    if(!launch)return false;
    workspaceLaunch.current=undefined;
    paneLaunch.current=launch;
    connectionEntry.current=Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find(tab=>tab.dataset.connectionId===source.connection.connection_id)??null;
    setCopySource({...source,route:launch});setCopyTarget(undefined);setRequestedProfile(undefined);
    setTabMessage('');
    if(source.settings.protocol==='ssh2'){
      const intent=source.saved_profile?{profile_id:source.saved_profile,request_id:requestId()}:undefined;
      savedIntentFlight.current=intent;setSavedIntent(intent);setSshOpen(false);setQuickOpen(true);
    }else{
      setSerialNonce(crypto.randomUUID());setSerialDialog(true);
    }
    return true;
  }
  async function copyTab(key:PaneKey,source:Connection,owner:string){
    const launch={key,owner,source};
    if(copyDialogBusy()||!copyStillCurrent(launch)||!sessionCopy.current.startRead(launch))return;
    try{
      const connection={connection_id:source.connection_id,generation:source.generation};
      if(detached){
        await invoke('request_detached_copy',{serviceId:owner,connection});
        return;
      }
      if(!['SSH2','SERIAL'].includes(source.protocol))return;
      const request={op:'status' as const,connection};
      const status=source.protocol==='SSH2'?await ssh(request):await serial(request);
      if(status.result!=='status'||!sameRef(status.connection,source)||status.connection.protocol!==source.protocol
        ||status.connection.state!=='CONNECTED'||!status.source_settings||status.source_settings.protocol.toUpperCase()!==source.protocol)
        throw new Error('STALE_COPY_SOURCE');
      const profile='temporary_settings' in status&&!status.temporary_settings?status.profile_id:null;
      if(!beginCopy(launch,{owner,connection:source,settings:status.source_settings,saved_profile:profile}))
        setTabMessage('原会话或窗格已变化，请重新选择要复制的标签。');
    }catch{
      if(serviceRef.current?.service_id===owner)setTabMessage('未能读取原会话或打开连接窗口，请核对会话是否仍在连接。');
    }finally{sessionCopy.current.finishRead(launch);}
  }
  const receiveCopy=useRef<(id:string)=>void>(()=>{});
  receiveCopy.current=id=>{
    if(sessionCopy.current.isReadingDetached(id))return;
    const read={key:panes.current.active,owner:serviceRef.current?.service_id??'',detachedId:id};
    const reserved=!copyDialogBusy()&&sessionCopy.current.startRead(read);
    void invoke<CopySource>('take_detached_copy',{id}).then(source=>{
      if(read.owner===serviceRef.current?.service_id&&(!reserved||!beginCopy(read,source)))
        setTabMessage('无法从独立窗口复制会话，请先收起当前连接对话框再试。');
    }).catch(()=>{
      if(read.owner===serviceRef.current?.service_id)setTabMessage('独立窗口的原会话已变化，请重新选择复制。');
    }).finally(()=>sessionCopy.current.finishRead(read));
  };
  useEffect(()=>{
    if(detached)return;
    const stop=appWindow.listen<string>('detached-session-copy',event=>receiveCopy.current(event.payload));
    return()=>{void stop.then(unlisten=>unlisten()).catch(()=>{});};
  },[]);
  function canStartCopy(){const launch=copySource?.route;return !!launch&&sessionCopy.current.owns(launch)&&copyStillCurrent(launch);}
  function selectNewConnection(id:string,expected?:Ref,copy?:CopyRoute){
    const launch=paneLaunch.current;
    if(launch&&launch.owner!==serviceRef.current?.service_id)return;
    if(copy){
      if(launch!==copy||!expected||id!==expected.connection_id||!sessionCopy.current.acceptResult(copy,expected))return;
      setCopyTarget(expected);
      if(!copyStillCurrent(copy))return;
    }
    if(launch&&!panes.current.focus(launch.key))return;
    selectConnection(id,expected);
  }
  function newSsh() {
    workspaceLaunch.current=undefined;
    setSshOpen(false);
    setQuickOpen(true);
  }
  function newSerial() {
    workspaceLaunch.current=undefined;
    setSerialNonce(crypto.randomUUID());
    setRequestedProfile(undefined);
    setSerialDialog(true);
  }
  function openTopLog(anchor: HTMLButtonElement) {
    if(terminalMenu?.anchor===anchor){setTerminalMenu(undefined);return;}
    if(!active)return;
    const pane=panes.current.active;
    const value=controllers.current.get(pane)?.captureMenu(anchor,0,0);
    if(value)setTerminalMenu({...value,pane,title:tabName(active)});
  }
  function restoreConnectEntry(copy?:CopyRoute) {
    if(copy&&paneLaunch.current&&paneLaunch.current!==copy)return;
    paneLaunch.current=undefined;
    if(document.activeElement===document.body)connectionEntry.current?.focus();
  }
  function toggleSidebar() {
    const open = !sidebarOpen;
    setSidebarOpen(open);
    try { localStorage.setItem('navigation-open', String(open)); } catch { /* this window still retains the choice */ }
  }
  function resizeNavigation(width: number) {
    setNavigationWidth(Math.max(210, Math.min(360, width)));
  }

  const brightness=preferences.terminal_text_brightness??100;
  return <main className="desktop-shell" data-terminal-dim={brightness<100?'true':undefined}
    style={{ '--navigation-width': `${navigationWidth}px`, '--terminal-text-brightness': `${brightness}%` } as CSSProperties}>
    <WindowChrome detached={detached} leading={!detached&&<button type="button" className="sidebar-toggle"
      aria-label="会话导航" title="显示或收起连接库" aria-expanded={sidebarOpen} aria-controls="connection-library"
      onClick={toggleSidebar}><span className="sidebar-glyph" aria-hidden="true"/></button>}>
    <nav className="app-bar" aria-label="会话控制">
      <button type="button" className="toolbar-log" aria-haspopup="menu" aria-expanded={!!terminalMenu&&terminalMenu.anchor.matches('.toolbar-log')}
        aria-description={activeLog} title={activeLog} data-log-phase={activeLogSummary?.unknown?'UNKNOWN':activeLogSummary?.phase}
        disabled={!active||renderedTarget?.connection_id!==active.connection_id||renderedTarget.generation!==active.generation||!['SSH2','SERIAL'].includes(active.protocol)}
        onClick={event=>openTopLog(event.currentTarget)}>
        日志<span className="log-chevron" aria-hidden="true"/>
      </button>
      <button type="button" className="toolbar-log-directory" aria-label="打开日志目录" title="打开日志目录" onClick={()=>void logDirectory.open()}>
        <span className="log-folder-glyph" aria-hidden="true"/>
      </button>
      {!detached&&<ToolbarMenu summary={toolsSummary} className="tools-menu" label="更多工具" text={<>
        <span className="tools-trigger-label">更多工具</span><span className="tools-glyph" aria-hidden="true"/>
      </>}>
        <section className="toolbar-group" aria-label="会话与终端">
          <h3>会话与终端</h3>
          <button disabled={localActive} onClick={() => setLoggingOpen(open => !open)}>终端日志</button>
          <button disabled={!localActive&&!active} aria-keyshortcuts="Control+Shift+F" data-shortcut="Ctrl+Shift+F" title="Ctrl+Shift+F" onClick={findTerminal}>查找终端</button>
          {paneSlots.length>1&&<button onClick={()=>collapseSplit()}>收起分屏，保留连接</button>}
        </section>
        <section className="toolbar-group" aria-label="连接与布局">
          <h3>连接与布局</h3>
          <button onClick={() => {toolsReturnDialog.current='configuration';setConfigurationTarget(undefined);setConfigurationOpen(true);}}>连接配置</button>
          <button onClick={() => setSshOpen(open => !open)}>SSH2 连接</button>
          <button onClick={() => setSerialOpen(open=>!open)}>串口高级工具</button>
          <button disabled={!service} onClick={()=>{toolsReturnDialog.current='workspace';setWorkspaceOpen(true);}}>工作区</button>
          <button onClick={()=>setGroupsOpen(true)}>标签分组</button>
          <button disabled={!canMoveTab(-1)} onClick={()=>moveTab(-1)}>标签左移</button>
          <button disabled={!canMoveTab(1)} onClick={()=>moveTab(1)}>标签右移</button>
          <button onClick={()=>{toolsReturnDialog.current='batchConfig';setBatchConfigOpen(true);}}>批量修改配置</button>
          <button onClick={()=>setImportConfigOpen(true)}>导入原生配置</button>
        </section>
        <section className="toolbar-group" aria-label="命令与自动化">
          <h3>命令与自动化</h3>
          <button onClick={openQuickCommands}>常用命令</button>
          <button onClick={()=>void openLocal(panes.current.active,false)}>轻量命令行</button>
          <button onClick={() => { drafts.current.invalidate();setComposeEnding('none');setComposeOrigin(undefined); setComposeOpen(open => !open); }}>基础撰写</button>
          <button onClick={()=>{drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setBroadcastSeed(undefined);setBroadcastOpen(true);}}>多目标发送</button>
          <button onClick={()=>{drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setContinuousOpen(true);}}>连续同步键盘</button>
          <button onClick={()=>setTriggersOpen(true)}>窗口触发器</button>
          <button onClick={() => setExecOpen(open => !open)}>exec 任务</button>
          <button onClick={() => setAgentOpen(open => !open)}>Agent 授权</button>
        </section>
        <section className="toolbar-group" aria-label="设置">
          <button onClick={() => {toolsReturnDialog.current='settings';setSoftwareSettingsOpen(true);}}>软件设置</button>
          <button onClick={()=>setShortcutHelp(true)}>键盘快捷键</button>
        </section>
        <section className="toolbar-group" aria-label="诊断与退出">
          <h3>诊断与退出</h3>
          <details className="diagnostic-menu"><summary>诊断</summary><button onClick={capture}>屏幕快照</button><button disabled={!selected} onClick={() => void captureServiceScreen()}>服务端屏幕</button></details>
          <button onClick={()=>{toolsReturnDialog.current='closeInfo';setCloseInfoOpen(true);}}>上次关闭信息</button>
          <button onClick={()=>{toolsReturnDialog.current='saveRecovery';setSaveRecoveryOpen(true);}}>另存保全信息</button>
          {service?.fixture && <><button disabled={busy || !!failure} onClick={() => void createFixture()}>新建合成会话</button><button disabled={busy || !selected || !!failure} onClick={() => void stress()}>高输出回放</button><button onClick={() => { stopped.current = true; }}>停止后续回放</button></>}
          <button className="toolbar-exit" onClick={() => void getCurrentWindow().close()}>退出桌面</button>
        </section>
      </ToolbarMenu>}
      {detached&&<button onClick={()=>void appWindow.close()}>移回主窗口</button>}
    </nav>
    </WindowChrome>
    <div className={`desktop-body${sidebarOpen&&!detached ? '' : ' sidebar-hidden'}`}>
    {!detached&&<aside id="connection-library" className="session-sidebar" aria-label="会话导航"><SessionTree connecting={!!savedIntent||!!ssh1Intent} ssh1Preview={!!service?.ssh1_preview&&!serviceStopped.current&&!serviceFailure} revision={treeRevision} loaded={setProfiles} connect={(profile,revision) => connectProfile(profile,undefined,revision)} configure={id => {setConfigurationTarget(id);setConfigurationOpen(true);}}
      create={(protocol,folder)=>{const route={protocol,folder,key:panes.current.active,owner:serviceRef.current?.service_id??''}; creationRoute.current=route;setConfigurationTarget(undefined);setConfigurationCreation(route);setConfigurationOpen(true);}} />
      <div className="sidebar-divider" role="separator" aria-label="导航宽度" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={360} aria-valuenow={navigationWidth} tabIndex={0}
        onPointerDown={event=>{if(event.button===0)event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))resizeNavigation(event.clientX-event.currentTarget.parentElement!.getBoundingClientRect().left);}}
        onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resizeNavigation(navigationWidth+(event.key==='ArrowLeft'?-10:10));}}}/>
    </aside>}
    <section className="terminal-workspace" aria-label="终端工作区">
    <TerminalLogMenu claimRecording={tabLogs.claim} recordingLocked={tabLogs.locked}
      notifyStopped={recordingNotices.notify} completedLogId={recordingNotices.notice?.id} openDirectory={logDirectory.open}
      paneLabel={paneSlots.length===1?'终端':paneSlots.length===2
        ?(panes.current.direction==='horizontal'?['左窗格','右窗格']:['上窗格','下窗格'])[terminalMenu?.pane===paneSlots[0].key?0:1]
        :'窗格 '+(paneSlots.findIndex(slot=>slot.key===terminalMenu?.pane)+1)}
      focus={t=>controllers.current.get(t.pane)?.runtime.term.focus()} menu={terminalMenu} close={()=>setTerminalMenu(undefined)} owner={serviceStopped.current?'':service?.service_id??''} valid={(t:Pick<RememberedLogTask,'target'|'pane'|'epoch'>)=>{const now=paneSelection(t.pane);return !now.suspended&&now.active&&now.owner===t.target.service_id&&now.epoch===t.epoch&&now.connection?.connection_id===t.target.connection.connection_id&&now.connection.generation===t.target.connection.generation&&now.connection.protocol===t.target.protocol;}} resume={t=>{const pane=panes.current.active,now=paneSelection(pane);return !now.suspended&&now.active&&now.owner===t.target.service_id&&now.connection?.connection_id===t.target.connection.connection_id&&now.connection.generation===t.target.connection.generation&&now.connection.protocol===t.target.protocol?{pane,epoch:now.epoch}:undefined;}} copy={c=>{void controllers.current.get(c.pane)?.clipboard.copy();}} paste={c=>{void controllers.current.get(c.pane)?.clipboard.paste();}}/>
    {currentWorkspace&&<div className="workspace-strip" aria-label="打开的工作区布局"><span>{currentWorkspace.name} · 待连接 {pendingWorkspaceTabs.length} 项</span>{currentWorkspace.split&&<><small aria-label="分屏恢复状态">{currentWorkspace.split.direction==='horizontal'?'左右':'上下'}分屏 · {workspaceSession.current.splitState==='pending'?'等待两个指定连接项就绪':workspaceSession.current.splitState==='applied'?'本次已恢复':'本次恢复已取消，可手动分屏或重新打开布局'}</small>{workspaceSession.current.splitState==='pending'&&<button onClick={cancelWorkspaceSplit}>取消分屏恢复</button>}</>}{pendingWorkspaceTabs.map(slot=>{const binding=workspaceSession.current.binding(slot.id),live=binding&&connections.find(c=>c.connection_id===binding.connection_id),profile=profiles.find(p=>p.id===slot.profile_id);return !live||['FAILED','DISCONNECTED'].includes(live.state)?<button key={slot.id} data-workspace-slot={slot.id} title={profile?.settings.protocol==='ssh1'?'SSH1 请从会话树连接':slot.id===currentWorkspace.selected_tab?'保存时的活动项':undefined} disabled={!profile||profile.settings.protocol==='ssh1'||quickOpen||serialDialog||!!ssh1Intent} onClick={()=>{if(profile)connectProfile(profile,slot.id);}}>{profile?`连接 ${currentWorkspace.tabs.indexOf(slot)+1}. ${profile.name}`:`${currentWorkspace.tabs.indexOf(slot)+1}. 配置已删除`}</button>:null;})}<button onClick={()=>{workspaceSession.current.close();restoredFocus.current=undefined;workspaceLaunch.current=undefined;workspacePlacements.current.clear();setWorkspaceEpoch(v=>v+1);}}>收起布局</button></div>}

    {logDirectory.error&&<CornerNotice key={logDirectory.error} className="log-directory-error" heading="日志目录" tone="error" autoDismiss
      dismiss={()=>logDirectory.dismiss(logDirectory.error)}>{logDirectory.error}</CornerNotice>}
    {!tabs.length && !localTabs.length && <section className="terminal-empty">{detached?<h1>{service?'原会话已移除或代次已变化':'正在加载独立会话'}</h1>:<><h1>{currentWorkspace?'连接工作区中的会话':'新建终端会话'}</h1><div className="empty-actions"><button aria-label="连接服务器" onClick={newSsh}>新建 SSH</button><button aria-label="串口连接" onClick={newSerial}>新建串口</button><button onClick={()=>void openLocal(panes.current.active)}>本地终端（PowerShell）</button></div></>}</section>}
    <SessionDragPreview destination={drag.preview?.destination} detached={detached}/>
    {dockHover&&<div className="tab-dock-preview" aria-hidden="true">松开后移回主窗口</div>}
    <PaneGrid tree={panes.current.tree} ratios={splitRatios} idle={!tabs.length&&!localTabs.length} resize={(id,value)=>setSplitRatios(previous=>({...previous,[id]:value}))}
      render={(key,index)=>{
        const slot=paneSlots.find(item=>item.key===key)!;
        const c=slot.binding&&connections.find(c=>c.connection_id===slot.binding!.connection_id&&c.generation===slot.binding!.generation&&c.protocol===slot.binding!.protocol);
        const view=paneViews[key]??initialTerminalView();
        const localId=localSelected.current.get(key);
        const adbOpen=adbPanels[key]??adbDefaultOpen;
        const adbPanelId='adb-shortcuts-'+key;
        const locals=localTabs.filter(tab=>panes.current.paneOf(tab.id)===key);
        const rail=<SessionTabs singlePane={paneSlots.length===1} tabs={paneTabs(key)} groups={tabGroups.current.list()} groupOf={id=>tabGroups.current.groupOf(id)}
          owner={service?.service_id??''} selected={localId??slot.requested} name={tabName} recording={tabLogs.control} toggleRecording={tabLogs.toggle}
          select={id=>{panes.current.focus(key);selectConnection(id);controllers.current.get(key)?.runtime.term.focus();}}
          endControls={!detached&&(localId||c)&&<button type="button" className="adb-panel-toggle" aria-label="快捷指令" title="快捷指令" aria-keyshortcuts="Control+Shift+B"
            aria-expanded={adbOpen} aria-controls={adbPanelId} onClick={()=>setAdbPanel(key,!adbOpen)}><span className="sidebar-glyph" aria-hidden="true"/></button>}
          close={detached?undefined:target=>void closeTab(target)} pending={target=>tabClosures.current.pending(target)} assign={assignTab} drag={drag} detached={detached} copy={(source,owner)=>copyTab(key,source,owner)}
          order={orderedIds} localTabs={locals.map(tab=>({
            id:tab.id,label:tab.title,title:tab.initial.script_directory??(tab.powershell?'Windows PowerShell':'轻量命令行'),
            pending:closingLocal.current.has(tab.id),
            select:()=>{selectLocal(key,tab.id);if(localId===tab.id)focusPane(key,true);},
            close:()=>void closeLocal(tab.id),
            copy:tab.origin==='script'?undefined:()=>copyLocalTab(key,tab.id,'menu'),
            copyOnDoubleClick:tab.origin==='ordinary'?()=>copyLocalTab(key,tab.id,'double-click'):undefined,
          }))}>
          {!detached&&<ToolbarMenu className="new-menu" label={paneSlots.length===1?'新建连接':'窗格 '+(index+1)+' 新建连接'} text={<ControlIcon icon="plus" />}
            primary={{title:'新建本地终端（PowerShell）',activate:()=>void openLocal(key)}}>
            <button title="Windows PowerShell · Ctrl+Shift+T" aria-keyshortcuts="Control+Shift+T" data-shortcut="Ctrl+Shift+T" onClick={()=>void openLocal(key)}>本地终端</button>
            <button aria-label="连接服务器" onClick={event=>{preparePaneConnection(key,event.currentTarget);newSsh();}}>SSH 连接</button>
            <button onClick={event=>{preparePaneConnection(key,event.currentTarget);newSerial();}}>串口连接</button>
          </ToolbarMenu>}
          {paneSlots.length>1&&<button type="button" className="pane-collapse" aria-label="收起此窗格，保留连接" title="收起此窗格，保留连接"
            onClick={()=>{cancelWorkspaceSplit();if(panes.current.closePane(key,panes.current.active))routeChanged();}}><ControlIcon icon="collapse" /></button>}
        </SessionTabs>;
        return <TerminalPane context={(pane,value)=>setTerminalMenu({...value,pane,title:c?tabName(c):value.target.protocol})} key={slot.key} rendered={view.renderedTarget} id={slot.key} position={index+1} split={paneSlots.length>1} active={panes.current.active===slot.key} tabs={rail} showLocal={!!localId}
          local={locals.map(tab=><div key={tab.id} className="local-terminal-socket" hidden={localId!==tab.id}
            ref={node=>{if(node&&tab.surface.parentElement!==node)node.append(tab.surface);}}/>)}
          localSidebar={!detached&&(localId||c)&&<AdbShortcutPanel id={adbPanelId} scope={localId??`${service?.service_id}/${c?.connection_id}/${c?.generation}`} open={adbOpen} settings={adbSettings} starting={adbStarting}
            keyboardFocus={adbKeyboardFocus?.pane===key?adbKeyboardFocus.request:undefined}
            sendLocation={!localId&&c&&shortcutSendReady(key)?(c.protocol==='SERIAL'?'当前串口 · ':'当前 SSH · ')+tabName(c):undefined}
            diagnostics={adbDiagnostics}
            close={()=>setAdbPanel(key,false)} reload={loadAdb}
            execute={(item,revision)=>void executeShortcut(key,item,revision)}/>}
          preferences={preferences} selection={()=>paneSelection(slot.key)} register={registerPane} state={(id,view)=>setPaneViews(v=>({...v,[id]:view}))} focus={focusPane} invalidateDrafts={()=>drafts.current.invalidate()} input={()=>setComposeEpoch(v=>v+1)} search={findTerminal} proposal={(id,p)=>{if(panes.current.active===id)setPasteProposal(p);}} message={(id,text)=>{if(panes.current.active===id)setClipboardMessage(text);}} reset={id=>{if(panes.current.active===id){setSnapshot('');setServiceScreen(undefined);}}} status={view.failure||view.inputFailure||view.decodeWarning||
      (view.status==='服务输出已同步'||view.status==='服务就绪 · 尚无活动连接'?'':view.status)}/>;
      }} />
    {localTabs.map(tab=>{
      const key=panes.current.paneOf(tab.id);
      const visible=localSelected.current.get(key)===tab.id;
      return createPortal(<LocalTerminal tab={tab} visible={visible} focused={visible&&panes.current.active===key}
        rightClick={localRightClick.mode} routeEpoch={localClipboardEpoch.current} clipboardRoute={()=>
          !closingDesktop.current&&!closingLocal.current.has(tab.id)&&panes.current.active===key&&localSelected.current.get(key)===tab.id
          &&!document.querySelector('dialog:modal')?localClipboardEpoch.current:undefined}
        preferences={preferences} focus={()=>focusPane(key)} report={reportLocalPrompt.current} register={registerLocal} shortcutSettled={shortcutSettled}
        onDiagnostic={reportAdbDiagnostic} onResultSuccess={id=>{if(shortcutExecution.origins.has(id))void closeLocal(id,true);}}
        intent={adbIntent?.id===tab.id?adbIntent:undefined}/>,tab.surface,tab.id);
    })}
    {clipboardMessage&&<CornerNotice key={clipboardMessage} heading="剪贴板" autoDismiss
      dismiss={()=>setClipboardMessage(previous=>previous===clipboardMessage?'':previous)}><span aria-label="剪贴板状态">{clipboardMessage}</span></CornerNotice>}
    {tabMessage&&<CornerNotice key={tabMessage} heading="会话标签" autoDismiss
      dismiss={()=>setTabMessage(previous=>previous===tabMessage?'':previous)}><span aria-label="标签操作状态">{tabMessage}</span></CornerNotice>}
    </section>
    {quickOpen && <Dialog label="连接服务器" close={()=>closeQuick()} fallbackFocus={()=>restoreConnectEntry(copySource?.route)}><QuickConnect key={savedIntent?.request_id??'manual'} intent={savedIntent}
      copySettings={copySource?.settings.protocol==='ssh2'?copySource.settings:undefined} canStart={copySource?canStartCopy:undefined}
      connection={copySource?connections.find(c=>copyTarget&&sameRef(c,copyTarget)&&c.protocol==='SSH2'):active}
      select={(id,ref)=>selectNewConnection(id,ref,copySource?.route)}
      size={()=>{const term=(paneLaunch.current&&controllers.current.get(paneLaunch.current.key)?.runtime.term)||runtime.current?.term;return dimensions(term?.cols??80,term?.rows??24);}}
      focus={(ref,profile)=>{
        if(copySource&&(!sessionCopy.current.ownsResult(copySource.route,ref)||!copyStillCurrent(copySource.route)))return;
        finishWorkspace(ref,profile,'SSH2',savedIntent?.request_id??'');focusRenderedTerminal(ref);closeQuick(true);
      }} close={()=>closeQuick()} /></Dialog>}
    {ssh1Intent&&<Dialog label={ssh1Intent.previous?'显式重连 SSH1':'连接 SSH1 保存配置'} close={closeSsh1} focusRestored={revealProfileConnectionFocus}><Ssh1Connect
      key={ssh1Intent.request_id} intent={ssh1Intent} close={closeSsh1}
      ownerMatches={()=>!serviceStopped.current&&serviceRef.current?.service_id===ssh1Intent.owner}
      size={()=>dimensions(runtime.current?.term.cols??80,runtime.current?.term.rows??24)}
      connected={(ref,size)=>{
        selectConnection(ref.connection_id,ref);
        firstSsh1Fit.current={owner:ssh1Intent.owner,connection:ref,pane:panes.current.active,epoch:panes.current.epoch,size};
        focusRenderedTerminal(ref);
        closeSsh1();
      }} /></Dialog>}
    {serialDialog&&<Dialog label="连接串口设备" close={()=>closeSerial()} fallbackFocus={()=>restoreConnectEntry(copySource?.route)}><QuickSerial key={serialNonce} requestedProfile={requestedProfile?.settings.protocol==='serial'?requestedProfile.id:undefined}
      copySettings={copySource?.settings.protocol==='serial'?copySource.settings:undefined} canStart={copySource?canStartCopy:undefined}
      select={(id,ref)=>selectNewConnection(id,ref,copySource?.route)} close={()=>closeSerial()} focus={(ref,profile)=>{
        if(copySource&&(!sessionCopy.current.ownsResult(copySource.route,ref)||!copyStillCurrent(copySource.route)))return;
        finishWorkspace(ref,profile,'SERIAL',serialNonce);focusRenderedTerminal(ref);closeSerial(true);
      }} /></Dialog>}
    {groupsOpen&&<Dialog label="管理标签分组" close={()=>setGroupsOpen(false)}><TabGroupsPanel key={service?.service_id} groups={tabGroups.current} owner={service?.service_id??''} connections={connections} label={connectionLabel} changed={()=>setGroupEpoch(value=>value+1)} select={selectConnection} close={()=>setGroupsOpen(false)}/></Dialog>}
    {workspaceOpen&&<Dialog label="保存与打开工作区" close={()=>setWorkspaceOpen(false)}><WorkspacesPanel capture={captureCurrentWorkspace} open={openWorkspace} close={()=>setWorkspaceOpen(false)}/></Dialog>}
    {agentOpen && service && <Dialog label="管理 Agent 授权" modal={false} close={()=>setAgentOpen(false)}><AgentPanel key={service.service_id} serviceId={service.service_id} target={active?.protocol==='SSH1'?undefined:active} profileId={active?.protocol==='SSH1'?undefined:activeDetails?.profile_id} encoding={activeDetails?.encoding} close={() => setAgentOpen(false)} /></Dialog>}
    {triggerNotice&&!triggersOpen&&<CornerNotice key={triggerNotice.id} aria-label="触发器窗口通知" heading="触发器" autoDismiss
      dismiss={dismissTriggerNotice} dismissLabel="关闭触发通知">{visibleControls(triggerNotice.text)}</CornerNotice>}
    {!triggerNotice&&!closeNoticeDismissed&&service?.previous_close?.attention&&service.previous_close.receipt?.service_id!==service.service_id&&
      <CornerNotice aria-label="上次关闭提示" heading="上次关闭" autoDismiss dismiss={()=>setCloseNoticeDismissed(true)} dismissLabel="收起关闭提示"
        actions={activate=><button onClick={()=>activate(()=>setCloseInfoOpen(true))}>查看关闭信息</button>}>上次本地服务关闭有需查看的信息。</CornerNotice>}
    {closeInfoOpen&&<Dialog label="上次关闭信息" close={()=>setCloseInfoOpen(false)}><CloseReceiptPanel previous={service?.previous_close} close={()=>setCloseInfoOpen(false)}/></Dialog>}
    {!saveRecoveryDismissed&&saveRecovery&&saveRecoveryAttention(saveRecovery)&&
      <CornerNotice aria-label="另存保全提示" heading="另存保全" autoDismiss dismiss={()=>setSaveRecoveryDismissed(true)} dismissLabel="收起另存保全提示"
        actions={activate=><button onClick={()=>activate(()=>setSaveRecoveryOpen(true))}>查看另存保全信息</button>}>上次覆盖另存可能有遗留，当前结果未知。</CornerNotice>}
    {saveRecoveryOpen&&<Dialog label="另存保全信息" close={()=>setSaveRecoveryOpen(false)}><SaveRecoveryPanel snapshot={saveRecovery} close={()=>setSaveRecoveryOpen(false)}/></Dialog>}
    {importConfigOpen&&<Dialog label="原生连接配置导入" wide close={()=>{setImportConfigOpen(false);setTreeRevision(value=>value+1);}}><ImportConfigPanel owner={serviceStopped.current?'':service?.service_id??''} close={()=>{setImportConfigOpen(false);setTreeRevision(value=>value+1);}}/></Dialog>}
    {batchConfigOpen&&<Dialog label="批量修改连接配置" wide close={()=>{setBatchConfigOpen(false);setTreeRevision(value=>value+1);}}><BatchConfigPanel owner={serviceStopped.current?'':service?.service_id??''} close={()=>{setBatchConfigOpen(false);setTreeRevision(value=>value+1);}}/></Dialog>}
    {triggersOpen&&<Dialog label="配置本窗口触发器" close={()=>{triggers.current.clear();setTriggersOpen(false);}}><TriggerPanel notice={triggerNotice} dismiss={dismissTriggerNotice} owner={serviceStopped.current?'':service?.service_id??''} connections={connections.map(c=>({...c,label:tabName(c)}))} run={triggers.current} close={()=>setTriggersOpen(false)}/></Dialog>}
    {continuousOpen&&<Dialog label="明确启停连续同步键盘" close={()=>{continuousRun.current.stop();setContinuousOpen(false);}}><ContinuousInputPanel owner={serviceStopped.current?'':service?.service_id??''} connections={connections.map(c=>({...c,label:tabName(c)}))} run={continuousRun.current} close={()=>setContinuousOpen(false)}/></Dialog>}
    {broadcastOpen&&<Dialog label="明确选择多目标文本发送" close={closeBroadcast}><BroadcastPanel owner={serviceStopped.current?'':service?.service_id??''} connections={connections.map(c=>({...c,label:tabName(c)}))} run={broadcastRun.current} seed={broadcastSeed} close={closeBroadcast}/></Dialog>}
    {quickCommandsOpen&&<Dialog label="管理和准备常用命令" close={()=>setQuickCommandsOpen(false)}><QuickCommandsPanel owner={serviceStopped.current?'':service?.service_id??''} prepareMany={seed=>{if(serviceStopped.current||seed.owner!==serviceRef.current?.service_id||broadcastRun.current.snapshot().running)return false;drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setBroadcastSeed({...seed});setQuickCommandsOpen(false);setBroadcastOpen(true);return true;}} context={commandContext} label={active?tabName(active):''} hasDraft={!!commandContext&&!!drafts.current.get(commandContext.target)} prepare={prepareQuickDraft} close={()=>setQuickCommandsOpen(false)}/></Dialog>}
    {composeOpen && <Dialog label="撰写终端输入" modal={false} close={()=>{drafts.current.invalidate();setComposeOpen(false);}}><ComposePanel history={composeHistory.current} owner={serviceStopped.current?'':service?.service_id??''} initialEnding={composeEnding} origin={composeOrigin} key={`${selected}:${active?.generation}:${active?.state}:${composeEpoch}`} drafts={drafts.current} target={active} ready={!!active && active.state === 'CONNECTED' && renderedTarget?.connection_id === active.connection_id && renderedTarget.generation === active.generation && !failure && !inputFailure} send={(target, text, pacing) => composeSend.current?.(target, text, pacing) ?? false} close={() => setComposeOpen(false)} /></Dialog>}
    {softwareSettingsOpen && <Dialog label="软件设置" close={()=>setSoftwareSettingsOpen(false)}><SoftwareSettings preferences={preferences} localRightClick={<LocalRightClickSetting {...localRightClick}/>} fontSizeControl={<TerminalFontSizeControl label="终端字号" value={fontSize} state={fontSizing.state} change={setFontSize}/>} busy={preferencesBusy} canSave={!!preferenceRevision.current} message={preferenceMessage} update={updatePreferences} save={() => void preferenceOperation(true)} read={() => void preferenceOperation(false)} close={() => setSoftwareSettingsOpen(false)} /></Dialog>}
    {configurationOpen && <ConfigPanel key={configurationTarget??configurationCreation?.protocol??'new'} creation={configurationCreation} onConnect={connectNewProfile} ssh1Preview={!!service?.ssh1_preview&&!serviceStopped.current&&!serviceFailure} initialProfileId={configurationTarget} onChanged={()=>setTreeRevision(value=>value+1)} onRestored={async () => { preferenceEpoch.current++; preferenceFlight.current = false; await preferenceOperation(false); setTreeRevision(value => value + 1); }} close={closeConfiguration} />}
    <Dialog label="SSH2 连接工具" modal={false} open={sshOpen} close={()=>setSshOpen(false)}><SshPanel key={service?.service_id} open={sshOpen} connection={active} requested={selected} select={selectConnection} closePanel={()=>setSshOpen(false)} size={() => dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24)} /></Dialog>
    <Dialog label="独立 exec 任务" modal={false} open={execOpen} close={()=>setExecOpen(false)}><ExecPanel open={execOpen} connection={active} close={()=>setExecOpen(false)} /></Dialog>
    {serialOpen && <Dialog label="串口高级工具" modal={false} close={()=>setSerialOpen(false)}><SerialPanel requestedProfile={requestedProfile?.settings.protocol === 'serial' ? requestedProfile.id : undefined} connection={active} select={selectConnection} closePanel={()=>setSerialOpen(false)} /></Dialog>}
    {serialToolsOpen&&active?.protocol==='SERIAL'&&<Dialog label="串口收发详情" close={()=>setSerialToolsOpen(false)}><SerialPanel controlsOnly connection={active} select={selectConnection} closePanel={()=>setSerialToolsOpen(false)}/></Dialog>}
    {search && <Dialog label="查找终端内容" modal={false} close={()=>closeSearch()}>
      <TerminalSearch key={search.local?.id??`${selected}:${connections.find(item => item.connection_id === selected)?.generation}`}
        terminal={searchRenderer} close={()=>closeSearch()} closeFromKeyboard={()=>closeSearch(true)} />
    </Dialog>}
    {shortcutHelp&&<Dialog label="键盘快捷键" close={()=>setShortcutHelp(false)}>
      <Panel title="键盘快捷键" close={()=>setShortcutHelp(false)}>
        <dl className="desktop-shortcut-guide">
          <dt>Ctrl+Tab / Ctrl+Shift+Tab</dt><dd>当前窗格内循环切换到下一个或上一个标签</dd>
          <dt>Alt+1 到 Alt+9，Alt+0</dt><dd>切到当前窗格第 1 到 9 个、第 10 个标签</dd>
          <dt>Ctrl+Shift+T</dt><dd>在当前窗格新建本地 PowerShell</dd>
          <dt>Ctrl+Shift+B</dt><dd>开合本地快捷指令栏。用 ↑ / ↓ 选中指令，Enter 运行</dd>
          <dt>Ctrl+Shift+F</dt><dd>查找当前终端的保留缓冲区</dd>
          <dt>F6 / Shift+F6</dt><dd>切换到下一个或上一个窗格</dd>
        </dl>
      </Panel>
    </Dialog>}
    {pasteProposal && <Dialog label="粘贴确认" modal={false} close={cancelPaste}><Panel title="确认粘贴到终端">
      <small>目标 {pasteProposal.target.protocol} · {pasteProposal.target.connection_id} / 代次 {pasteProposal.target.generation}</small>
      <p>内容可能执行多条命令。CR/LF按原样发送，不自动添加换行；{pasteProposal.bracketed ? '使用终端请求的括号粘贴模式，不能保证远端安全。' : '当前未启用括号粘贴模式。'}继续键盘输入或切换目标会取消此预览。</p>
      <small>{pasteProposal.text.length} 个UTF-16单元 · CR {pasteProposal.text.split('\r').length - 1} · LF {pasteProposal.text.split('\n').length - 1} · 转义预览（最多8192个单元）</small>
      <pre aria-label="粘贴内容预览">{visibleControls(JSON.stringify(pasteProposal.text.slice(0,8192)))}{pasteProposal.text.length > 8192 && ' …预览已截断'}</pre>
      <div className="config-actions"><button onClick={() => clipboard.current?.confirm(pasteProposal)}>确认发送粘贴</button><button data-dialog-autofocus onClick={cancelPaste}>取消粘贴</button></div>
    </Panel></Dialog>}
    <LoggingPanel connection={active} owner={logOwner} title={active?tabName(active):''} open={loggingOpen} close={()=>setLoggingOpen(false)}
      claimRecording={tabLogs.claim} recordingLocked={tabLogs.locked} notifyStopped={recordingNotices.notify}/>
    {recordingNotices.notice&&<RecordingNotice key={recordingNotices.notice.id} notice={recordingNotices.notice}
      dismiss={recordingNotices.dismiss} open={recordingNotices.open}/>}
    <CornerNoticeFailure {...recordingNotices.failure}/>
    {snapshot && <Dialog label="查看屏幕快照" modal={false} close={()=>setSnapshot('')}><Panel title="屏幕快照" close={()=>setSnapshot('')} closeLabel="关闭屏幕快照"><pre aria-label="屏幕快照">{snapshot}</pre></Panel></Dialog>}
    {serviceScreen && <Dialog label="查看服务端屏幕快照" modal={false} close={()=>setServiceScreen(undefined)}><Panel title="服务端屏幕快照" close={()=>setServiceScreen(undefined)} closeLabel="关闭服务端快照"><small>{serviceScreen.connection.connection_id} / {serviceScreen.connection.generation} · {serviceScreen.encoding} · {serviceScreen.rows}×{serviceScreen.cols} · 来源游标 {serviceScreen.source_cursor} · {serviceScreen.parser} · {serviceScreen.resize_reflow ? '普通屏支持重排；复杂调整可能与桌面不同' : '宽度变化不重排，可能与桌面显示不同'} · 接收缺口 {serviceScreen.gap_bytes} 字节 · 解码错误事件 {serviceScreen.decode_error_events}{serviceScreen.contents_truncated && ' · 快照文本已截断'}{serviceScreen.completed && ' · 输出已结束'}</small><pre aria-label="服务端屏幕快照">{serviceScreen.contents || '空屏幕'}</pre></Panel></Dialog>}
    </div>
    <footer className="terminal-footer" data-service-id={service?.service_id}>
      <div className="footer-summary" aria-label="终端状态">
        <span className="footer-target" title={active?connectionLabel(active):undefined}>{localActive?'本地命令行':active?tabName(active):'尚无活动连接'}</span>
        {active&&<span>{active.protocol}</span>}
        <span role="status" className={!localActive&&statusAttention?'footer-attention':''} title={!localActive&&statusAttention||undefined}>
          {!localActive&&(statusAttention|| (inputReady?'输入就绪':active?'输入未就绪':''))}
        </span>
      </div>
      <button className="connection-details" aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={()=>setDetailsOpen(open=>!open)}>连接与服务详情</button>
      <Dialog label="连接与服务详情" modal={false} open={detailsOpen} close={()=>setDetailsOpen(false)}>
      <Panel title="连接与服务详情" close={()=>setDetailsOpen(false)} closeLabel="关闭连接与服务详情">
      <div className="connection-summary" aria-label="活动连接摘要">
        <span title={active ? `${active.connection_id} / ${active.generation}` : undefined}>{active ? `${connectionLabel(active)} · ${active.state} · 代次 ${active.generation}` : '尚无活动连接'}</span>
        <span aria-label="活动编码">编码：{activeDetails?.encoding === 'utf8' ? 'UTF-8' : activeDetails?.encoding.toUpperCase() ?? (active?.protocol === 'FIXTURE' ? 'UTF-8（合成）' : active ? '读取中' : '—')}</span>
        <span aria-label="终端视口尺寸" title={active?.protocol==='SSH1'?'本地终端列×行。SSH1 尺寸请求进入发送管线后，远端 PTY 尺寸仍可在远端核对。':'本地终端列×行；SSH PTY请求有上限，串口没有远端PTY'}>视口：{viewport.cols}×{viewport.rows}</span>
        <span aria-label="日志状态" role="status">日志：{activeLog}</span>
        <span aria-label="权限状态">{failure || inputFailure ? '桌面输入已停止' : inputReady && ['SSH1', 'SSH2', 'SERIAL'].includes(active?.protocol ?? '') ? '桌面输入可用' : inputReady && active?.protocol === 'FIXTURE' ? '合成输入（仅测试）' : '桌面输入未就绪'} · {active?.protocol==='SSH1'?'SSH1 仅桌面可用':'Agent 授权可管理，MCP需独立配对'}</span>
      </div>
    {active?.protocol==='SERIAL'&&<SerialPanel summaryOnly connection={active} select={selectConnection} tools={()=>setSerialToolsOpen(true)}/>}
    {!detached&&active?.protocol==='SSH1'&&['DISCONNECTED','FAILED'].includes(active.state)&&service?.ssh1_preview&&
      <div className="status"><button disabled={!activeDetails?.profile_id||!!ssh1Intent||quickOpen||serialDialog||!!serviceFailure}
        onClick={()=>void prepareSsh1Reconnect()}>显式重连 SSH1</button></div>}
    <div className="status" role="status">{failure || inputFailure || status}</div>
    {decodeWarning && <div role="status" aria-label="接收解码提示">{decodeWarning}</div>}
    <div className="input-status">{active?.protocol === 'SSH1' || active?.protocol === 'SSH2' ? `${active.protocol} 输入` : active?.protocol === 'SERIAL' ? '串口输入' : service?.fixture ? '合成键盘事件' : '尚无设备输入'}：<output>{lastInput}</output></div>
        <span>{active && `${active.connection_id} / ${active.generation} · `}{service && `服务 ${service.service_id} · `}{detached?'关闭窗口会将会话移回主窗口':'关闭主窗口将停止服务 · 重载页面保留服务会话 · 未完成 SSH/串口验收'}</span>
      </Panel></Dialog>
    </footer>
    {exitConfirm && <Dialog label="退出桌面确认" close={cancelDesktopClose}>
      <Panel title="退出并停止会话服务">
        <p>{localTabs.length?'退出将关闭所有本地标签和所属前台任务，并停止会话服务。':'尚有设备连接未结束。退出将停止全部连接与未发送输入。'}已执行的动作不会撤销。</p>
        <div className="config-actions"><button data-dialog-autofocus onClick={cancelDesktopClose}>取消退出</button><button onClick={()=>void finishDesktopClose().catch(()=>{})}>确认退出并停止服务</button></div>
      </Panel>
    </Dialog>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<CornerNoticeHost><App/></CornerNoticeHost>);
