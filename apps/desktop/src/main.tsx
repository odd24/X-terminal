import {ImportConfigPanel} from './import-config-panel';
import {CloseReceiptPanel} from './close-receipt-panel';
import type {PreviousClose} from './close-receipt';
import {SaveRecoveryPanel, saveRecoveryAttention, type SaveRecoverySnapshot} from './save-recovery-panel';
import {BatchConfigPanel} from './batch-config-panel';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalClipboard, type PasteProposal } from './terminal-clipboard';
import { visibleControls } from './log-search';
import { TerminalSearch } from './terminal-search-panel';
import { initialTerminalView, type TerminalController, type TerminalView, type PaneSelection } from './terminal-controller';
import { type ThemeChoice, type TerminalFont } from './appearance';
import { AppearancePanel } from './appearance-panel';
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
import { config, readConfiguration, type DesktopPreferences, type Profile, type Workspace } from './config-api';
import { ConfigPanel } from './config-panel';
import { SshPanel } from './ssh-panel';
import { QuickConnect, type SavedConnectIntent } from './quick-connect';
import { SessionTabClosures } from './session-tab-closures';
import { TabGroups } from './tab-groups';
import { TabGroupsPanel } from './tab-groups-panel';
import { SessionTabs } from './session-tabs';
import type { TabDrop } from './tab-drag';
import { SessionDragPreview, useSessionDrag } from './session-drag';
import { PaneGrid } from './pane-grid';
import { WorkspaceSession, captureWorkspace } from './workspace-session';
import { WorkspacesPanel } from './workspaces-panel';
import { useTabLogging, logBadge } from './tab-logging';
import { ToolbarMenu, Dialog, Panel } from './ui';
import { TerminalLogMenu } from './terminal-log-menu';
import type {TerminalMenuContext,RememberedLogTask} from './log-menu';
import { TerminalPane } from './terminal-pane';
import { PaneLayout, type PaneKey } from './pane-layout';
import { ExecPanel } from './exec-panel';
import { SerialPanel } from './serial-panel';
import { QuickSerial } from './quick-serial';
import { LoggingPanel } from './logging-panel';
import { serial, type SerialStatus } from './serial-api';
import { requestId } from './request-id';
import { ssh, dimensions, disconnectSsh1, type SshReply } from './ssh-api';
import { Ssh1Connect, type Ssh1Intent } from './ssh1-connect';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Connection = { connection_id: string; generation: number; protocol: string; state: string };
type Ref = Pick<Connection, 'connection_id' | 'generation'>;
type ServiceScreen = { connection: Ref; encoding: string; parser: string; resize_reflow: boolean; rows: number; cols: number; contents: string; contents_truncated: boolean; cursor_row: number; cursor_col: number; alternate: boolean; source_cursor: number; completed: boolean; gap_bytes: number; decode_error_events: number };
type Status = { service_id: string; pid: number; fixture: boolean; ssh1_preview: boolean; exit_policy: string; previous_close?:PreviousClose };
function sameConnectionList(previous: Connection[], next: Connection[]) {
  return previous.length === next.length && previous.every((connection, index) => {
    const current = next[index];
    return connection.connection_id === current.connection_id && connection.generation === current.generation
      && connection.protocol === current.protocol && connection.state === current.state;
  });
}
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
  const [triggerNotice,setTriggerNotice]=useState('');
  useEffect(()=>{if(!triggerNotice)return;const timer=window.setTimeout(()=>setTriggerNotice(''),6000);return()=>window.clearTimeout(timer);},[triggerNotice]);
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
  const [exitConfirm, setExitConfirm] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const allowExit = useRef(false);
  const closingDesktop = useRef<symbol>(undefined);
  const pendingExitCheck = useRef(false);
  const transferring = useRef<string>(undefined);
  const liveConnections = useRef<Connection[]>([]);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
    setPreferenceMessage('其他外观调整尚未保存，退出应用或重载会丢弃这些调整');
  }
  const setTheme = (theme: ThemeChoice) => updatePreferences({ theme });
  const setTerminalFont = (terminal_font: TerminalFont) => updatePreferences({ terminal_font });
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
  const toolsReturnDialog = useRef<'configuration' | 'appearance' | 'closeInfo' | 'saveRecovery' | 'workspace' | 'batchConfig' | undefined>(undefined);
  const toolsSummary = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const dialog = toolsReturnDialog.current;
    if (!dialog) return;
    const open = { configuration: configurationOpen, appearance: appearanceOpen, closeInfo: closeInfoOpen,
      saveRecovery: saveRecoveryOpen, workspace: workspaceOpen, batchConfig: batchConfigOpen };
    if (open[dialog]) return;
    toolsReturnDialog.current = undefined;
    toolsSummary.current?.focus();
  }, [configurationOpen, appearanceOpen, closeInfoOpen, saveRecoveryOpen, workspaceOpen, batchConfigOpen]);
  const [configurationTarget,setConfigurationTarget]=useState<{id:string;action:'edit'|'delete'}>();
  const [sshOpen, setSshOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [savedIntent,setSavedIntent]=useState<SavedConnectIntent>();
  const savedIntentFlight=useRef<SavedConnectIntent|undefined>(undefined);
  const [ssh1Intent,setSsh1Intent]=useState<Ssh1Intent>();
  const ssh1Flight=useRef(false);
  const firstSsh1Fit = useRef<{ owner: string; connection: Ref; pane: PaneKey; epoch: number; size: ReturnType<typeof dimensions> } | undefined>(undefined);
  function closeSsh1(){ssh1Flight.current=false;setSsh1Intent(undefined);}
  function closeQuick(){if(workspaceLaunch.current?.protocol==='SSH2')workspaceLaunch.current=undefined;savedIntentFlight.current=undefined;setSavedIntent(undefined);setQuickOpen(false);setTabMessage(previous=>previous.startsWith('正在连接 ')?'':previous);}
  const [execOpen, setExecOpen] = useState(false);
  const [serialOpen, setSerialOpen] = useState(false);
  const [serialDialog,setSerialDialog]=useState(false);
  const [serialToolsOpen,setSerialToolsOpen]=useState(false);
  const [loggingOpen,setLoggingOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const clipboard = useRef<TerminalClipboard | undefined>(undefined);
  const [pasteProposal, setPasteProposal] = useState<PasteProposal>();
  const [clipboardMessage, setClipboardMessage] = useState('');
  function cancelPaste(){clipboard.current?.invalidate();setClipboardMessage('已取消粘贴；未发送');runtime.current?.term.focus();}
  function selectConnection(id: string, expected?:Ref) {
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
  const stopped = useRef(false);
  const connectionStates=JSON.stringify(connections.map(c=>[c.connection_id,c.generation,c.state]));
  const connectionIdentities = JSON.stringify(connections.map(({ connection_id, generation, protocol }) => ({ connection_id, generation, protocol })));

  useEffect(() => {
    const owner = service?.service_id ?? '';
    const retained: Connection[] = JSON.parse(connectionIdentities);
    catalog.current.retain(owner, retained);
    const ids = new Set(retained.map(item => item.connection_id));
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

  useEffect(()=>{const owner=service?.service_id??'';let placed=false;for(const [slot,item] of workspacePlacements.current){if(item.owner!==owner){workspacePlacements.current.delete(slot);continue;}const live=liveConnections.current.find(c=>c.connection_id===item.connection.connection_id&&c.generation===item.connection.generation&&c.protocol===item.connection.protocol);if(!live)continue;const tab=workspaceSession.current.layout?.tabs.find(t=>t.id===slot);if(tab){try{tabGroups.current.assign(owner,live,tab.group_id??'');placed=true;}catch{/* a removed group is presentation-only */}}workspacePlacements.current.delete(slot);}
    if(placed){setTabOrder(previous=>{const base=[...liveConnections.current].sort((a,b)=>(previous.indexOf(a.connection_id)<0?previous.length:previous.indexOf(a.connection_id))-(previous.indexOf(b.connection_id)<0?previous.length:previous.indexOf(b.connection_id)));return workspaceSession.current.order(base).map(c=>c.connection_id);});setGroupEpoch(v=>v+1);}
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
        if(live){setExitConfirm(true);return;}
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
  const triggers=useRef(new Triggers({...triggerDependencies,alive:owner=>!serviceStopped.current&&serviceRef.current?.service_id===owner,notify:setTriggerNotice}));
  function closeBroadcast(){broadcastRun.current.cancel();setBroadcastOpen(false);setBroadcastSeed(undefined);}
  function syncRoute(){const current=panes.current.current;selectedRef.current=current.requested;setSelected(current.requested);const c=controllers.current.get(panes.current.active);runtime.current=c?.runtime??null;clipboard.current=c?.clipboard;composeSend.current=c?.compose;setPaneEpoch(v=>v+1);}
  function routeChanged(){firstSsh1Fit.current=undefined;setTerminalMenu(undefined);setComposeEnding('none');setComposeOrigin(undefined);drafts.current.invalidate();for(const c of controllers.current.values())c.invalidate();setPasteProposal(undefined);setClipboardMessage('');setServiceScreen(undefined);setSnapshot('');setComposeEpoch(v=>v+1);syncRoute();}
  function focusPane(key:PaneKey,keyboard=false){if(panes.current.active!==key&&panes.current.focus(key))routeChanged();if(keyboard)controllers.current.get(key)?.runtime.term.focus();}
  function cancelWorkspaceSplit(){workspaceSession.current.cancelSplit();restoredFocus.current=undefined;setWorkspaceEpoch(v=>v+1);}
  function collapseSplit(keep?:PaneKey){cancelWorkspaceSplit();panes.current.collapse(keep);routeChanged();}
  function paneSelection(key:PaneKey):PaneSelection{const slot=panes.current.slots.find(p=>p.key===key),binding=slot?.binding;
    const live=binding&&liveConnections.current.find(c=>c.connection_id===binding.connection_id&&c.generation===binding.generation&&c.protocol===binding.protocol);
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
    return {owner,connection:binding&&{...binding,state:!slot?.pending&&!slot?.retired&&live?live.state:'DISCONNECTED'},active:panes.current.active===key&&!slot?.pending&&!slot?.retired,epoch:panes.current.epoch,fixture:serviceRef.current?.fixture??false,suspended:!!binding&&(!!slot?.retired||!!slot?.pending||binding.connection_id===transferring.current),initialSsh1Fit};
  }
  function registerPane(key:PaneKey,c?:TerminalController){if(c)controllers.current.set(key,c);else controllers.current.delete(key);if(panes.current.active===key){runtime.current=c?.runtime??null;clipboard.current=c?.clipboard;composeSend.current=c?.compose;}}
  useLayoutEffect(()=>{
    if(!detached||detachedInputFocused.current||!renderedTarget)return;
    detachedInputFocused.current=true;
    runtime.current?.term.focus();
  },[renderedTarget]);
  useEffect(()=>{let disposed=false,timer=0;
    async function poll(){try{const epoch=panes.current.epoch;const native=await invoke<Status>('service_status');if(disposed)return;const sessions=await invoke<Connection[]>('service_list');if(disposed)return;
      composeHistory.current.retain(native.service_id);
      const previous = serviceRef.current;
      // The native service captures previous_close once when this owner starts.
      if (!previous || previous.service_id !== native.service_id || previous.pid !== native.pid
        || previous.fixture !== native.fixture || previous.ssh1_preview !== native.ssh1_preview
        || previous.exit_policy !== native.exit_policy) {
        serviceRef.current = native;
        setService(native);
      }
      if (!sameConnectionList(liveConnections.current, sessions)) {
        liveConnections.current = sessions;
        setConnections(sessions);
      }
      triggers.current.validate(native.service_id,sessions);
      const beforeRetain=panes.current.epoch;if(panes.current.retain(native.service_id,sessions,epoch===panes.current.epoch)){if(panes.current.epoch!==beforeRetain)routeChanged();else syncRoute();}
      if(panes.current.direction==='single'&&!panes.current.current.requested){const first=sessions.find(c=>!tabClosures.current.isHidden(c));if(first){panes.current.select(first.connection_id);panes.current.retain(native.service_id,sessions);syncRoute();}}
      timer=window.setTimeout(()=>void poll(),100);
    }catch{if(!disposed){serviceStopped.current=true;triggers.current.stop('服务不可用，已停用触发器');composeHistory.current.retain('');panes.current.epoch++;routeChanged();setFailure('会话服务不可用；未重连或重放输入。请退出后重新启动。');}}}
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(!detached&&event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&event.key.toLowerCase()==='k'&&!document.querySelector('dialog:modal')){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)openQuickCommands();return;}if(event.key!=='F6'||document.querySelector('dialog:modal')||panes.current.slots.length<2)return;event.preventDefault();event.stopImmediatePropagation();const slots=panes.current.slots,index=slots.findIndex(p=>p.key===panes.current.active);focusPane(slots[(index+(event.shiftKey?slots.length-1:1))%slots.length].key,true);};window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);},[]);

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
  const drag=useSessionDrag(tabs,service?.service_id??'',dropTab,detached);
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
  const active = !panes.current.current.pending&&!panes.current.current.retired?connections.find(item => item.connection_id === paneBinding?.connection_id&&item.generation===paneBinding.generation&&item.protocol===paneBinding.protocol):undefined;
  const currentWorkspace=workspaceSession.current.layout;
  const pendingWorkspaceTabs=currentWorkspace?.tabs.filter(t=>{const ref=workspaceSession.current.binding(t.id),live=ref&&connections.find(c=>c.connection_id===ref.connection_id);return !live||['FAILED','DISCONNECTED'].includes(live.state);})??[];
  const activeDetails = active && catalog.current.get(active);
  const logOwner=serviceStopped.current?'':service?.service_id??'';
  const tabLogs=useTabLogging(logOwner,tabs,active,target=>!serviceStopped.current&&serviceRef.current?.service_id===target.service_id&&
    transferring.current!==target.connection.connection_id&&liveConnections.current.some(c=>c.protocol===target.protocol&&
      c.connection_id===target.connection.connection_id&&c.generation===target.connection.generation));
  const activeLog=active?tabLogs.summary(active)?.text??'正在查询本次日志状态':'尚无活动连接';
  const activeLogBadge=active?logBadge(tabLogs.summary(active)):undefined;
  useEffect(()=>{
    if(clipboardMessage!=='终端选区已复制')return;
    const timer=window.setTimeout(()=>setClipboardMessage(''),2000);
    return ()=>clearTimeout(timer);
  },[clipboardMessage]);
  const inputReady = !!active && active.state === 'CONNECTED' && renderedTarget?.connection_id === active.connection_id && renderedTarget.generation === active.generation && !failure && !inputFailure;
  const statusAttention=failure||inputFailure||decodeWarning||
    (['服务输出已同步','服务就绪 · 尚无活动连接','正在连接会话服务'].includes(status)?'':status)||
    (activeLogBadge==='状态未知'||activeLogBadge==='记录失败'?activeLog:'');
  const profileName = (connection: Connection) => {
    const details = catalog.current.get(connection);
    const profile = details && profiles.find(item => item.id === details.profile_id && item.settings.protocol.toUpperCase() === connection.protocol);
    return details?.target_label ?? profile?.name;
  };
  const tabName = (connection: Connection) => connection.protocol === 'SSH2'||connection.protocol === 'SSH1'
    ? catalog.current.get(connection)?.host ?? '正在读取地址'
    : connection.protocol==='SERIAL' ? catalog.current.get(connection)?.target_label ?? '正在读取端口' : '合成终端';
  const connectionLabel = (connection: Connection) => profileName(connection) ? `${profileName(connection)} · ${connection.protocol}` : tabName(connection);
  function moveTab(offset: number) {
    const peers=paneTabs(panes.current.active);
    const index=peers.findIndex(tab=>tab.connection_id===selected);
    if(!canMoveTab(offset))return;
    dropTab(peers[index],{kind:'insert',anchor:peers[index+offset].connection_id,after:offset>0});
  }
  function paneTabs(key:PaneKey){return tabs.filter(tab=>panes.current.paneOf(tab.connection_id)===key);}
  function dropTab(source:Connection,destination:TabDrop) {
    const owner=serviceRef.current?.service_id;
    const live=liveConnections.current.find(c=>c.connection_id===source.connection_id&&c.generation===source.generation&&c.protocol===source.protocol);
    if(!owner||!live||serviceStopped.current)return;
    const id=live.connection_id;
    if(detached){
      if(destination.kind==='detach')void dockSession(owner,live);
      return;
    }
    if(destination.kind==='group'){
      if(assignTab(live,destination.group))mergeTab(live,destination.pane);
      return;
    }
    if(destination.kind==='insert'){
      if(id===destination.anchor)return;
      const order=tabs.map(tab=>tab.connection_id).filter(other=>other!==id);
      const index=order.indexOf(destination.anchor);
      if(index<0)return;
      const group=tabGroups.current.groupOf(destination.anchor);
      if(tabGroups.current.groupOf(id)!==group&&!assignTab(live,group))return;
      order.splice(index+(destination.after?1:0),0,id);
      setTabOrder(order);
      mergeTab(live,panes.current.paneOf(destination.anchor));
      return;
    }
    if(destination.kind==='detach'){void openSessionWindow(owner,live);return;}
    if(destination.kind==='merge'){mergeTab(live,destination.pane);return;}
    const canSplit=(connection:Connection)=>connection.state==='CONNECTED'&&['SSH2','SERIAL'].includes(connection.protocol);
    const slot=paneSlots.find(slot=>slot.key===destination.pane);
    const peers=paneTabs(destination.pane);
    const bound=peers.find(c=>c.connection_id===slot?.binding?.connection_id&&c.generation===slot.binding.generation);
    const other=bound&&bound.connection_id!==id&&canSplit(bound)?bound:peers.find(c=>c.connection_id!==id&&canSplit(c));
    if(!other||!canSplit(live)){
      setTabMessage('分屏需要两个仍在连接的 SSH2 或串口会话。');
      return;
    }
    const {edge}=destination;
    try {
      cancelWorkspaceSplit();
      const layout=panes.current;
      const previous=layout.active;
      layout.focus(destination.pane);
      if(bound?.connection_id!==other.connection_id)layout.select(other.connection_id,other);
      try{layout.split(owner,other,live,edge==='left'||edge==='right'?'horizontal':'vertical',edge==='left'||edge==='top',tabs);}
      finally{
        layout.focus(previous);routeChanged();
        if(layout.current.binding)focusRenderedTerminal(layout.current.binding);
      }
    } catch {setTabMessage('会话已变化，未创建分屏。');}
  }
  function mergeTab(source:Connection,destination:PaneKey){
    if(!panes.current.slots.some(slot=>slot.key===destination))return;
    if(panes.current.move(source,destination,tabs)){
      cancelWorkspaceSplit();
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
      if(panes.current.remove(connection,tabs))routeChanged();
    } catch {
      setTabMessage('没有打开独立窗口，会话仍在主窗口。');
    } finally {
      transferring.current=undefined;
    }
  }
  function hideTab(connection: Connection) {
    if(!tabClosures.current.hide(connection))return;setTabEpoch(value=>value+1);
    if(panes.current.remove(connection,tabs))routeChanged();
  }
  async function closeTab(target:Connection) {
    const decision=tabClosures.current.begin(target,liveConnections.current);
    if(decision==='stale'){setTabMessage('连接代次已变化；未关闭新连接。');return;}
    if(decision==='pending')return;
    if(decision==='unknown'){setTabMessage('关闭结果尚未确认，未重复发送。请在连接面板核对当前状态。');return;}
    workspaceSession.current.cancelSplitFor(target);restoredFocus.current=undefined;setWorkspaceEpoch(v=>v+1);
    if(decision==='hide'){hideTab(target);setTabMessage('已结束的会话标签已关闭。');return;}
    setTabEpoch(value=>value+1);setTabMessage('正在关闭会话…');
    try {
      if (target.protocol === 'SSH2') await ssh({ op: 'close', connection: { connection_id: target.connection_id, generation: target.generation } });
      else if (target.protocol === 'SSH1') await disconnectSsh1({ connection_id: target.connection_id, generation: target.generation });
      else if (target.protocol === 'SERIAL') await serial({ op: 'close', connection: { connection_id: target.connection_id, generation: target.generation } });
      else throw new Error('此连接请使用对应控制面板关闭。');
      tabClosures.current.finish(target,'accepted');hideTab(target);setTabMessage('关闭请求已提交；只关闭原代次标签，实际连接状态以服务为准。');
    } catch (error) { tabClosures.current.finish(target,'unknown');setTabMessage((error instanceof Error?error.message:'关闭未获确认。') + ' 结果可能未知，未自动重试；请在连接面板核对实际状态。'); }
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
  function closeSerial(){if(workspaceLaunch.current?.protocol==='SERIAL')workspaceLaunch.current=undefined;setSerialDialog(false);}
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
  function selectNewConnection(id:string,expected?:Ref){
    const launch=paneLaunch.current;
    if(launch&&(launch.owner!==serviceRef.current?.service_id||!panes.current.focus(launch.key)))return;
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
  function restoreConnectEntry() {
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
    <div className={`desktop-body${sidebarOpen&&!detached ? '' : ' sidebar-hidden'}`}>
    {!detached&&<aside id="connection-library" className="session-sidebar" aria-label="会话导航"><SessionTree connecting={!!savedIntent||!!ssh1Intent} ssh1Preview={!!service?.ssh1_preview&&!serviceStopped.current&&!serviceFailure} revision={treeRevision} loaded={setProfiles} connect={(profile,revision) => connectProfile(profile,undefined,revision)} configure={(id,action='edit') => {setConfigurationTarget(id?{id,action}:undefined);setConfigurationOpen(true);}} />
      <div className="sidebar-divider" role="separator" aria-label="导航宽度" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={360} aria-valuenow={navigationWidth} tabIndex={0}
        onPointerDown={event=>{if(event.button===0)event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))resizeNavigation(event.clientX-event.currentTarget.parentElement!.getBoundingClientRect().left);}}
        onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resizeNavigation(navigationWidth+(event.key==='ArrowLeft'?-10:10));}}}/>
    </aside>}
    <section className="terminal-workspace" aria-label="终端工作区">
    <TerminalLogMenu claimRecording={tabLogs.claim} recordingLocked={tabLogs.locked}
      paneLabel={paneSlots.length===1?'终端':paneSlots.length===2
        ?(panes.current.direction==='horizontal'?['左窗格','右窗格']:['上窗格','下窗格'])[terminalMenu?.pane===paneSlots[0].key?0:1]
        :'窗格 '+(paneSlots.findIndex(slot=>slot.key===terminalMenu?.pane)+1)}
      focus={t=>controllers.current.get(t.pane)?.runtime.term.focus()} menu={terminalMenu} close={()=>setTerminalMenu(undefined)} owner={serviceStopped.current?'':service?.service_id??''} valid={(t:Pick<RememberedLogTask,'target'|'pane'|'epoch'>)=>{const now=paneSelection(t.pane);return !now.suspended&&now.active&&now.owner===t.target.service_id&&now.epoch===t.epoch&&now.connection?.connection_id===t.target.connection.connection_id&&now.connection.generation===t.target.connection.generation&&now.connection.protocol===t.target.protocol;}} resume={t=>{const pane=panes.current.active,now=paneSelection(pane);return !now.suspended&&now.active&&now.owner===t.target.service_id&&now.connection?.connection_id===t.target.connection.connection_id&&now.connection.generation===t.target.connection.generation&&now.connection.protocol===t.target.protocol?{pane,epoch:now.epoch}:undefined;}} copy={c=>{void controllers.current.get(c.pane)?.clipboard.copy();}} paste={c=>{void controllers.current.get(c.pane)?.clipboard.paste();}}/>
    {currentWorkspace&&<div className="workspace-strip" aria-label="打开的工作区布局"><span>{currentWorkspace.name} · 待连接 {pendingWorkspaceTabs.length} 项</span>{currentWorkspace.split&&<><small aria-label="分屏恢复状态">{currentWorkspace.split.direction==='horizontal'?'左右':'上下'}分屏 · {workspaceSession.current.splitState==='pending'?'等待两个指定连接项就绪':workspaceSession.current.splitState==='applied'?'本次已恢复':'本次恢复已取消，可手动分屏或重新打开布局'}</small>{workspaceSession.current.splitState==='pending'&&<button onClick={cancelWorkspaceSplit}>取消分屏恢复</button>}</>}{pendingWorkspaceTabs.map(slot=>{const binding=workspaceSession.current.binding(slot.id),live=binding&&connections.find(c=>c.connection_id===binding.connection_id),profile=profiles.find(p=>p.id===slot.profile_id);return !live||['FAILED','DISCONNECTED'].includes(live.state)?<button key={slot.id} data-workspace-slot={slot.id} title={profile?.settings.protocol==='ssh1'?'SSH1 请从会话树连接':slot.id===currentWorkspace.selected_tab?'保存时的活动项':undefined} disabled={!profile||profile.settings.protocol==='ssh1'||quickOpen||serialDialog||!!ssh1Intent} onClick={()=>{if(profile)connectProfile(profile,slot.id);}}>{profile?`连接 ${currentWorkspace.tabs.indexOf(slot)+1}. ${profile.name}`:`${currentWorkspace.tabs.indexOf(slot)+1}. 配置已删除`}</button>:null;})}<button onClick={()=>{workspaceSession.current.close();restoredFocus.current=undefined;workspaceLaunch.current=undefined;workspacePlacements.current.clear();setWorkspaceEpoch(v=>v+1);}}>收起布局</button></div>}
    <nav className="app-bar" aria-label="会话控制">
      {!detached&&<button className="sidebar-toggle" aria-label="会话导航" title="显示或收起连接库" aria-expanded={sidebarOpen} aria-controls="connection-library" onClick={toggleSidebar}><span aria-hidden="true">◫</span></button>}
      <button className="toolbar-log" aria-haspopup="menu" aria-expanded={!!terminalMenu&&terminalMenu.anchor.matches('.toolbar-log')} title={activeLog} disabled={!active||renderedTarget?.connection_id!==active.connection_id||renderedTarget.generation!==active.generation||!['SSH2','SERIAL'].includes(active.protocol)} onClick={event=>openTopLog(event.currentTarget)}>
        {activeLogBadge||'日志'}
      </button>
      {!detached&&<ToolbarMenu summary={toolsSummary} className="tools-menu" label="更多工具" text="更多工具">
        <section className="toolbar-group" aria-label="会话与终端">
          <h3>会话与终端</h3>
          <button onClick={() => setLoggingOpen(open => !open)}>终端日志</button>
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
          <button onClick={() => { drafts.current.invalidate();setComposeEnding('none');setComposeOrigin(undefined); setComposeOpen(open => !open); }}>基础撰写</button>
          <button onClick={()=>{drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setBroadcastSeed(undefined);setBroadcastOpen(true);}}>多目标发送</button>
          <button onClick={()=>{drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setContinuousOpen(true);}}>连续同步键盘</button>
          <button onClick={()=>setTriggersOpen(true)}>窗口触发器</button>
          <button onClick={() => setExecOpen(open => !open)}>exec 任务</button>
          <button onClick={() => setAgentOpen(open => !open)}>Agent 授权</button>
        </section>
        <section className="toolbar-group" aria-label="外观">
          <h3>外观</h3>
          <button onClick={() => {toolsReturnDialog.current='appearance';setAppearanceOpen(true);}}>外观</button>
          <TerminalFontSizeControl label="字号" value={fontSize} state={fontSizing.state} disabled={preferencesBusy} change={setFontSize}/>
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
    {!tabs.length && <section className="terminal-empty">{detached?<h1>{service?'原会话已移除或代次已变化':'正在加载独立会话'}</h1>:<><h1>{currentWorkspace?'连接工作区中的会话':'新建终端会话'}</h1><div className="empty-actions"><button aria-label="连接服务器" onClick={newSsh}>新建 SSH</button><button aria-label="串口连接" onClick={newSerial}>新建串口</button></div></>}</section>}
    <SessionDragPreview destination={drag.preview?.destination} detached={detached}/>
    {dockHover&&<div className="tab-dock-preview" aria-hidden="true">松开后移回主窗口</div>}
    <PaneGrid tree={panes.current.tree} ratios={splitRatios} idle={!tabs.length} resize={(id,value)=>setSplitRatios(previous=>({...previous,[id]:value}))}
      render={(key,index)=>{
        const slot=paneSlots.find(item=>item.key===key)!;
        const c=slot.binding&&connections.find(c=>c.connection_id===slot.binding!.connection_id&&c.generation===slot.binding!.generation&&c.protocol===slot.binding!.protocol);
        const view=paneViews[key]??initialTerminalView();
        const rail=<SessionTabs tabs={paneTabs(key)} groups={tabGroups.current.list()} groupOf={id=>tabGroups.current.groupOf(id)}
          owner={service?.service_id??''} selected={slot.requested} name={tabName} recording={tabLogs.control} toggleRecording={tabLogs.toggle}
          select={id=>{panes.current.focus(key);selectConnection(id);controllers.current.get(key)?.runtime.term.focus();}}
          close={detached?undefined:target=>void closeTab(target)} pending={target=>tabClosures.current.pending(target)} assign={assignTab} drag={drag} detached={detached}>
          {!detached&&<ToolbarMenu className="new-menu" label={paneSlots.length===1?'新建连接':'窗格 '+(index+1)+' 新建连接'} text="＋">
            <button onClick={event=>{preparePaneConnection(key,event.currentTarget);newSsh();}}>连接服务器</button>
            <button onClick={event=>{preparePaneConnection(key,event.currentTarget);newSerial();}}>串口连接</button>
          </ToolbarMenu>}
          {paneSlots.length>1&&<button className="pane-collapse" aria-label={'收起窗格 '+(index+1)} title="收起窗格，保留连接"
            onClick={()=>{cancelWorkspaceSplit();if(panes.current.closePane(key,panes.current.active))routeChanged();}}>−</button>}
        </SessionTabs>;
        return <TerminalPane context={(pane,value)=>setTerminalMenu({...value,pane,title:c?tabName(c):value.target.protocol})} key={slot.key} rendered={view.renderedTarget} id={slot.key} position={index+1} split={paneSlots.length>1} active={panes.current.active===slot.key} tabs={rail} preferences={preferences} selection={()=>paneSelection(slot.key)} register={registerPane} state={(id,view)=>setPaneViews(v=>({...v,[id]:view}))} focus={focusPane} invalidateDrafts={()=>drafts.current.invalidate()} input={()=>setComposeEpoch(v=>v+1)} search={()=>setSearchOpen(true)} proposal={(id,p)=>{if(panes.current.active===id)setPasteProposal(p);}} message={(id,text)=>{if(panes.current.active===id)setClipboardMessage(text);}} reset={id=>{if(panes.current.active===id){setSnapshot('');setServiceScreen(undefined);}}} status={view.failure||view.inputFailure||view.decodeWarning||
      (view.status==='服务输出已同步'||view.status==='服务就绪 · 尚无活动连接'?'':view.status)}/>;
      }} />
    {clipboardMessage && <div className="clipboard-feedback" role="status" aria-label="剪贴板状态">{clipboardMessage}</div>}
    {tabMessage && <div className="tab-feedback" role="status" aria-label="标签操作状态">{tabMessage}</div>}
    </section>
    {quickOpen && <Dialog label="连接服务器" close={closeQuick} fallbackFocus={restoreConnectEntry}><QuickConnect key={savedIntent?.request_id??'manual'} intent={savedIntent} connection={active} select={selectNewConnection} size={() => dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24)} focus={(ref,profile)=>{finishWorkspace(ref,profile,'SSH2',savedIntent?.request_id??'');focusRenderedTerminal(ref);closeQuick();}} close={closeQuick} /></Dialog>}
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
    {serialDialog&&<Dialog label="连接串口设备" close={closeSerial} fallbackFocus={restoreConnectEntry}><QuickSerial key={serialNonce} requestedProfile={requestedProfile?.settings.protocol==='serial'?requestedProfile.id:undefined} select={selectNewConnection} close={closeSerial} focus={(ref,profile)=>{finishWorkspace(ref,profile,'SERIAL',serialNonce);focusRenderedTerminal(ref);closeSerial();}} /></Dialog>}
    {groupsOpen&&<Dialog label="管理标签分组" close={()=>setGroupsOpen(false)}><TabGroupsPanel key={service?.service_id} groups={tabGroups.current} owner={service?.service_id??''} connections={connections} label={connectionLabel} changed={()=>setGroupEpoch(value=>value+1)} select={selectConnection} close={()=>setGroupsOpen(false)}/></Dialog>}
    {workspaceOpen&&<Dialog label="保存与打开工作区" close={()=>setWorkspaceOpen(false)}><WorkspacesPanel capture={captureCurrentWorkspace} open={openWorkspace} close={()=>setWorkspaceOpen(false)}/></Dialog>}
    {agentOpen && service && <Dialog label="管理 Agent 授权" modal={false} close={()=>setAgentOpen(false)}><AgentPanel key={service.service_id} serviceId={service.service_id} target={active?.protocol==='SSH1'?undefined:active} profileId={active?.protocol==='SSH1'?undefined:activeDetails?.profile_id} encoding={activeDetails?.encoding} close={() => setAgentOpen(false)} /></Dialog>}
    {triggerNotice&&!triggersOpen&&<div className="terminal-log-feedback" role="status" aria-label="触发器窗口通知"><span>{visibleControls(triggerNotice)}</span><button onClick={()=>setTriggerNotice('')}>关闭触发通知</button></div>}
    {!triggerNotice&&!closeNoticeDismissed&&service?.previous_close?.attention&&service.previous_close.receipt?.service_id!==service.service_id&&<div className="terminal-log-feedback" role="status" aria-label="上次关闭提示"><span>上次本地服务关闭有需查看的信息。</span><button onClick={()=>setCloseInfoOpen(true)}>查看关闭信息</button><button onClick={()=>setCloseNoticeDismissed(true)}>收起关闭提示</button></div>}
    {closeInfoOpen&&<Dialog label="上次关闭信息" close={()=>setCloseInfoOpen(false)}><CloseReceiptPanel previous={service?.previous_close} close={()=>setCloseInfoOpen(false)}/></Dialog>}
    {!saveRecoveryDismissed&&saveRecovery&&saveRecoveryAttention(saveRecovery)&&<div className="terminal-log-feedback" role="status" aria-label="另存保全提示"><span>上次覆盖另存可能有遗留，当前结果未知。</span><button onClick={()=>setSaveRecoveryOpen(true)}>查看另存保全信息</button><button onClick={()=>setSaveRecoveryDismissed(true)}>收起另存保全提示</button></div>}
    {saveRecoveryOpen&&<Dialog label="另存保全信息" close={()=>setSaveRecoveryOpen(false)}><SaveRecoveryPanel snapshot={saveRecovery} close={()=>setSaveRecoveryOpen(false)}/></Dialog>}
    {importConfigOpen&&<Dialog label="原生连接配置导入" wide close={()=>{setImportConfigOpen(false);setTreeRevision(value=>value+1);}}><ImportConfigPanel owner={serviceStopped.current?'':service?.service_id??''} close={()=>{setImportConfigOpen(false);setTreeRevision(value=>value+1);}}/></Dialog>}
    {batchConfigOpen&&<Dialog label="批量修改连接配置" wide close={()=>{setBatchConfigOpen(false);setTreeRevision(value=>value+1);}}><BatchConfigPanel owner={serviceStopped.current?'':service?.service_id??''} close={()=>{setBatchConfigOpen(false);setTreeRevision(value=>value+1);}}/></Dialog>}
    {triggersOpen&&<Dialog label="配置本窗口触发器" close={()=>{triggers.current.clear();setTriggersOpen(false);}}><TriggerPanel notice={triggerNotice} dismiss={()=>setTriggerNotice('')} owner={serviceStopped.current?'':service?.service_id??''} connections={connections.map(c=>({...c,label:tabName(c)}))} run={triggers.current} close={()=>setTriggersOpen(false)}/></Dialog>}
    {continuousOpen&&<Dialog label="明确启停连续同步键盘" close={()=>{continuousRun.current.stop();setContinuousOpen(false);}}><ContinuousInputPanel owner={serviceStopped.current?'':service?.service_id??''} connections={connections.map(c=>({...c,label:tabName(c)}))} run={continuousRun.current} close={()=>setContinuousOpen(false)}/></Dialog>}
    {broadcastOpen&&<Dialog label="明确选择多目标文本发送" close={closeBroadcast}><BroadcastPanel owner={serviceStopped.current?'':service?.service_id??''} connections={connections.map(c=>({...c,label:tabName(c)}))} run={broadcastRun.current} seed={broadcastSeed} close={closeBroadcast}/></Dialog>}
    {quickCommandsOpen&&<Dialog label="管理和准备常用命令" close={()=>setQuickCommandsOpen(false)}><QuickCommandsPanel owner={serviceStopped.current?'':service?.service_id??''} prepareMany={seed=>{if(serviceStopped.current||seed.owner!==serviceRef.current?.service_id||broadcastRun.current.snapshot().running)return false;drafts.current.invalidate();clipboard.current?.invalidate();setComposeEpoch(v=>v+1);setBroadcastSeed({...seed});setQuickCommandsOpen(false);setBroadcastOpen(true);return true;}} context={commandContext} label={active?tabName(active):''} hasDraft={!!commandContext&&!!drafts.current.get(commandContext.target)} prepare={prepareQuickDraft} close={()=>setQuickCommandsOpen(false)}/></Dialog>}
    {composeOpen && <Dialog label="撰写终端输入" modal={false} close={()=>{drafts.current.invalidate();setComposeOpen(false);}}><ComposePanel history={composeHistory.current} owner={serviceStopped.current?'':service?.service_id??''} initialEnding={composeEnding} origin={composeOrigin} key={`${selected}:${active?.generation}:${active?.state}:${composeEpoch}`} drafts={drafts.current} target={active} ready={!!active && active.state === 'CONNECTED' && renderedTarget?.connection_id === active.connection_id && renderedTarget.generation === active.generation && !failure && !inputFailure} send={(target, text, pacing) => composeSend.current?.(target, text, pacing) ?? false} close={() => setComposeOpen(false)} /></Dialog>}
    {appearanceOpen && <Dialog label="外观设置" close={()=>setAppearanceOpen(false)}><AppearancePanel theme={theme} font={terminalFont} setTheme={setTheme} setFont={setTerminalFont} preferences={preferences} fontSizeControl={<TerminalFontSizeControl label="终端字号" value={fontSize} state={fontSizing.state} change={setFontSize}/>} busy={preferencesBusy} canSave={!!preferenceRevision.current} message={preferenceMessage} update={updatePreferences} save={() => void preferenceOperation(true)} read={() => void preferenceOperation(false)} close={() => setAppearanceOpen(false)} /></Dialog>}
    {configurationOpen && <Dialog label="连接配置" wide close={()=>{setConfigurationOpen(false);setTreeRevision(value=>value+1);}}><ConfigPanel key={configurationTarget?.id??'new'} ssh1Preview={!!service?.ssh1_preview&&!serviceStopped.current&&!serviceFailure} initialProfileId={configurationTarget?.id} initialAction={configurationTarget?.action} onChanged={()=>setTreeRevision(value=>value+1)} onRestored={async () => { preferenceEpoch.current++; preferenceFlight.current = false; await preferenceOperation(false); setTreeRevision(value => value + 1); }} close={() => { setConfigurationOpen(false); setTreeRevision(value => value + 1); }} /></Dialog>}
    {sshOpen && <Dialog label="SSH2 连接工具" modal={false} close={()=>setSshOpen(false)}><SshPanel connection={active} select={selectConnection} closePanel={()=>setSshOpen(false)} size={() => dimensions(runtime.current?.term.cols ?? 80, runtime.current?.term.rows ?? 24)} /></Dialog>}
    <Dialog label="独立 exec 任务" modal={false} open={execOpen} close={()=>setExecOpen(false)}><ExecPanel open={execOpen} connection={active} close={()=>setExecOpen(false)} /></Dialog>
    {serialOpen && <Dialog label="串口高级工具" modal={false} close={()=>setSerialOpen(false)}><SerialPanel requestedProfile={requestedProfile?.settings.protocol === 'serial' ? requestedProfile.id : undefined} connection={active} select={selectConnection} closePanel={()=>setSerialOpen(false)} /></Dialog>}
    {serialToolsOpen&&active?.protocol==='SERIAL'&&<Dialog label="串口收发详情" close={()=>setSerialToolsOpen(false)}><SerialPanel controlsOnly connection={active} select={selectConnection} closePanel={()=>setSerialToolsOpen(false)}/></Dialog>}
    {searchOpen && <Dialog label="查找终端内容" modal={false} close={()=>setSearchOpen(false)}><TerminalSearch key={`${selected}:${connections.find(item => item.connection_id === selected)?.generation}`} terminal={() => runtime.current?.term} close={() => setSearchOpen(false)} closeFromKeyboard={() => {
      toolsSummary.current?.focus();
      setSearchOpen(false);
    }} /></Dialog>}
    {pasteProposal && <Dialog label="粘贴确认" modal={false} close={cancelPaste}><Panel title="确认粘贴到终端">
      <small>目标 {pasteProposal.target.protocol} · {pasteProposal.target.connection_id} / 代次 {pasteProposal.target.generation}</small>
      <p>内容可能执行多条命令。CR/LF按原样发送，不自动添加换行；{pasteProposal.bracketed ? '使用终端请求的括号粘贴模式，不能保证远端安全。' : '当前未启用括号粘贴模式。'}继续键盘输入或切换目标会取消此预览。</p>
      <small>{pasteProposal.text.length} 个UTF-16单元 · CR {pasteProposal.text.split('\r').length - 1} · LF {pasteProposal.text.split('\n').length - 1} · 转义预览（最多8192个单元）</small>
      <pre aria-label="粘贴内容预览">{visibleControls(JSON.stringify(pasteProposal.text.slice(0,8192)))}{pasteProposal.text.length > 8192 && ' …预览已截断'}</pre>
      <div className="config-actions"><button onClick={() => clipboard.current?.confirm(pasteProposal)}>确认发送粘贴</button><button data-dialog-autofocus onClick={cancelPaste}>取消粘贴</button></div>
    </Panel></Dialog>}
    <LoggingPanel connection={active} owner={logOwner} open={loggingOpen} close={()=>setLoggingOpen(false)} claimRecording={tabLogs.claim} recordingLocked={tabLogs.locked} />
    {snapshot && <Dialog label="查看屏幕快照" modal={false} close={()=>setSnapshot('')}><Panel title="屏幕快照" close={()=>setSnapshot('')} closeLabel="关闭屏幕快照"><pre aria-label="屏幕快照">{snapshot}</pre></Panel></Dialog>}
    {serviceScreen && <Dialog label="查看服务端屏幕快照" modal={false} close={()=>setServiceScreen(undefined)}><Panel title="服务端屏幕快照" close={()=>setServiceScreen(undefined)} closeLabel="关闭服务端快照"><small>{serviceScreen.connection.connection_id} / {serviceScreen.connection.generation} · {serviceScreen.encoding} · {serviceScreen.rows}×{serviceScreen.cols} · 来源游标 {serviceScreen.source_cursor} · {serviceScreen.parser} · {serviceScreen.resize_reflow ? '普通屏支持重排；复杂调整可能与桌面不同' : '宽度变化不重排，可能与桌面显示不同'} · 接收缺口 {serviceScreen.gap_bytes} 字节 · 解码错误事件 {serviceScreen.decode_error_events}{serviceScreen.contents_truncated && ' · 快照文本已截断'}{serviceScreen.completed && ' · 输出已结束'}</small><pre aria-label="服务端屏幕快照">{serviceScreen.contents || '空屏幕'}</pre></Panel></Dialog>}
    </div>
    <footer className="terminal-footer" data-service-id={service?.service_id}>
      <div className="footer-summary" aria-label="终端状态">
        <span className="footer-target" title={active?connectionLabel(active):undefined}>{active?tabName(active):'尚无活动连接'}</span>
        {active&&<span>{active.protocol}</span>}
        <span role="status" className={statusAttention?'footer-attention':''} title={statusAttention||undefined}>
          {statusAttention|| (inputReady?'输入就绪':active?'输入未就绪':'')}
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
        <p>尚有设备连接未结束。退出将停止全部连接与未发送输入，已执行动作不会撤销；没有后台驻留模式。</p>
        <div className="config-actions"><button data-dialog-autofocus onClick={cancelDesktopClose}>取消退出</button><button onClick={()=>void finishDesktopClose().catch(()=>{})}>确认退出并停止服务</button></div>
      </Panel>
    </Dialog>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
