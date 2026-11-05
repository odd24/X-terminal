import { test } from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { searchTerminal } from '../apps/desktop/src/terminal-search.ts';
const write = (term, text) => new Promise(resolve => term.write(text, resolve));
test('literal buffer search maps wraps, wide and supplementary cells and excludes hard line boundaries', async () => {
  const term = new headless.Terminal({cols:10, rows:3, scrollback:512, allowProposedApi:true});
  try {
    await write(term, '12345678中文😀e\u0301\r\nA.*B\r\nNEXT');
    const result = searchTerminal(term.buffer.active,10,'中文😀e\u0301');
    assert.deepEqual(result.matches,[{row:0,col:8,length:6}]);
    assert.equal(searchTerminal(term.buffer.active,10,'A.*B').matches.length,1);
    assert.equal(searchTerminal(term.buffer.active,10,'B NEXT').matches.length,0);
    await write(term,'\x1b[?1049hALT');
    assert.equal(searchTerminal(term.buffer.active,10,'中文').matches.length,0);
    assert.equal(searchTerminal(term.buffer.active,10,'ALT').matches.length,1);
  } finally { term.dispose(); }
});
test('search is bounded, rejects empty/oversized/multiline queries and searches only retained history', async () => {
  const term = new headless.Terminal({cols:80, rows:3, scrollback:512, allowProposedApi:true});
  try {
    await write(term,'OLD\r\n' + ('x'.repeat(80)+'\r\n').repeat(520));
    assert.equal(searchTerminal(term.buffer.active,80,'OLD').matches.length,0);
    const result=searchTerminal(term.buffer.active,80,'x');
    assert.equal(result.matches.length,1000);assert.equal(result.limited,true);
    for(const query of ['', 'x'.repeat(257), 'x\nx']) assert.equal(searchTerminal(term.buffer.active,80,query).matches.length,0);
  } finally { term.dispose(); }
});

test('wide glyph wrap padding does not become a searchable space', async () => {
  const term = new headless.Terminal({cols:9, rows:3, allowProposedApi:true});
  try {
    await write(term,'12345678中文');
    assert.deepEqual(searchTerminal(term.buffer.active,9,'8中').matches,[{row:0,col:7,length:4}]);
    assert.equal(searchTerminal(term.buffer.active,9,'8 中').matches.length,0);
  } finally { term.dispose(); }
});
