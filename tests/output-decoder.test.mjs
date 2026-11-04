import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputDecoder } from '../apps/desktop/src/output-decoder.ts';

const text = result => new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.bytes);
test('all partitions of UTF8, GBK and GB18030 preserve Chinese, supplementary and ANSI text', () => {
  const samples = [
    ['utf8', [...Buffer.from('\x1b[31m中文😀\x1b[0m\r\n')], '\x1b[31m中文😀\x1b[0m\r\n'],
    ['gbk', [27,91,51,49,109,214,208,206,196,27,91,48,109,13,10], '\x1b[31m中文\x1b[0m\r\n'],
    ['gb18030', [214,208,144,48,129,48,13,10], '中\u{10000}\r\n'],
  ];
  for (const [encoding, raw, expected] of samples) {
    for (let boundary = 0; boundary <= raw.length; boundary++) {
      const decoder = new OutputDecoder(encoding);
      const first = decoder.decode(new Uint8Array(raw.slice(0, boundary)));
      const second = decoder.decode(new Uint8Array(raw.slice(boundary)));
      assert.equal(text(first) + text(second) + text(decoder.finish()), expected);
      assert.equal(first.replacement || second.replacement, false);
    }
    const decoder = new OutputDecoder(encoding);
    assert.equal(raw.map(byte => text(decoder.decode(new Uint8Array([byte])))).join('') + text(decoder.finish()), expected);
  }
});

test('EOF flushes incomplete bytes once; reset cannot combine bytes from different streams', () => {
  for (const [encoding, prefix, suffix] of [['utf8', [0xe4], [0xb8,0xad]], ['gbk', [0xd6], [0xd0]], ['gb18030', [0x90,0x30], [0x81,0x30]]]) {
    const old = new OutputDecoder(encoding);
    assert.equal(text(old.decode(new Uint8Array(prefix))), '');
    assert.equal(old.finish().replacement, true);
    assert.equal(text(old.finish()), '');
    assert.throws(() => old.decode(new Uint8Array(suffix)), /finished/);
    const fresh = new OutputDecoder(encoding);
    assert.notEqual(text(fresh.decode(new Uint8Array(suffix))) + text(fresh.finish()), encoding === 'gb18030' ? '\u{10000}' : '中');
  }
});

test('bounds input, rejects unknown encodings, preserves BOM and distinguishes no exact error count', () => {
  assert.throws(() => new OutputDecoder('auto'), /Unsupported/);
  const decoder = new OutputDecoder('utf8');
  assert.throws(() => decoder.decode(new Uint8Array(65537)), /64 KiB/);
  assert.equal(text(decoder.decode(new Uint8Array(65536).fill(65))).length, 65536);
  assert.equal(text(decoder.decode(new Uint8Array([239,187,191]))), '\uFEFF');
  assert.equal(decoder.decode(new Uint8Array([255])).replacement, true);
  assert.equal(decoder.decode(new Uint8Array([239,191,189])).replacement, true, 'literal replacement is also flagged');
  const raw = new Uint8Array(4096).fill(255);
  const decoded = decoder.decode(raw);
  assert.equal(decoded.bytes.length, 4096 * 3, 'largest public raw event fits the existing writer chunk cap');
  assert.ok(raw.every(byte => byte === 255), 'decoding does not modify raw input');
});
