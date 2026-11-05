import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalClipboard, preparePaste } from '../apps/desktop/src/terminal-clipboard.ts';
const target={connection_id:'a',generation:1,protocol:'SSH2'};
function fixture() {
  let scope={...target}, bracketed=false, proposal;
  const sent=[], messages=[], copied=[];
  let reader=async()=> 'clipboard';
  const clip=new TerminalClipboard({target:()=>scope,bracketed:()=>bracketed,send:text=>sent.push(text),proposal:p=>{proposal=p;},message:text=>messages.push(text),read:()=>reader(),write:async text=>{copied.push(text);},selection:()=> '中文 selected'});
  return {clip,sent,messages,copied,setScope:value=>{scope=value;},setMode:value=>{bracketed=value;},setReader:value=>{reader=value;},get proposal(){return proposal;}};
}
test('paste preserves CR/LF and controls, brackets only on request and bounds complete payload', () => {
  const text='甲\r\n乙\n丙\r';
  assert.equal(preparePaste(text,target,0,false).payload,text);
  const p=preparePaste(text,target,0,true);assert.equal(p.payload,'\x1b[200~'+text+'\x1b[201~');assert.equal(p.confirm,true);
  assert.throws(()=>preparePaste('a\x1b[201~b',target,0,true),/边界/);
  assert.equal(preparePaste('\x03',target,0,false).confirm,true);
  assert.throws(()=>preparePaste('\ud800',target,0,false),/Unicode/);
  assert.throws(()=>preparePaste('x'.repeat(196608),target,0,true),/上限/);
  assert.throws(()=>preparePaste('中'.repeat(22000),{...target,protocol:'SERIAL'},0,false),/上限/);
});
test('one-shot confirmation is bound to generation, connection, mode and object identity', async () => {
  for(const mutate of [f=>f.setScope({...target,generation:2}),f=>f.setScope({...target,connection_id:'b'}),f=>f.setMode(true),f=>f.setScope(undefined)]) {
    const f=fixture();await f.clip.paste('a\nb');const p=f.proposal;
    f.clip.confirm({...p});assert.equal(f.sent.length,0);
    mutate(f);f.clip.confirm(p);assert.equal(f.sent.length,0);assert.equal(f.proposal,undefined);
  }
  const f=fixture();await f.clip.paste('a\r\nb');const p=f.proposal;f.clip.confirm(p);f.clip.confirm(p);
  assert.deepEqual(f.sent,['a\r\nb']);
});
test('cancel/input/selection epoch discard pending and late reads even after switching back', async () => {
  const f=fixture();let resolve;f.setReader(()=>new Promise(r=>{resolve=r;}));
  const read=f.clip.paste();f.clip.invalidate();resolve('late\npaste');await read;assert.equal(f.proposal,undefined);assert.equal(f.sent.length,0);
  await f.clip.paste('draft\n');const p=f.proposal;f.clip.invalidate();f.clip.confirm(p);assert.equal(f.sent.length,0);
  await f.clip.paste('first\n');const old=f.proposal;await f.clip.paste('second\n');f.clip.confirm(old);assert.equal(f.sent.length,0);f.clip.confirm(f.proposal);assert.deepEqual(f.sent,['second\n']);
});
test('single-line sends once; copy never sends and read failures do not send or restore proposals', async () => {
  const f=fixture();await f.clip.copy();assert.deepEqual(f.copied,['中文 selected']);assert.equal(f.sent.length,0);
  await f.clip.paste('单行');assert.deepEqual(f.sent,['单行']);
  f.setReader(async()=>{throw new Error('synthetic denied');});await f.clip.paste();assert.deepEqual(f.sent,['单行']);assert.equal(f.proposal,undefined);
  f.setScope(undefined);await f.clip.paste('ignored');assert.deepEqual(f.sent,['单行']);
});
