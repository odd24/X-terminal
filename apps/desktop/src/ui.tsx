import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

function dialogControls(dialog: HTMLDialogElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex="0"]'))
    .filter(control => !control.matches(':disabled, [tabindex="-1"]') && control.getClientRects().length > 0);
}

function placeDialog(dialog: HTMLDialogElement, left: number, top: number) {
  const margin = 8;
  const { width, height } = dialog.getBoundingClientRect();
  dialog.style.left = `${Math.max(margin, Math.min(left, innerWidth - width - margin))}px`;
  dialog.style.top = `${Math.max(margin, Math.min(top, innerHeight - height - margin))}px`;
  dialog.dataset.positioned = '';
}

function raiseDialog(dialog: HTMLDialogElement) {
  const raised = document.querySelector('.app-dialog-modeless[data-raised]');
  if (raised === dialog) return;
  raised?.removeAttribute('data-raised');
  dialog.dataset.raised = '';
}

export function Dialog({ label, close, focusRestored, fallbackFocus, wide = false, modal = true, passive = false, open = true, children }: {
  label: string; close(): void; fallbackFocus?():void; focusRestored?(target: HTMLElement): void;
  wide?: boolean; modal?: boolean; passive?: boolean; open?: boolean; children: ReactNode;
}) {
  const element=useRef<HTMLDialogElement>(null), onClose=useRef(close);onClose.current=close;
  const drag = useRef<{pointer:number; dx:number; dy:number}>(undefined);
  const onFocusRestored = useRef(focusRestored);
  onFocusRestored.current = focusRestored;
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
  useLayoutEffect(() => {
    const dialog = element.current;
    const previous = document.activeElement;
    if (!dialog || !open) return;
    if (modal) dialog.showModal();
    else if (passive) dialog.setAttribute('open', '');
    else dialog.show();
    if (!passive) {
      dialog.scrollTop = 0;
      const preferred = dialog.querySelector<HTMLElement>('[data-dialog-autofocus]');
      if (preferred) preferred.focus();
      else if (!dialog.contains(document.activeElement)) dialogControls(dialog)[0]?.focus();
    }
    if (!modal) raiseDialog(dialog);
    const fit = () => {
      if (dialog.dataset.positioned === undefined) return;
      const bounds = dialog.getBoundingClientRect();
      placeDialog(dialog, bounds.left, bounds.top);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(dialog);
    window.addEventListener('resize', fit);
    return () => {
      const shouldRestore = dialog.contains(document.activeElement) || document.activeElement === document.body;
      observer.disconnect();
      window.removeEventListener('resize', fit);
      if (passive) dialog.removeAttribute('open');
      else dialog.close();
      dialog.removeAttribute('data-positioned');
      dialog.removeAttribute('data-raised');
      dialog.style.removeProperty('top');
      dialog.style.removeProperty('left');
      dialog.scrollTop = 0;
      drag.current = undefined;
      if (!shouldRestore) return;
      if (previous instanceof HTMLElement && previous.isConnected) {
        const target = previous.getClientRects().length ? previous : previous.closest('details')?.querySelector('summary');
        target?.focus({ preventScroll: true });
        if (target && document.activeElement === target) { onFocusRestored.current?.(target); return; }
      }
      fallback.current?.();
    };
  }, [modal, open, passive]);
  return createPortal(<dialog ref={element}
    className={`app-dialog${wide?' app-dialog-wide':''}${modal?'':' app-dialog-modeless'}${passive?' app-dialog-corner':''}`}
    aria-label={label}
    onFocus={event=>{if(!modal)raiseDialog(event.currentTarget);}}
    onPointerDown={event=>{
      const dialog = event.currentTarget;
      if (!modal) raiseDialog(dialog);
      const target = event.target;
      if (!event.isPrimary || event.button !== 0 || !(target instanceof Element)) return;
      const heading = dialog.querySelector(':scope > .config-panel > .config-heading:first-child');
      if (!heading?.contains(target) || target.closest('button, input, select, textarea, label, a, summary, [contenteditable], [tabindex]')) return;
      const bounds = dialog.getBoundingClientRect();
      drag.current = {pointer:event.pointerId, dx:event.clientX-bounds.left, dy:event.clientY-bounds.top};
      dialog.setPointerCapture(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={event=>{
      const start = drag.current;
      if (start?.pointer === event.pointerId) placeDialog(event.currentTarget, event.clientX - start.dx, event.clientY - start.dy);
    }}
    onLostPointerCapture={event=>{if(drag.current?.pointer===event.pointerId)drag.current=undefined;}}
    onKeyDown={event=>{
      if(event.defaultPrevented || event.nativeEvent.isComposing) return;
      if(!modal && event.key==='Escape') { event.preventDefault(); event.stopPropagation(); onClose.current(); }
      if(!modal || event.key!=='Tab') return;
      const controls=dialogControls(event.currentTarget);
      const destination=event.shiftKey?controls.at(-1):controls[0];
      if(destination&&((event.shiftKey&&document.activeElement===controls[0])||(!event.shiftKey&&document.activeElement===controls.at(-1)))){event.preventDefault();destination.focus();}
    }} onCancel={event=>{event.preventDefault();onClose.current();}}>{children}</dialog>,document.body);
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
