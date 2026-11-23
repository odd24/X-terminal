import assert from 'node:assert/strict';
import test from 'node:test';
import {insertShortcuts,moveShortcutToEdge,setShortcutPins,stepShortcuts} from '../apps/desktop/src/local-shortcut-order.ts';

const items=['a','b','c','d','e','f'].map((id,i)=>({id,pinned:i<2}));
const select=(...ids)=>new Set(ids);
const order=rows=>rows.map(item=>item.id).join('');

test('pin and unpin append only changed entries and preserve both relative orders',()=>{
  assert.equal(order(setShortcutPins(items,select('a','c','e'),true)),'abcedf');
  assert.equal(order(setShortcutPins(items,select('a','c'),false)),'bcdefa');
  assert.equal(order(items),'abcdef');
});

test('one-step moves preserve selection order and never cross a pinned boundary',()=>{
  assert.equal(order(stepShortcuts(items,select('a','c','e'),1)),'badcfe');
  assert.equal(order(stepShortcuts(items,select('d','e'),-1)),'abdecf');
  assert.equal(stepShortcuts(items,select('b'),1),undefined);
  assert.equal(stepShortcuts(items,select('c'),-1),undefined);
});

test('drag moves the source region selection as a stable block',()=>{
  assert.equal(order(insertShortcuts(items,select('a','c','e'),'c','f',true)),'abdfce');
  assert.equal(insertShortcuts(items,select('a'),'a','c',true),undefined);
  assert.equal(insertShortcuts(items,select('c','d'),'c','d',true),undefined);
  assert.equal(insertShortcuts(items,select('c'),'c','d',false),undefined);
});

test('move to either edge preserves peer order and stays within the existing region',()=>{
  assert.equal(order(moveShortcutToEdge(items,'b','first')),'bacdef');
  assert.equal(order(moveShortcutToEdge(items,'a','last')),'bacdef');
  assert.equal(order(moveShortcutToEdge(items,'e','first')),'abecdf');
  assert.equal(order(moveShortcutToEdge(items,'d','last')),'abcefd');
  assert.equal(moveShortcutToEdge(items,'a','first'),undefined);
  assert.equal(moveShortcutToEdge(items,'f','last'),undefined);
  assert.equal(moveShortcutToEdge(items,'missing','first'),undefined);
  assert.equal(order(items),'abcdef');
});
