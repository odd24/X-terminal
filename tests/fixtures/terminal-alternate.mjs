const w = text => ({ kind: 'write', text });
const r = (rows, cols) => ({ kind: 'resize', rows, cols });
const fixtures = [];
for (const mode of [47, 1047, 1049]) {
  const enter = `\x1b[?${mode}h`, exit = `\x1b[?${mode}l`;
  fixtures.push({ name: `alternate-${mode}-lifecycle`, rows: 4, cols: 12, steps: [
    w('normal\x1b[3;4H'), w(enter), w('中A'), w(enter), w('B'), w(exit),
    w(enter), w('Z'), w(exit), w(exit),
  ] });
  fixtures.push({ name: `alternate-${mode}-background-resize`, rows: 4, cols: 12, steps: [
    w('one\r\ntwo\r\nthree\r\nfour\r\nend'), w(enter),
    w('\x1b[H替代abcdef\r\nnext'), r(6, 5), r(3, 16), w(exit), w('!'),
  ] });
}
fixtures.push({ name: 'alternate-independent-saved-rendition', rows: 4, cols: 12, steps: [
  w('\x1b[31mnormal\x1b[3;4H'), w('\x1b[?1049h'),
  w('\x1b[32m\x1b[2;2H\x1b7A\x1b[4;6H\x1b[34m'),
  w('\x1b[?1049h'), w('B'), w('\x1b8C'), w('\x1b[?1049l!'),
  w('\x1b[?1049h'), w('\x1b8D'), w('\x1b[?1049l?'),
] });
fixtures.push({ name: 'alternate-colored-blank-and-pending-wrap', rows: 3, cols: 5, steps: [
  w('\x1b[1;31;44mabcde'), w('\x1b[?47h'), w('X'), w('\x1b[?47l'),
  w('Y'), w('\x1b[?1047h'), w('\x1b[?1047l'), w('\x1b[0m!'),
] });
fixtures.push({ name: 'alternate-1048-save-restore', rows: 4, cols: 12, steps: [
  w('\x1b[31mnormal\x1b[3;4H\x1b[?1048h'), w('\x1b[1;1H\x1b[32mA'),
  w('\x1b[?1048l!'), w('\x1b[?1047h\x1b[2;2H\x1b[?1048h'),
  w('\x1b[3;7H\x1b[?1048lZ'), w('\x1b[?1047l'),
] });
export default fixtures;
