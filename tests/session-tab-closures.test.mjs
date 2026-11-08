import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTabClosures } from '../apps/desktop/src/session-tab-closures.ts';
const first={connection_id:'one',generation:1,protocol:'SSH2',state:'CONNECTED'};
test('same-turn close is issued once and unknown delivery is not replayed',()=>{
 const c=new SessionTabClosures();c.retain('service',[first]);
 assert.equal(c.begin(first,[first]),'dispatch');assert.equal(c.begin(first,[first]),'pending');
 c.finish(first,'unknown');assert.equal(c.begin(first,[first]),'unknown');
 assert.equal(c.begin(first,[{...first,state:'DISCONNECTED'}]),'hide','an ended target can be hidden without another close');
});
test('late close completion and hidden state cannot retire a newer generation',()=>{
 const c=new SessionTabClosures();c.retain('service',[first]);c.begin(first,[first]);
 const next={...first,generation:2};c.retain('service',[next]);c.finish(first,'accepted');
 assert.equal(c.hide(first),false);assert.equal(c.isHidden(next),false);assert.equal(c.begin(first,[next]),'stale');
 assert.equal(c.begin(next,[next]),'dispatch');c.finish(next,'accepted');assert.equal(c.hide(next),true);assert.equal(c.hide(first),false);assert.equal(c.isHidden(next),true);
});
test('service replacement and removed targets discard close state; protocol mismatches reject',()=>{
 const c=new SessionTabClosures();c.retain('a',[first]);c.begin(first,[first]);c.finish(first,'unknown');c.hide(first);
 c.retain('b',[first]);assert.equal(c.isHidden(first),false);assert.equal(c.begin({...first,protocol:'SERIAL'},[first]),'stale');
 assert.equal(c.begin(first,[first]),'dispatch');c.retain('b',[]);assert.equal(c.hide(first),false);assert.equal(c.begin(first,[]),'stale');
});
