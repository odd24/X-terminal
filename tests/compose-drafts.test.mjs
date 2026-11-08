import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposeDrafts } from '../apps/desktop/src/compose-drafts.ts';
const target = { connection_id: 'synthetic-A', generation: 1, protocol: 'SSH2' };
test('drafts separate same-profile instances, generations and protocols and cap retained memory', () => {
  const drafts = new ComposeDrafts();
  const scopes = [target, {...target,connection_id:'B'}, {...target,generation:2}, {...target,protocol:'SERIAL'}];
  scopes.forEach((scope,index)=>drafts.edit(scope,String(index)));
  scopes.forEach((scope,index)=>assert.equal(drafts.get(scope),String(index)));
  for(let index=4;index<64;index++)drafts.edit({...target,generation:index},'retained');
  assert.equal(drafts.count,64);
  assert.throws(()=>drafts.edit({...target,generation:100},'new'),/64/);
  drafts.edit(target,'');assert.equal(drafts.count,63);
  drafts.edit({...target,generation:100},'new');assert.equal(drafts.count,64);
  drafts.clear();assert.equal(drafts.count,0);
});
test('explicit endings preserve every authored control byte and do not interpolate shell text', () => {
  const drafts = new ComposeDrafts(); const text='中文\n\r\0\x1b[31m$HOME; `literal`';
  drafts.edit(target,text);
  for(const [ending,suffix] of Object.entries({none:'',cr:'\r',lf:'\n',crlf:'\r\n'})) {
    const proposal=drafts.prepare(target,ending);
    assert.equal(drafts.consume(target,proposal),text+suffix);
    assert.throws(()=>drafts.consume(target,proposal),/已变化/);
  }
});
test('pending proposals are frozen, single-use and cannot follow a switch away/back or draft edit', () => {
  const drafts = new ComposeDrafts(); drafts.edit(target,'original');
  const proposal=drafts.prepare(target,'none');
  assert.throws(()=>{proposal.payload='changed';},TypeError);
  assert.throws(()=>{proposal.target.generation=2;},TypeError);
  assert.throws(()=>drafts.consume({...target,generation:2},proposal),/已变化/);
  assert.throws(()=>drafts.consume(target,proposal),/已变化/);
  const next=drafts.prepare(target,'none');drafts.invalidate();
  assert.throws(()=>drafts.consume(target,next),/已变化/);
  const edited=drafts.prepare(target,'none');drafts.edit(target,'changed');
  assert.throws(()=>drafts.consume(target,edited),/已变化/);
  assert.equal(drafts.get(target),'changed');
});
test('draft and encoded-byte budgets include suffixes and reject incomplete Unicode and unsupported protocols', () => {
  const drafts = new ComposeDrafts();
  assert.throws(()=>drafts.edit(target,'a'.repeat(65537)),/65536/);
  drafts.edit(target,'\ud800');assert.throws(()=>drafts.prepare(target,'none'),/Unicode/);
  drafts.edit(target,'中'.repeat(65536));
  for(const invalid of ['constructor','__proto__','unknown'])assert.throws(()=>drafts.prepare(target,invalid),/选项无效/);
  assert.equal(new TextEncoder().encode(drafts.consume(target,drafts.prepare(target,'none'))).length,196608);
  assert.throws(()=>drafts.prepare(target,'cr'),/上限/);
  const serial={...target,protocol:'SERIAL'};drafts.edit(serial,'a'.repeat(65536));
  assert.equal(drafts.consume(serial,drafts.prepare(serial,'none')).length,65536);
  assert.throws(()=>drafts.prepare(serial,'lf'),/上限/);
  assert.throws(()=>drafts.prepare({...target,protocol:'SSH1'},'none'),/协议/);
});

test('selection freezes exact slice and original source, one-shot payload and only retires the selected range',()=>{const d=new ComposeDrafts();const source='keep-before\n中😀 $HOME; `literal`\nkeep-after';d.edit(target,source);const start=source.indexOf('中'),end=source.indexOf('\nkeep-after');const p=d.prepare(target,'crlf',{start,end});assert.equal(p.text,'中😀 $HOME; `literal`');assert.equal(d.consume(target,p),p.text+'\r\n');assert.equal(d.get(target),source,'preview and consume never edit the source');assert.equal(d.finish(p),true);assert.equal(d.get(target),'keep-before\n\nkeep-after');assert.equal(d.finish(p),false);assert.throws(()=>d.consume(target,p));});
test('invalid or split Unicode selection is refused, selected byte budget is independent of unselected bytes',()=>{const d=new ComposeDrafts();d.edit(target,'A😀B');for(const r of [{start:1,end:2},{start:2,end:3},{start:-1,end:1},{start:2,end:2},{start:0,end:6},{start:.5,end:2},{start:0,end:NaN}])assert.throws(()=>d.prepare(target,'none',r));const t={...target,protocol:'SERIAL'};d.edit(t,'中'.repeat(65536));assert.equal(d.consume(t,d.prepare(t,'lf',{start:0,end:2})),'中中\n');});
test('changed draft/revision or target invalidates selection; failed enqueue preserves it and late finish cannot clobber edits',()=>{const d=new ComposeDrafts();d.edit(target,'before selected after');const p=d.prepare(target,'none',{start:7,end:15});d.edit(target,'before selected after');assert.throws(()=>d.consume(target,p));const next=d.prepare(target,'none',{start:7,end:15});d.consume(target,next);assert.equal(d.get(target),'before selected after','queue refusal must not invoke finish');d.edit(target,'new draft');assert.equal(d.finish(next),false);assert.equal(d.get(target),'new draft');const wrong=d.prepare(target,'none',{start:0,end:3});assert.throws(()=>d.consume({...target,generation:2},wrong));d.invalidate();assert.equal(d.get(target),'new draft');});
