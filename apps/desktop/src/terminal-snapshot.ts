type Line = { translateToString(trimRight: boolean, start?: number, end?: number): string };
export type DisplayBuffer = { length: number; viewportY: number; getLine(index: number): Line | undefined };
export type DisplaySnapshot = { text: string; top: number; rows: number; cols: number };
// This is the rendered active buffer, not the service's real-time bottom screen.
// Keep physical rows, blank lines and trailing spaces. No ANSI or input is sent.
export function freezeDisplay(buffer: DisplayBuffer, cols: number, rows: number, visible: boolean): DisplaySnapshot {
  const top = visible ? buffer.viewportY : 0;
  const count = visible ? rows : buffer.length;
  if (!Number.isInteger(top) || top < 0 || !Number.isInteger(cols) || cols < 1 || cols > 2048 || !Number.isInteger(count) || count < 1 || count > 2048) throw new Error('显示范围超过导出上限，未截断或改用其他范围。');
  const lines: string[] = []; let bytes = 0;
  for (let i = 0; i < count; i++) {
    const text = buffer.getLine(top + i)?.translateToString(false, 0, cols) ?? ' '.repeat(cols);
    bytes += new TextEncoder().encode(text).length + 2;
    if (bytes > 4 * 1024 * 1024) throw new Error('显示文字超过 4 MiB，未截断导出。');
    lines.push(text);
  }
  return { text: lines.join('\r\n') + '\r\n', top, rows: count, cols };
}
