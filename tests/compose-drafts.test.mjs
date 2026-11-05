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
