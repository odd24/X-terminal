import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lightweightDrop,validFileDrop} from '../apps/desktop/src/local-file-drop.ts';

test('a whole file drop requires bounded absolute Windows paths without terminal controls',()=>{
  const paths=['C:\\文件 $ and space','\\\\server\\share\\file','\\\\?\\C:\\long path','\\\\?\\UNC\\server\\share'];
  assert.equal(validFileDrop(paths),true);
  for(const path of ['relative','C:relative','\\rooted','\\\\.\\pipe\\data','C:\\line\nbreak','C:\\bad"','C:\\bad\x1b','C:\\bad\u0085','C:\\'+('长'.repeat(3000))]){
    assert.equal(validFileDrop([paths[0],path]),false,JSON.stringify(path));
  }
  assert.equal(validFileDrop([]),false);
  assert.equal(validFileDrop(Array(129).fill(paths[0])),false);
});

test('lightweight file insertion preserves path order, trailing slashes and Unicode cursor position',()=>{
  const paths=["C:\\甲 ' $ &", 'D:\\tail\\'];
  assert.equal(lightweightDrop(paths,'😀goTAIL',3),' "C:\\甲 \' $ &" "D:\\tail\\\\" ');
  assert.equal(lightweightDrop(paths,'go  TAIL',3),'"C:\\甲 \' $ &" "D:\\tail\\\\"');
  assert.equal(lightweightDrop(paths,'go "open term"',7),undefined);
  assert.equal(lightweightDrop(paths,'go \\" word',5),' "C:\\甲 \' $ &" "D:\\tail\\\\"');
});
