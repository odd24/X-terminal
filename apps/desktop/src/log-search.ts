// Literal, case-sensitive streaming search over decoded text, never screen or
// raw bytes. Gaps sever continuity. Memory is bounded by one event and pattern.
export type SearchEvent = { seq: number; text: string; gap_bytes: number | null };
export type LogMatch = { firstSeq: number; lastSeq: number; excerpt: string };
export class LiteralLogSearch {
  private needle: string;
  private carry = '';
  private origins: number[] = [];
  private count = 0;
  readonly limit = 100;
  constructor(needle: string) {
    if (!needle.length || needle.length > 256) throw new Error('搜索内容为空或过长。');
    this.needle = needle;
  }
  get total() { return this.count; }
  get limited() { return this.count > this.limit; }
  push(event: SearchEvent): LogMatch[] {
    if (event.gap_bytes !== null) { this.carry = ''; this.origins = []; return []; }
    const combined = this.carry + event.text;
    const boundary = this.carry.length;
    const matches: LogMatch[] = [];
    let offset = 0;
    for (;;) {
      const start = combined.indexOf(this.needle, offset);
      if (start < 0) break;
      const end = start + this.needle.length;
      if (end > boundary) {
        if (this.count < this.limit) matches.push({ firstSeq: start < boundary ? this.origins[start] : event.seq, lastSeq: event.seq, excerpt: combined.slice(Math.max(0, start - 24), Math.min(combined.length, end + 24)) });
        this.count++;
      }
      offset = start + 1;
    }
    const keep = Math.min(this.needle.length - 1, combined.length);
    const from = combined.length - keep;
    this.origins = Array.from({ length: keep }, (_, index) => from + index < boundary ? this.origins[from + index] : event.seq);
    this.carry = combined.slice(from);
    return matches;
  }
}
export function visibleControls(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, char => {
    const code = char.charCodeAt(0);
    return code <= 255 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
