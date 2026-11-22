import type {PaneKey} from './pane-layout';
export type TabEdge = 'left' | 'right' | 'top' | 'bottom';
export type TabDrop =
  | { kind: 'insert'; anchor: string; after: boolean }
  | { kind: 'group'; group: string; pane:PaneKey }
  | { kind: 'merge'; pane:PaneKey; bounds:DOMRect }
  | { kind: 'split'; pane:PaneKey; edge: TabEdge; bounds: DOMRect }
  | { kind: 'detach' };

export function locateTabDrop(x: number, y: number): TabDrop | undefined {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { kind: 'detach' };

  const hit = document.elementFromPoint(x, y);
  if (!hit) return;
  const pane=hit.closest<HTMLElement>('[data-pane]')?.dataset.pane as PaneKey|undefined;
  if(!pane)return;
  const rail=hit.closest('.pane-tab-bar')?.querySelector<HTMLElement>('[role="tablist"]');
  if (rail) {
    const marker = hit.closest<HTMLElement>('.tab-group-marker');
    if (marker?.dataset.groupId !== undefined) return { kind: 'group', group: marker.dataset.groupId, pane };
    const bounds = rail.getBoundingClientRect();
    const candidates = [...rail.querySelectorAll<HTMLElement>('.connection-tab')]
      .map(tab => ({ tab, rect: tab.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > bounds.left && rect.left < bounds.right);
    const hovered = hit.closest('.connection-tab');
    const location = candidates.find(({ tab }) => tab === hovered)
      ?? candidates.reduce<(typeof candidates)[number] | undefined>((nearest, item) => {
        const center = ({ rect }: typeof item) => rect.left + rect.width / 2;
        return !nearest || Math.abs(center(item) - x) < Math.abs(center(nearest) - x) ? item : nearest;
      }, undefined);
    const anchor = location?.tab.querySelector<HTMLElement>('[role="tab"]')?.dataset.connectionId;
    if (location && anchor) return { kind: 'insert', anchor, after: x > location.rect.left + location.rect.width / 2 };
    return {kind:'merge',pane,bounds};
  }
  const terminal = hit.closest('.terminal-pane > .terminal, .local-pane-body');
  if (!terminal) return;
  const bounds = terminal.getBoundingClientRect();
  const horizontal = (x - bounds.left) / bounds.width - .5;
  const vertical = (y - bounds.top) / bounds.height - .5;
  if(Math.abs(horizontal)<=.25&&Math.abs(vertical)<=.25)return {kind:'merge',pane,bounds};
  const edge = Math.abs(horizontal) >= Math.abs(vertical)
    ? horizontal < 0 ? 'left' : 'right'
    : vertical < 0 ? 'top' : 'bottom';
  return { kind: 'split', pane, edge, bounds };
}
