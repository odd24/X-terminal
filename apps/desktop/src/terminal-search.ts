import type { IBuffer } from '@xterm/xterm';

export type TerminalMatch = { row: number; col: number; length: number };
/** Literal, case-sensitive search of the active retained buffer, using cell coordinates. */
export function searchTerminal(buffer: IBuffer, cols: number, query: string) {
  const matches: TerminalMatch[] = [];
  if (!query || query.length > 256 || /[\r\n]/.test(query)) return { matches, limited: false };
  let text = '';
  let cells: { row: number; col: number; width: number }[] = [];
  let budget = 1024 * 1024;
  let limited = false;
  function scan() {
    let offset = 0;
    while ((offset = text.indexOf(query, offset)) !== -1) {
      if (matches.length === 1000) { limited = true; return; }
      const start = cells[offset], end = cells[offset + query.length - 1];
      matches.push({ row: start.row, col: start.col, length: (end.row - start.row) * cols + end.col + end.width - start.col });
      offset += query.length;
    }
    text = ''; cells = [];
  }
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (!line.isWrapped) scan();
    if (limited) break;
    // Retain padding only when the next physical row continues this logical line.
    const continuation = buffer.getLine(row + 1);
    const wraps = continuation?.isWrapped;
    // A wide glyph that did not fit leaves an empty last cell, not a space.
    const widePadding = wraps && continuation.getCell(0)?.getWidth() === 2 && line.getCell(cols - 1)?.getCode() === 0;
    const end = widePadding ? cols - 1 : cols;
    let part = '';
    const mapped: typeof cells = [];
    for (let col = 0; col < end; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      part += chars;
      for (let i = 0; i < chars.length; i++) mapped.push({ row, col, width: cell.getWidth() });
    }
    if (!buffer.getLine(row + 1)?.isWrapped) { const trimmed = part.trimEnd(); mapped.length = trimmed.length; part = trimmed; }
    if (part.length > budget) { limited = true; break; }
    budget -= part.length; text += part; cells.push(...mapped);
  }
  if (!limited) scan();
  return { matches, limited };
}
