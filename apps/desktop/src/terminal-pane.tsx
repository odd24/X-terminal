import {useEffect,useRef} from 'react';
import {createTerminalController,type TerminalController,type TerminalView,type PaneSelection} from './terminal-controller';
import type {TerminalMenuCapture} from './log-menu';
import type {DesktopPreferences} from './config-api';
import type {SessionDrag} from './session-drag';
import type {PaneKey,PaneLive} from './pane-layout';
import type {ComposeTarget} from './compose-drafts';
import type {PasteProposal} from './terminal-clipboard';
type Props={context(id:PaneKey,value:TerminalMenuCapture):void;rendered?:ComposeTarget;id:PaneKey;position:number;drag:SessionDrag;connection?:PaneLive;split:boolean;active:boolean;label:string;detail:string;preferences:DesktopPreferences;selection():PaneSelection;register(id:PaneKey,c?:TerminalController):void;state(id:PaneKey,view:TerminalView):void;focus(id:PaneKey,keyboard?:boolean):void;collapse(id:PaneKey):void;invalidateDrafts():void;input():void;search():void;proposal(id:PaneKey,p?:PasteProposal):void;message(id:PaneKey,text:string):void;reset(id:PaneKey):void;status:string};
export function TerminalPane(props:Props){
 const host=useRef<HTMLDivElement>(null),latest=useRef(props),controller=useRef<TerminalController|undefined>(undefined);latest.current=props;
 useEffect(()=>{const id=props.id;const c=createTerminalController(host.current!,{activate:()=>latest.current.focus(id),context:value=>{latest.current.focus(id);latest.current.context(id,value);},selection:()=>latest.current.selection(),preferences:()=>latest.current.preferences,state:view=>latest.current.state(id,view),invalidateDrafts:()=>latest.current.invalidateDrafts(),input:()=>latest.current.input(),search:()=>latest.current.search(),proposal:p=>latest.current.proposal(id,p),message:t=>latest.current.message(id,t),reset:()=>latest.current.reset(id)});controller.current=c;latest.current.register(id,c);c.appearance();return()=>{c.dispose();latest.current.register(id);controller.current=undefined;};},[]);
 useEffect(()=>{controller.current?.appearance();},[props.preferences.font_size, props.preferences.terminal_font, props.preferences.terminal_palette, props.preferences.theme]);
 const drag = props.connection?.state==='CONNECTED' ? props.drag.bindings(props.connection) : undefined;
 return <section className={`terminal-pane${props.active?' pane-active':''}`} data-pane={props.id} data-active={props.active} data-rendered-id={props.rendered?.connection_id} data-rendered-generation={props.rendered?.generation} aria-label={props.split?`终端窗格 ${props.position}`:'单终端窗格'} onPointerDown={()=>latest.current.focus(props.id)} onFocusCapture={()=>latest.current.focus(props.id)}>
  {props.split&&<header className="pane-heading"><button className="pane-focus" title={props.detail} {...drag} aria-pressed={props.active} onClick={event=>{if(props.drag.allowedClick(event))latest.current.focus(props.id,true);}}>{props.position} · {props.label} · {props.active?'当前输入':'点击输入'}</button><button onClick={()=>props.collapse(props.id)} aria-label={`收起窗格 ${props.position}`}>收起此窗格</button></header>}
  <div className="terminal" ref={host} aria-label={props.split?`窗格 ${props.position} 服务终端`:'服务终端'} />
  {props.split&&props.status&&<small className="pane-status" role="status" title={props.status}>{props.status}</small>}
 </section>;
}
