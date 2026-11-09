import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
const { Terminal } = headless;
import { freezeDisplay } from '../apps/desktop/src/terminal-snapshot.ts';
const write=(term,text)=>new Promise(resolve=>term.write(text,resolve));
test('visible snapshot freezes the scrolled viewport with ANSI rendered, wide text and whitespace',async()=>{
 const term=new Terminal({allowProposedApi:true,cols:8,rows:3,scrollback:512});
 await write(term,'\x1b[31m中文  \x1b[0m\r\n\r\nthird   \r\nBOTTOM  \r\nEND');
 term.scrollToTop();const frozen=freezeDisplay(term.buffer.active,term.cols,term.rows,true);
 assert.equal(frozen.top,0);assert.equal(frozen.text,'中文    \r\n        \r\nthird   \r\n');
 term.scrollToBottom();await write(term,'-changed');assert.equal(frozen.text,'中文    \r\n        \r\nthird   \r\n');
 assert.notEqual(freezeDisplay(term.buffer.active,term.cols,term.rows,true).text,frozen.text);
 const all=freezeDisplay(term.buffer.active,term.cols,term.rows,false);assert.ok(all.rows>3);assert.ok(all.text.includes('中文'));assert.ok(all.text.includes('BOTTOM'));assert.equal(all.text.includes('\x1b'),false);term.dispose();
});
test('alternate-screen snapshot uses its actual buffer and oversized ranges fail without truncation',async()=>{
 const term=new Terminal({allowProposedApi:true,cols:5,rows:2,scrollback:512});await write(term,'normal\x1b[?1049h\x1b[HALT');
 const frozen=freezeDisplay(term.buffer.active,term.cols,term.rows,true);assert.equal(frozen.text,'ALT  \r\n     \r\n');assert.equal(frozen.text.includes('normal'),false);
 assert.throws(()=>freezeDisplay(term.buffer.active,2049,2,true));assert.throws(()=>freezeDisplay({length:2049,viewportY:0,getLine:()=>undefined},5,2,false));term.dispose();
});
