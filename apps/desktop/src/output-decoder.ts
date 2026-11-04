/** Per-connection display state. Raw output is never modified by this decoder. */
export class OutputDecoder {
  private decoder: TextDecoder;
  private encoder = new TextEncoder();
  private finished = false;
  readonly encoding: string;

  constructor(encoding: string) {
    const labels: Record<string, string> = { utf8: 'utf-8', gbk: 'gbk', gb18030: 'gb18030' };
    if (!Object.hasOwn(labels, encoding)) throw new Error('Unsupported output encoding');
    this.encoding = encoding;
    this.decoder = new TextDecoder(labels[encoding], { ignoreBOM: true });
  }

  decode(bytes: Uint8Array, last = false): { bytes: Uint8Array; replacement: boolean } {
    if (this.finished) throw new Error('Output decoder already finished');
    if (bytes.length > 65536) throw new Error('Output chunk exceeds 64 KiB');
    const text = this.decoder.decode(bytes, { stream: !last });
    this.finished = last;
    // U+FFFD may also have been present literally. Do not claim an exact error count.
    return { bytes: this.encoder.encode(text), replacement: text.includes('\uFFFD') };
  }

  finish(): { bytes: Uint8Array; replacement: boolean } {
    return this.finished ? { bytes: new Uint8Array(), replacement: false } : this.decode(new Uint8Array(), true);
  }
}
