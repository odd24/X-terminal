import {useEffect,useRef,type ReactNode} from 'react';
import {createTerminalController,type TerminalController,type TerminalView,type PaneSelection} from './terminal-controller';
import type {TerminalMenuCapture} from './log-menu';
import type {DesktopPreferences} from './config-api';
import type {PaneKey} from './pane-layout';
import type {ComposeTarget} from './compose-drafts';
import type {PasteProposal} from './terminal-clipboard';
type Props={context(id:PaneKey,value:TerminalMenuCapture):void;rendered?:ComposeTarget;id:PaneKey;position:number;tabs:ReactNode;local?:ReactNode;localSidebar?:ReactNode;showLocal?:boolean;split:boolean;active:boolean;preferences:DesktopPreferences;selection():PaneSelection;register(id:PaneKey,c?:TerminalController):void;state(id:PaneKey,view:TerminalView):void;focus(id:PaneKey,keyboard?:boolean):void;invalidateDrafts():void;input():void;search():void;proposal(id:PaneKey,p?:PasteProposal):void;message(id:PaneKey,text:string):void;reset(id:PaneKey):void;status:string};
export function TerminalPane(props:Props){
 const host=useRef<HTMLDivElement>(null),latest=useRef(props),controller=useRef<TerminalController|undefined>(undefined);latest.current=props;
 useEffect(()=>{const id=props.id;const c=createTerminalController(host.current!,{activate:()=>latest.current.focus(id),context:value=>{latest.current.focus(id);latest.current.context(id,value);},selection:()=>latest.current.selection(),preferences:()=>latest.current.preferences,state:view=>latest.current.state(id,view),invalidateDrafts:()=>latest.current.invalidateDrafts(),input:()=>latest.current.input(),search:()=>latest.current.search(),proposal:p=>latest.current.proposal(id,p),message:t=>latest.current.message(id,t),reset:()=>latest.current.reset(id)});controller.current=c;latest.current.register(id,c);c.appearance();return()=>{c.dispose();latest.current.register(id);controller.current=undefined;};},[]);
 useEffect(()=>{controller.current?.appearance();},[props.preferences.font_size, props.preferences.terminal_font, props.preferences.terminal_palette, props.preferences.theme]);
 function focus(target:EventTarget){if(target instanceof Element&&!target.closest('.tab-record-button,.session-tab-menu'))latest.current.focus(props.id);}
 return <section className={`terminal-pane${props.active?' pane-active':''}`} data-pane={props.id} data-active={props.active} data-rendered-id={props.rendered?.connection_id} data-rendered-generation={props.rendered?.generation} aria-label={props.split?`终端窗格 ${props.position}`:'单终端窗格'} onPointerDown={event=>{if(event.button===0)focus(event.target);}} onFocusCapture={event=>focus(event.target)}>
  {props.tabs}
  <div className="terminal-pane-body" data-split={props.split}>
    <div className="terminal" ref={host} hidden={props.showLocal} aria-label={props.split?`窗格 ${props.position} 服务终端`:'服务终端'} />
    <div className="local-pane-body" hidden={!props.showLocal}>{props.local}</div>
    {props.localSidebar}
  </div>
  {!props.showLocal&&props.split&&props.status&&<small className="pane-status" role="status" title={props.status}>{props.status}</small>}
 </section>;
}
