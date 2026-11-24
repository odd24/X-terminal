import {useEffect, useRef} from 'react';
import {getCurrentWebview} from '@tauri-apps/api/webview';

const MAX_DROP_BYTES = 8192;
const MAX_DROP_PATHS = 128;
const absolutePath = /^(?:(?:\\\\\?\\)?[A-Za-z]:\\|\\\\(?:\?\\UNC\\)?[^\\:?.][^\\:?]*\\[^\\:?]+(?:\\|$))/i;

export function validFileDrop(paths: readonly string[]) {
  return paths.length > 0 && paths.length <= MAX_DROP_PATHS
    && new TextEncoder().encode(paths.join('\0')).length < MAX_DROP_BYTES
    && paths.every(path => absolutePath.test(path)
      && !/[\p{Cc}\p{Cs}"<>|*]/u.test(path) && !path.replace(/^\\\\\?\\/, '').includes('?'));
}

export function lightweightDrop(paths: readonly string[], text: string, cursor: number) {
  if (!validFileDrop(paths)) return;
  const characters = Array.from(text);
  const left = characters.slice(0, cursor).join('');
  const right = characters.slice(cursor).join('');
  let quoted = false;
  let slashes = 0;
  for (const character of left) {
    if (character === '\\') {
      slashes++;
      continue;
    }
    if (character === '"' && slashes % 2 === 0) quoted = !quoted;
    slashes = 0;
  }
  if (quoted) return;
  const payload = paths.map(path => '"' + path.replace(/\\+$/, value => value + value) + '"').join(' ');
  return (left && !left.endsWith(' ') ? ' ' : '') + payload + (right && !right.startsWith(' ') ? ' ' : '');
}

export type FileDropRoute = {
  identity(): string | undefined;
  insert(paths: string[], identity: string): void;
};

type Position = {x: number; y: number};
type Target = {element: HTMLElement; route: FileDropRoute; identity: string};

export function useLocalFileDrop(enabled: boolean) {
  const routes = useRef(new Map<HTMLElement, FileDropRoute>());
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let position: Position | undefined;
    let target: Target | undefined;
    let animation = 0;
    const invalidated = new Set<HTMLElement>();
    const hit = (point: Position) => document.elementFromPoint(point.x / devicePixelRatio, point.y / devicePixelRatio)
      ?.closest<HTMLElement>('.local-terminal-output');
    function clear() {
      target?.element.removeAttribute('data-file-drop-target');
      target = undefined;
    }
    function reset() {
      clear();
      position = undefined;
      invalidated.clear();
      cancelAnimationFrame(animation);
    }
    function current(point: Position) {
      return target && hit(point) === target.element && routes.current.get(target.element) === target.route
        && target.route.identity() === target.identity;
    }
    function observe() {
      if (!position) return;
      if (target && !current(position)) {
        invalidated.add(target.element);
        clear();
      }
      animation = requestAnimationFrame(observe);
    }
    function move(point: Position) {
      if (position?.x === point.x && position.y === point.y) return;
      position = point;
      if (current(point)) return;
      if (target && target.route.identity() !== target.identity) invalidated.add(target.element);
      clear();
      const element = hit(point);
      if (!element || invalidated.has(element)) return;
      const route = routes.current.get(element);
      const identity = route?.identity();
      if (!route || identity === undefined) return;
      target = {element, route, identity};
      element.setAttribute('data-file-drop-target', '');
    }
    void getCurrentWebview().onDragDropEvent(({payload}) => {
      if (disposed) return;
      switch (payload.type) {
        case 'enter':
          reset();
          if (validFileDrop(payload.paths)) {
            move(payload.position);
            animation = requestAnimationFrame(observe);
          }
          break;
        case 'over':
          if (position) move(payload.position);
          break;
        case 'drop': {
          const destination = current(payload.position) ? target : undefined;
          reset();
          if (destination && validFileDrop(payload.paths)) {
            destination.route.insert(payload.paths, destination.identity);
          }
          break;
        }
        case 'leave':
          reset();
          break;
      }
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => {
      if (!disposed) console.error('本地文件拖放监听失败', error);
    });
    return () => {
      disposed = true;
      reset();
      unlisten?.();
    };
  }, [enabled]);
  return routes.current;
}
