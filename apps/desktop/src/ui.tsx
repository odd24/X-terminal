import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({ label, close, wide = false, children }: { label: string; close(): void; wide?: boolean; children: ReactNode }) {
  const element=useRef<HTMLDialogElement>(null), onClose=useRef(close);onClose.current=close;
  useLayoutEffect(()=>{const dialog=element.current;const previous=document.activeElement;if(!dialog)return;dialog.showModal();const first=dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button');first?.focus();return()=>{dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
  return createPortal(<dialog ref={element} className={`app-dialog${wide?' app-dialog-wide':''}`} aria-label={label} onKeyDown={event=>{if(event.key!=='Tab')return;const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')).filter(e=>e.getClientRects().length>0);const destination=event.shiftKey?controls.at(-1):controls[0];if(destination&&((event.shiftKey&&document.activeElement===controls[0])||(!event.shiftKey&&document.activeElement===controls.at(-1)))){event.preventDefault();destination.focus();}}} onCancel={event=>{event.preventDefault();onClose.current();}} onClick={event=>{if(event.target!==event.currentTarget)return;const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose.current();}}>{children}</dialog>,document.body);
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  const element=useRef<HTMLDivElement>(null);
  useEffect(()=>{element.current?.scrollIntoView({block:'nearest'});},[children]);
  return <div ref={element} className="notice-error" role="alert"><strong><span aria-hidden="true">⚠ </span>连接未完成</strong><p>{children}</p></div>;
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
