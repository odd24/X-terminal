export type TabEdge = 'left' | 'right' | 'top' | 'bottom';
export type TabDrop =
  | { kind: 'insert'; anchor: string; after: boolean }
  | { kind: 'group'; group: string }
  | { kind: 'split'; edge: TabEdge; bounds: DOMRect }
  | { kind: 'detach' };

export function locateTabDrop(x: number, y: number, rail: HTMLElement): TabDrop | undefined {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { kind: 'detach' };

  const hit = document.elementFromPoint(x, y);
  if (!hit) return;
  if (rail.contains(hit)) {
    const marker = hit.closest<HTMLElement>('.tab-group-marker');
    if (marker?.dataset.groupId !== undefined) return { kind: 'group', group: marker.dataset.groupId };
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
    const anchor = location?.tab.querySelector<HTMLElement>('[data-connection-id]')?.dataset.connectionId;
    if (location && anchor) return { kind: 'insert', anchor, after: x > location.rect.left + location.rect.width / 2 };
    return;
  }
  const terminal = hit.closest('.terminal-grid');
  if (!terminal) return;
  const bounds = terminal.getBoundingClientRect();
  const distances: [TabEdge, number][] = [
    ['left', x - bounds.left], ['right', bounds.right - x],
    ['top', y - bounds.top], ['bottom', bounds.bottom - y],
  ];
  const [edge, distance] = distances.reduce((nearest, next) => next[1] < nearest[1] ? next : nearest);
  if (distance <= 42) return { kind: 'split', edge, bounds };
}
