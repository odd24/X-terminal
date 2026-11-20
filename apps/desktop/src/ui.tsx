import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({ label, close, focusRestored, fallbackFocus, wide = false, children }: {
  label: string; close(): void; fallbackFocus?():void; focusRestored?(target: HTMLElement): void; wide?: boolean; children: ReactNode;
}) {
  const element=useRef<HTMLDialogElement>(null), onClose=useRef(close);onClose.current=close;
  const onFocusRestored = useRef(focusRestored);
  onFocusRestored.current = focusRestored;
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useLayoutEffect(() => {
    const dialog = element.current;
    const previous = document.activeElement;
    if (!dialog) return;
    dialog.showModal();
    if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')?.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
        onFocusRestored.current?.(previous);
      } else fallback.current?.();
    };
  }, []);
  return createPortal(<dialog ref={element} className={`app-dialog${wide?' app-dialog-wide':''}`} aria-label={label} onKeyDown={event=>{if(event.key!=='Tab')return;const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')).filter(e=>e.getClientRects().length>0);const destination=event.shiftKey?controls.at(-1):controls[0];if(destination&&((event.shiftKey&&document.activeElement===controls[0])||(!event.shiftKey&&document.activeElement===controls.at(-1)))){event.preventDefault();destination.focus();}}} onCancel={event=>{event.preventDefault();onClose.current();}}>{children}</dialog>,document.body);
}

export function ErrorNotice({ children, title='连接未完成' }: { children: ReactNode; title?:string }) {
  const element=useRef<HTMLDivElement>(null);
  useEffect(()=>{element.current?.scrollIntoView({block:'nearest'});},[children]);
  return <div ref={element} className="notice-error" role="alert"><strong><span aria-hidden="true">⚠ </span>{title}</strong><p>{children}</p></div>;
}

export function ContextMenu({x,y,anchor,close,children,label="会话配置菜单",className=""}:{x:number;y:number;anchor:HTMLElement;close():void;children:ReactNode;label?:string;className?:string}){
  const element=useRef<HTMLDivElement>(null),onClose=useRef(close);onClose.current=close;
  useLayoutEffect(()=>{const menu=element.current;if(!menu)return;const place=()=>{const r=menu.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(x,innerWidth-r.width-4))}px`;menu.style.top=`${Math.max(4,Math.min(y,innerHeight-r.height-4))}px`;};place();const observer=new ResizeObserver(place);observer.observe(menu);menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();return()=>observer.disconnect();},[x,y]);
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(!element.current?.contains(event.target as Node))onClose.current();};document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);},[]);
  return createPortal(<div ref={element} className={`context-menu ${className}`} role="menu" aria-label={label} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose.current();if(anchor.isConnected)anchor.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));const index=items.indexOf(document.activeElement as HTMLElement);const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;items[next]?.focus();}}}>{children}</div>,document.body);
}

export function Panel({ title, label = title, close, closeLabel = '关闭', children }: {
  title: string; label?: string; close?: () => void; closeLabel?: string; children: ReactNode;
}) {
  return <section className="config-panel" aria-label={label}>
    <div className="config-heading"><h2>{title}</h2>{close && <button onClick={close}>{closeLabel}</button>}</div>
    {children}
  </section>;
}

export function Field({ label, children, error, errorId }: { label: string; children: ReactNode; error?:string; errorId?:string }) {
  return <label>{label}{children}{error&&<span id={errorId} className="field-error" role="alert">{error}</span>}</label>;
}

export function keepCompositionInField(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
    event.preventDefault();
  }
}

export function ToolbarMenu({className,label,text,summary,children}: {
  className: string; label: string; text: string; summary?: RefObject<HTMLElement|null>; children: ReactNode;
}) {
  const element=useRef<HTMLDetailsElement>(null);
  function close(restore: boolean) {
    const menu=element.current;
    if (!menu?.open) return;
    menu.open=false;
    if (restore) menu.querySelector('summary')?.focus();
  }
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!element.current?.contains(event.target as Node))close(false);};
    document.addEventListener('pointerdown',outside,true);
    return ()=>document.removeEventListener('pointerdown',outside,true);
  },[]);
  return <details ref={element} className={className} onBlur={event=>{
    if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))close(false);
  }} onClick={event=>{
    if ((event.target as HTMLElement).closest('button')) close(true);
  }} onKeyDown={event=>{
    if(event.key==='Escape'&&event.currentTarget.open){event.preventDefault();close(true);return;}
    if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
    if((event.target as HTMLElement).matches('input,select,textarea'))return;
    event.preventDefault();
    event.currentTarget.open=true;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.tools-menu-content button:not([disabled]), .tools-menu-content summary')).filter(item=>item.getClientRects().length);
    const index=controls.indexOf(document.activeElement as HTMLElement);
    const next=index<0?(event.key==='ArrowDown'?0:controls.length-1):(index+(event.key==='ArrowDown'?1:-1)+controls.length)%controls.length;
    controls[next]?.focus();
  }}>
    <summary ref={summary} aria-label={label} title={label}>{text}</summary>
    <div className="tools-menu-content">{children}</div>
  </details>;
}
