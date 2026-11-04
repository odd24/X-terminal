import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteralLogSearch, visibleControls } from '../apps/desktop/src/log-search.ts';
const event = (seq, text, gap_bytes = null) => ({ seq, text, gap_bytes });
test('literal search spans arbitrary records and preserves first/last source text sequence', () => {
  const matcher = new LiteralLogSearch('中文😀tail');
  const results = [event(10, 'prefix中'), event(11, ''), event(12, '文😀ta'), event(13, 'il suffix')].flatMap(e => matcher.push(e));
  assert.equal(results.length, 1); assert.deepEqual([results[0].firstSeq, results[0].lastSeq], [10,13]);
  assert.ok(results[0].excerpt.includes('中文😀tail'));
  assert.equal(matcher.push(event(14, 'extra')).length, 0, 'carry must not duplicate old matches');
});
test('gaps sever continuity while empty/final text and literal control sequences remain searchable', () => {
  const matcher = new LiteralLogSearch('abc');
  matcher.push(event(1, 'ab')); matcher.push(event(2, '', 13));
  assert.equal(matcher.push(event(3, 'c')).length, 0);
  matcher.push(event(4, 'ab')); assert.equal(matcher.push(event(5, 'c')).length,1);
  const controls = new LiteralLogSearch('\0\x1b[31m');
  assert.equal(controls.push(event(1, '\0\x1b[')).length,0);
  assert.equal(controls.push(event(2, '31m')).length,1);
  assert.equal(new LiteralLogSearch('ABC').push(event(1, 'abc')).length, 0);
  assert.equal(new LiteralLogSearch('.*').push(event(1, 'x.*y')).length,1);
});
test('overlapping matches across records remain exact and display cap never truncates full scan counts', () => {
  const matcher = new LiteralLogSearch('aa');
  assert.equal(matcher.push(event(1, 'aa')).length,1);
  assert.equal(matcher.push(event(2, 'aa')).length,2);
  const many = new LiteralLogSearch('x');
  assert.equal(many.push(event(1, 'x'.repeat(16384))).length,100);
  assert.equal(many.limited,true); assert.deepEqual(many.push(event(2, 'x')),[]);
  assert.equal(many.total,16385);
  assert.throws(() => new LiteralLogSearch('')); assert.throws(() => new LiteralLogSearch('x'.repeat(257)));
});
test('control display makes ANSI, CR, NUL and bidi formatting visible without altering normal Chinese or newlines', () => {
  assert.equal(visibleControls('\0\x1b[31m中文\r\n\t\u202eX\u2066Y'), '\\x00\\x1b[31m中文\\x0d\n\t\\u202eX\\u2066Y');
  assert.equal(visibleControls('<script>literal</script>'),'<script>literal</script>');
});
