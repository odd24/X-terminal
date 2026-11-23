import { useEffect, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
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

function placeAnchoredPopup(popup: HTMLElement, anchor: HTMLElement) {
  const margin = 8, gap = 4;
  const trigger = anchor.getBoundingClientRect();
  const bounds = popup.getBoundingClientRect();
  const desired = popup.scrollHeight + Math.ceil(bounds.height - popup.clientHeight);
  const below = Math.max(0, innerHeight - trigger.bottom - gap - margin);
  const above = Math.max(0, trigger.top - gap - margin);
  const flip = below < Math.min(desired, innerHeight * .7) && above > below;
  popup.style.maxHeight = `${Math.min(flip ? above : below, innerHeight * .7)}px`;
  const {height,width} = popup.getBoundingClientRect();
  const left = Math.max(margin, Math.min(trigger.left, innerWidth - width - margin));
  const idealTop = flip ? trigger.top - height - gap : trigger.bottom + gap;
  const top = Math.max(margin, Math.min(idealTop, innerHeight - height - margin));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.dataset.positioned = flip ? 'above' : 'below';
}

function placePointPopup(popup: HTMLElement, x: number, y: number) {
  const margin = 8;
  const {width,height} = popup.getBoundingClientRect();
  const top = y + height > innerHeight - margin && y - height >= margin ? y - height : y;
  popup.style.left = `${Math.max(margin, Math.min(x, innerWidth - width - margin))}px`;
  popup.style.top = `${Math.max(margin, Math.min(top, innerHeight - height - margin))}px`;
  popup.dataset.positioned = 'point';
}

function followAnchor(anchor: HTMLElement, popup: HTMLElement, expanded: () => boolean) {
  let frame = 0;
  const place = () => {
    if (expanded() && anchor.getClientRects().length) placeAnchoredPopup(popup, anchor);
    else popup.removeAttribute('data-positioned');
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; place(); });
  };
  const sizes = new ResizeObserver(schedule);
  const layout = new MutationObserver(schedule);
  sizes.observe(popup);
  for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
    sizes.observe(parent);
    layout.observe(parent, { childList: true, attributes:true, attributeFilter:['class','style','open'] });
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  place();
  return () => {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    layout.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
  };
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

const menuControls = 'button:not(:disabled,[aria-disabled="true"]), summary';
function menuItems(popup: HTMLElement) {
  return [...popup.querySelectorAll<HTMLElement>(menuControls)].filter(item=>item.getClientRects().length);
}

function moveMenuFocus(event: KeyboardEvent<HTMLElement>, popup: HTMLElement) {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)
    || (event.target as HTMLElement).matches('input,select,textarea')) return;
  event.preventDefault();
  event.stopPropagation();
  const items = menuItems(popup);
  const index = items.indexOf(document.activeElement as HTMLElement);
  const backwards = event.key === 'ArrowUp';
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : index < 0 ? (backwards ? items.length - 1 : 0) : (index + (backwards ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

export function ContextMenu({x,y,anchor,anchored=false,close,children,label="会话配置菜单",className=""}:{x:number;y:number;anchor:HTMLElement;anchored?:boolean;close():void;children:ReactNode;label?:string;className?:string}){
  const element=useRef<HTMLDivElement>(null),onClose=useRef(close);onClose.current=close;
  const restoreFocus=()=>{if(anchor.isConnected)anchor.focus({preventScroll:true});};
  useLayoutEffect(()=>{
    const menu=element.current;
    if(!menu)return;
    const place=()=>placePointPopup(menu,x,y);
    let cleanup:()=>void;
    if(anchored)cleanup=followAnchor(anchor,menu,()=>true);
    else{
      place();
      const observer=new ResizeObserver(place);
      observer.observe(menu);
      window.addEventListener('resize',place);
      cleanup=()=>{observer.disconnect();window.removeEventListener('resize',place);};
    }
    (menuItems(menu)[0]??menu).focus({preventScroll:true});
    return cleanup;
  },[x,y,anchor,anchored]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{
      const target=event.target as Node;
      if(!element.current?.contains(target)&&!(anchored&&anchor.contains(target)))onClose.current();
    };
    const blur=()=>onClose.current();
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('blur',blur);
    return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('blur',blur);};
  },[anchor,anchored]);
  return createPortal(<div ref={element} tabIndex={-1} className={`app-menu context-menu ${className}`} role="menu" aria-label={label}
    onContextMenu={event=>{event.preventDefault();event.stopPropagation();}}
    onClickCapture={event=>{
      const item=(event.target as HTMLElement).closest('button[role="menuitem"]');
      if(!item)return;
      if(item.matches(':disabled,[aria-disabled="true"]')){event.preventDefault();event.stopPropagation();return;}
      restoreFocus();
    }}
    onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==='Escape'||event.key==='Tab'){
        event.preventDefault();event.stopPropagation();onClose.current();restoreFocus();return;
      }
      if(event.repeat&&['Enter',' '].includes(event.key)){event.preventDefault();return;}
      moveMenuFocus(event,event.currentTarget);
    }}>{children}</div>,document.body);
}

