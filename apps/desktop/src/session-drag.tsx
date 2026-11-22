import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { locateTabDrop, type TabDrop } from './tab-drag';
import type { PaneLive } from './pane-layout';

export function useSessionDrag(tabs: PaneLive[], owner: string,
  drop: (source: PaneLive, destination: TabDrop) => void, detached: boolean) {
  const gesture = useRef<{ source: PaneLive; owner: string; pointer: number; x: number; y: number; moving: boolean }>(undefined);
  const frame = useRef(0);
  const ignoreClick = useRef(false);
  const ignoreDoubleClick = useRef(false);
  const [preview, setPreview] = useState<{ id: string; destination?: TabDrop }>();

  function clear() {
    gesture.current = undefined;
    cancelAnimationFrame(frame.current);
    setPreview(undefined);
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const current = gesture.current;
    if (current && (current.owner !== owner || !tabs.some(tab => tab.connection_id === current.source.connection_id
      && tab.generation === current.source.generation && tab.protocol === current.source.protocol))) clear();
  }, [tabs, owner]);

  function target(x: number, y: number, source:PaneLive) {
    const destination = locateTabDrop(x, y);
    if (source.protocol==='LOCAL' && destination?.kind==='detach') return;
    return !detached || destination?.kind === 'detach' ? destination : undefined;
  }
  function update(current: NonNullable<typeof gesture.current>) {
    setPreview({ id: current.source.connection_id, destination: target(current.x, current.y,current.source) });
  }
  function scrollRail() {
    const current = gesture.current;
    if (!current?.moving) return;
    const rail=document.elementFromPoint(current.x,current.y)?.closest<HTMLElement>('[role="tablist"]');
    frame.current = requestAnimationFrame(scrollRail);
    if(!rail)return;
    const bounds = rail.getBoundingClientRect();
    if (current.y >= bounds.top && current.y < bounds.bottom && current.x >= bounds.left && current.x < bounds.right) {
      const delta = current.x < bounds.left + 24 ? -8 : current.x > bounds.right - 24 ? 8 : 0;
      const before = rail.scrollLeft;
      rail.scrollLeft += delta;
      if (before !== rail.scrollLeft) update(current);
    }
  }
  function finish(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    clear();
    if (!current.moving) return;
    ignoreClick.current = true;
    ignoreDoubleClick.current = true;
    if (!commit || current.owner !== owner) return;
    const destination = target(event.clientX, event.clientY,current.source);
    if (destination) drop(current.source, destination);
  }
  function bindings(source: PaneLive) {
    return {
      'data-session-drag-handle': true,
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (!event.isPrimary || event.button !== 0) return;
        ignoreClick.current = false;
        gesture.current = { source: { ...source }, owner, pointer: event.pointerId, x: event.clientX, y: event.clientY, moving: false };
        // Keep current pane's input focus until a click or an actual drop.
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        if (!current.moving) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
          current.moving = true;
          frame.current = requestAnimationFrame(scrollRail);
        }
        current.x = event.clientX;
        current.y = event.clientY;
        update(current);
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
      onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finish(event, false),
      onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => finish(event, false),
    };
  }
  function cancelOnKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'Escape' || !gesture.current) return false;
    event.preventDefault();
    ignoreClick.current = true;
    ignoreDoubleClick.current = true;
    clear();
    return true;
  }
  // Escape can also arrive on the pane that held focus before a pointer drag.
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current?.moving) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ignoreClick.current = true;
      ignoreDoubleClick.current = true;
      clear();
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, []);
  function allowedClick(event: MouseEvent<HTMLButtonElement>) {
    if (!event.detail || !ignoreClick.current) {
      if(event.detail===1)ignoreDoubleClick.current=false;
      return true;
    }
    ignoreClick.current = false;
    return false;
  }
  return { preview, bindings, cancelOnKey, allowedClick, allowedDoubleClick:()=>!ignoreDoubleClick.current };
}

export type SessionDrag = ReturnType<typeof useSessionDrag>;
const directions = { left: '左侧', right: '右侧', top: '上方', bottom: '下方' } as const;

export function SessionDragPreview({ destination, detached }: { destination?: TabDrop; detached: boolean }) {
  if (destination?.kind === 'detach') return createPortal(
    <div className="tab-detach-preview" aria-hidden="true">{detached ? '拖到主窗口可移回会话' : '松开后移到独立窗口'}</div>, document.body);
  if(destination?.kind==='merge'){
    const {bounds}=destination;
    return createPortal(<div className="tab-merge-preview" aria-hidden="true"
      style={{left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height}}>并入此窗格</div>,document.body);
  }
  if (destination?.kind !== 'split') return null;
  const { bounds, edge } = destination;
  return createPortal(<div className="tab-split-preview" data-edge={edge} aria-hidden="true"
    style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
      '--drop-size': '50%' } as CSSProperties}>
    <span className="tab-split-fill" />
    <div className="tab-direction-guide">{Object.entries(directions).map(([direction, name]) =>
      <span key={direction} data-direction={direction} data-chosen={direction === edge ? '' : undefined}>{name}</span>)}</div>
  </div>, document.body);
}
