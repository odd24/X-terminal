import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({ label, close, wide = false, children }: { label: string; close(): void; wide?: boolean; children: ReactNode }) {
  const element=useRef<HTMLDialogElement>(null), onClose=useRef(close);onClose.current=close;
  useLayoutEffect(()=>{const dialog=element.current;const previous=document.activeElement;if(!dialog)return;dialog.showModal();const first=dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button');first?.focus();return()=>{dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
  return createPortal(<dialog ref={element} className={`app-dialog${wide?' app-dialog-wide':''}`} aria-label={label} onKeyDown={event=>{if(event.key!=='Tab')return;const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')).filter(e=>e.getClientRects().length>0);const destination=event.shiftKey?controls.at(-1):controls[0];if(destination&&((event.shiftKey&&document.activeElement===controls[0])||(!event.shiftKey&&document.activeElement===controls.at(-1)))){event.preventDefault();destination.focus();}}} onCancel={event=>{event.preventDefault();onClose.current();}} onClick={event=>{if(event.target!==event.currentTarget)return;const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose.current();}}>{children}</dialog>,document.body);
}

export function ErrorNotice({ children, title='连接未完成' }: { children: ReactNode; title?:string }) {
  const element=useRef<HTMLDivElement>(null);
  useEffect(()=>{element.current?.scrollIntoView({block:'nearest'});},[children]);
  return <div ref={element} className="notice-error" role="alert"><strong><span aria-hidden="true">⚠ </span>{title}</strong><p>{children}</p></div>;
}

export function ContextMenu({x,y,anchor,close,children}:{x:number;y:number;anchor:HTMLElement;close():void;children:ReactNode}){
  const element=useRef<HTMLDivElement>(null),onClose=useRef(close);onClose.current=close;
  useLayoutEffect(()=>{const menu=element.current;if(!menu)return;const r=menu.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(x,innerWidth-r.width-4))}px`;menu.style.top=`${Math.max(4,Math.min(y,innerHeight-r.height-4))}px`;menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();},[x,y]);
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(!element.current?.contains(event.target as Node))onClose.current();};document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);},[]);
  return createPortal(<div ref={element} className="context-menu" role="menu" aria-label="会话配置菜单" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose.current();if(anchor.isConnected)anchor.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));const index=items.indexOf(document.activeElement as HTMLElement);const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;items[next]?.focus();}}}>{children}</div>,document.body);
}

export function Panel({ title, label = title, close, closeLabel = '关闭', children }: {
  title: string; label?: string; close?: () => void; closeLabel?: string; children: ReactNode;
}) {
  return <section className="config-panel" aria-label={label}>
    <div className="config-heading"><h2>{title}</h2>{close && <button onClick={close}>{closeLabel}</button>}</div>
    {children}
  </section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label>{label}{children}</label>;
}
