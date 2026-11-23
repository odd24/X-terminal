import {useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {invoke} from '@tauri-apps/api/core';
import type {AdbShortcut} from './local-adb';
import {visibleControls} from './log-search';

type Target = {anchor:HTMLButtonElement; item:AdbShortcut; revision:string; scope:string};
type ScriptPreview = {filename:string; text:string; encoding:string; truncated:boolean};
type Preview = {target:Target; script?:ScriptPreview; error?:string};
type Placement = {left:number;top:number;width:number}|'inline';

export function useShortcutPreview(scope:string, revision:string|null, enabled:boolean, panel:RefObject<HTMLElement|null>) {
  const [preview,setPreview]=useState<Preview>();
  const [placement,setPlacement]=useState<Placement>();
  const card=useRef<HTMLElement>(null);
  const target=useRef<Target>(undefined);
  const restore=useRef<HTMLButtonElement>(undefined);
  const opening=useRef(0), leaving=useRef(0);
  const live=useRef({scope,revision,enabled});
  live.current={scope,revision,enabled};

  function clear() {
    target.current=undefined;
    clearTimeout(opening.current);
    clearTimeout(leaving.current);
    setPreview(undefined);
    setPlacement(undefined);
  }
  function current(candidate:Target) {
    return target.current===candidate&&live.current.enabled&&live.current.scope===candidate.scope
      &&live.current.revision===candidate.revision&&candidate.anchor.isConnected;
  }
  function begin(item:AdbShortcut,anchor:HTMLButtonElement) {
    if(!enabled||!revision)return;
    clearTimeout(leaving.current);
    if(target.current?.anchor===anchor)return;
    clear();
    const entry={item,anchor,revision,scope};
    target.current=entry;
    opening.current=window.setTimeout(()=>{
      if(!current(entry))return;
      setPreview({target:entry});
      if(item.script_path)void invoke<ScriptPreview>('preview_local_script',{request:{id:item.id,revision}})
        .then(script=>{if(current(entry))setPreview({target:entry,script});})
        .catch(error=>{if(current(entry))setPreview({target:entry,error:typeof error==='string'?error:'无法读取脚本预览'});});
    },400);
  }
  function leave() {
    clearTimeout(leaving.current);
    if(!target.current)return;
    if(!card.current){clear();return;}
    leaving.current=window.setTimeout(clear,190);
  }

  useLayoutEffect(clear,[scope,revision,enabled]);
  useEffect(()=>{
    function escape(event:globalThis.KeyboardEvent) {
      const entry=target.current;
      if(event.key!=='Escape'||!entry||event.defaultPrevented)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const returnFocus=card.current?.contains(document.activeElement);
      clear();
      if(returnFocus&&entry.anchor.isConnected){
        restore.current=entry.anchor;
        entry.anchor.focus({preventScroll:true});
      }
    }
    function outside(event:PointerEvent) {
      if(target.current&&!target.current.anchor.contains(event.target as Node)&&!card.current?.contains(event.target as Node))clear();
    }
    window.addEventListener('keydown',escape,true);
    window.addEventListener('blur',clear);
    document.addEventListener('pointerdown',outside,true);
    return ()=>{
      clearTimeout(opening.current);
      clearTimeout(leaving.current);
      window.removeEventListener('keydown',escape,true);
      window.removeEventListener('blur',clear);
      document.removeEventListener('pointerdown',outside,true);
    };
  },[]);

  const displayed=preview&&current(preview.target)?preview:undefined;
  const docked=placement==='inline';
  useLayoutEffect(()=>{
    if(!displayed||!panel.current||!card.current)return;
    const {anchor}=displayed.target, container=panel.current, popup=card.current;
    let frame=0;
    function fit() {
      if(!anchor.getClientRects().length){clear();return;}
      const panelBounds=container.getBoundingClientRect(), row=anchor.getBoundingClientRect();
      const list=anchor.closest('.adb-panel-body')?.getBoundingClientRect();
      if(list&&(row.bottom<=list.top||row.top>=list.bottom)){clear();return;}
      const leftSpace=panelBounds.left-16, rightSpace=innerWidth-panelBounds.right-16;
      if(leftSpace<160&&rightSpace<160){setPlacement('inline');return;}
      const onLeft=leftSpace>=160;
      const width=Math.floor(Math.min(348,onLeft?leftSpace:rightSpace));
      const left=onLeft?panelBounds.left-width-8:panelBounds.right+8;
      const height=popup.getBoundingClientRect().height;
      const top=Math.max(8,Math.min(innerHeight-height-8,row.top+(row.height-height)/2));
      setPlacement(previous=>previous&&previous!=='inline'&&previous.left===left&&previous.width===width&&previous.top===top
        ?previous:{left,width,top});
    }
    function schedule() {
      if(!frame)frame=requestAnimationFrame(()=>{frame=0;fit();});
    }
    fit();
    const observer=new ResizeObserver(schedule);
    observer.observe(container);observer.observe(anchor);observer.observe(popup);
    window.addEventListener('scroll',schedule,true);
    window.addEventListener('resize',schedule);
    return ()=>{
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll',schedule,true);
      window.removeEventListener('resize',schedule);
    };
  },[displayed?.target,docked]);

  function fromRow(item:AdbShortcut) {
    return {
      onPointerEnter(event:React.PointerEvent<HTMLButtonElement>){
        if(event.pointerType==='mouse'&&!event.buttons)begin(item,event.currentTarget);
      },
      onPointerLeave:leave,
      onFocus(event:React.FocusEvent<HTMLButtonElement>){
        const anchor=event.currentTarget;
        if(restore.current===anchor){restore.current=undefined;return;}
        if(anchor.matches(':focus-visible'))begin(item,anchor);
      },
      onBlur(event:React.FocusEvent<HTMLButtonElement>){
        if(!card.current?.contains(event.relatedTarget))leave();
      },
    };
  }
  function focusPreview(anchor:HTMLButtonElement) {
    if(displayed?.target.anchor!==anchor||!card.current)return false;
    clearTimeout(leaving.current);
    card.current.focus({preventScroll:true});
    return true;
  }
  const item=displayed?.target.item;
  const text=item?.script_path?displayed?.script?.text:item?.command;
  const element=item&&displayed&&<section className="shortcut-preview" data-docked={docked||undefined}
    data-positioned={!!placement||undefined} style={placement&&placement!=='inline'?placement:undefined}
    aria-label={item.name+' 的预览'} tabIndex={-1} ref={card}
    onPointerEnter={()=>clearTimeout(leaving.current)} onPointerLeave={leave}
    onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))leave();}}>
    <small>{item.script_path?'脚本内容':'完整命令'}</small>
    {displayed.script&&<strong>{visibleControls(displayed.script.filename)}</strong>}
    {text!==undefined?<pre>{visibleControls(text.replace(/\r\n?/g,'\n'))||'（空文件）'}</pre>
      :<p role="status">{displayed.error??'正在读取脚本预览…'}</p>}
    {displayed.script&&<small>{displayed.script.encoding}{displayed.script.truncated?' · 仅显示前 32 KiB':''}</small>}
  </section>;
  return {fromRow,focusPreview,clear,node:element&&(docked?element:createPortal(element,document.body))};
}