const iconPaths = {
  close: 'M4 4l8 8M12 4l-8 8',
  refresh: 'M13 8a5 5 0 1 0-1.46 3.54M13 4v4H9',
  plus: 'M8 3v10M3 8h10',
  collapse: 'M6 3H2.5v10H6m4-10h3.5v10H10M11 8H5m2-2L5 8l2 2',
} as const;

export function ControlIcon({ icon }: { icon: keyof typeof iconPaths | 'more' }) {
  return <svg className="control-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {icon === 'more' ? [3, 8, 13].map(x => <circle key={x} cx={x} cy="8" r="1.15" fill="currentColor" />)
      : <path d={iconPaths[icon]} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>;
}

export function IconButton({ icon, label, className = '', ...props }: ComponentPropsWithoutRef<'button'> & {
  icon: keyof typeof iconPaths; label: string;
}) {
  return <button {...props} type="button" className={`icon-button ${className}`} aria-label={label} title={label}><ControlIcon icon={icon} /></button>;
}

export function PanelHeading({title, close, closeLabel = '关闭'}: {title: string; close?: () => void; closeLabel?: string}) {
  return <div className="config-heading"><h2>{title}</h2>{close && <IconButton icon="close" label={closeLabel} onClick={close} />}</div>;
}

export function Panel({ title, label = title, close, closeLabel = '关闭', compact = false, children }: {
  title: string; label?: string; close?: () => void; closeLabel?: string; compact?: boolean; children: ReactNode;
}) {
  return <section className="config-panel" aria-label={label}>
    {compact ? <PanelHeading title={title} close={close} closeLabel={closeLabel} />
      : <div className="config-heading"><h2>{title}</h2>{close && <button onClick={close}>{closeLabel}</button>}</div>}
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

export function ToolbarMenu({className,label,text,summary,children,primary,summaryClassName}: {
  className: string; label: string; text: ReactNode; summary?: RefObject<HTMLElement|null>; children: ReactNode;
  primary?: {title:string; activate():void};
  summaryClassName?: string;
}) {
  const element=useRef<HTMLDetailsElement>(null);
  const surface=useRef<HTMLDivElement>(null);
  const hoverTimer=useRef(0);
  const clearHover=()=>window.clearTimeout(hoverTimer.current);
  useLayoutEffect(()=>{
    const menu=element.current, popup=surface.current, trigger=menu?.querySelector('summary');
    if(!menu||!popup||!trigger)return;
    let stop:(()=>void)|undefined;
    const toggle=()=>{
      if(menu.open)stop??=followAnchor(trigger,popup,()=>menu.open);
      else{
        stop?.();stop=undefined;
        popup.removeAttribute('data-positioned');
      }
    };
    menu.addEventListener('toggle',toggle);toggle();
    return ()=>{menu.removeEventListener('toggle',toggle);stop?.();};
  },[]);
  function close(restore: boolean) {
    clearHover();
    const menu=element.current;
    if (!menu?.open) return;
    menu.open=false;
    if (restore) menu.querySelector('summary')?.focus();
  }
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!element.current?.contains(event.target as Node))close(false);};
    const escape=(event:globalThis.KeyboardEvent)=>{
      const menu=element.current;
      if(!primary||event.key!=='Escape'||!menu||document.activeElement?.closest('.app-menu,summary')||document.querySelector('dialog:modal')
        || (!menu.open&&!menu.matches(':hover')))return;
      if(menu.contains(document.activeElement))return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(false);
    };
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('keydown',escape,true);
    return ()=>{clearHover();document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);};
  },[]);
  return <details ref={element} className={className} onPointerEnter={event=>{
    if(!primary||event.pointerType!=='mouse')return;
    clearHover();
    const menu=event.currentTarget;
    if(!menu.open)hoverTimer.current=window.setTimeout(()=>{if(menu.matches(':hover'))menu.open=true;},350);
  }} onPointerLeave={event=>{
    if(!primary||event.pointerType!=='mouse')return;
    clearHover();
    hoverTimer.current=window.setTimeout(()=>{
      if(!surface.current?.contains(document.activeElement))close(false);
    },130);
  }} onBlur={event=>{
    if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))close(false);
  }} onClick={event=>{
    if ((event.target as HTMLElement).closest('button')) close(true);
  }} onKeyDown={event=>{
    if(event.key==='Escape'&&(event.currentTarget.open||primary)){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.repeat&&['Enter',' '].includes(event.key)){event.preventDefault();return;}
    if(primary&&event.key==='Enter'&&(event.target as HTMLElement).matches('summary')){
      event.preventDefault();
      close(false);
      primary.activate();
      return;
    }
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.currentTarget.open=true;
    const trigger=event.currentTarget.querySelector('summary');
    if(trigger&&surface.current)placeAnchoredPopup(surface.current,trigger);
    if(surface.current)moveMenuFocus(event,surface.current);
  }}>
    <summary ref={summary} className={summaryClassName} aria-label={label} title={primary?.title??label} onClick={event=>{
      if(!primary)return;
      event.preventDefault();
      close(false);
      if(event.detail<2)primary.activate();
    }}>{text}</summary>
    <div ref={surface} className="app-menu tools-menu-content">{children}</div>
  </details>;
}
