import { createHash } from 'node:crypto';
const color = (mode, value) => mode === 0 ? null : mode === 0x3000000 ? ['rgb', value >>> 16 & 255, value >>> 8 & 255, value & 255] : ['index', value];
export function snapshot(term) {
  const buffer = term.buffer.active;
  return { rows: term.rows, cols: term.cols, history: buffer.baseY, cursor: [buffer.cursorY, buffer.cursorX], alternate: buffer.type === 'alternate',
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      // Circular storage can return a retired slot beyond buffer.length.
      // Only a retained successor defines the outgoing wrap relation.
      return { wrapsToNext: index + 1 < buffer.length && !!buffer.getLine(index + 1)?.isWrapped, cells: Array.from({ length: term.cols }, (_, col) => {
        const cell = line.getCell(col);
        return { text: cell.getChars(), width: cell.getWidth(), fg: color(cell.getFgColorMode(), cell.getFgColor()), bg: color(cell.getBgColorMode(), cell.getBgColor()),
          bold: !!cell.isBold(), dim: !!cell.isDim(), italic: !!cell.isItalic(), underline: !!cell.isUnderline(), inverse: !!cell.isInverse() };
      }) };
    }) };
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function firstDifference(a, b, path = '') {
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return a === b ? null : { path, xterm: a, vt100: b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDifference(a[key], b[key], `${path}/${key}`);
    if (found) return found;
  }
  return null;
}
