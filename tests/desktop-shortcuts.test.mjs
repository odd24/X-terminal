import assert from 'node:assert/strict';
import test from 'node:test';
import {desktopShortcut} from '../apps/desktop/src/desktop-shortcuts.ts';

const key=(key,fields={})=>desktopShortcut({key,code:'',getModifierState:()=>false,...fields});

test('cycle and direct positions use current-pane indexes',()=>{
  assert.deepEqual(key('Tab',{ctrlKey:true}),{kind:'cycle',step:1});
  assert.deepEqual(key('Tab',{ctrlKey:true,shiftKey:true}),{kind:'cycle',step:-1});
  assert.deepEqual(key('9',{altKey:true}),{kind:'index',index:8});
  assert.deepEqual(key('0',{altKey:true}),{kind:'index',index:9});
  assert.deepEqual(key('End',{altKey:true,code:'Numpad1'}),{kind:'index',index:0});
  assert.deepEqual(key('&',{altKey:true,code:'Digit1'}),{kind:'index',index:0});
});

test('terminal shortcuts do not capture normal tabs, composition, AltGr, or other chords',()=>{
  for(const [letter,kind] of [['T','openLocal'],['b','sidebar'],['F','search']]){
    assert.deepEqual(key(letter,{ctrlKey:true,shiftKey:true}),{kind});
  }
  assert.equal(key('Tab'),undefined);
  assert.equal(key('1',{altKey:true,ctrlKey:true}),undefined);
  assert.equal(key('1',{altKey:true,shiftKey:true}),undefined);
  assert.equal(key('1',{altKey:true,getModifierState:modifier=>modifier==='AltGraph'}),undefined);
  assert.equal(key('F',{ctrlKey:true,shiftKey:true,isComposing:true}),undefined);
  assert.equal(key('F',{ctrlKey:true,shiftKey:true,keyCode:229}),undefined);
  assert.equal(key('F',{ctrlKey:true,shiftKey:true,metaKey:true}),undefined);
});
