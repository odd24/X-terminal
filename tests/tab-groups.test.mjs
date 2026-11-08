import test from 'node:test';
import assert from 'node:assert/strict';
import { TabGroups } from '../apps/desktop/src/tab-groups.ts';
const a={connection_id:'A',generation:1,protocol:'SSH2'},b={...a,connection_id:'B'},c={...a,connection_id:'C',protocol:'SERIAL'};
test('groups order presentation only and retain independent same-profile instances',()=>{
  const groups=new TabGroups();groups.retain('service',[a,b,c]);const first=groups.create('服务器'),second=groups.create('设备');
  groups.assign('service',b,first);groups.assign('service',c,second);
  assert.deepEqual(groups.order([c,b,a]).map(t=>t.connection_id),['A','B','C']);
  groups.move(second,-1);assert.deepEqual(groups.order([c,b,a]).map(t=>t.connection_id),['A','C','B']);
  groups.remove(first);assert.equal(groups.groupOf('B'),'');assert.deepEqual(groups.order([b,a,c]).map(t=>t.connection_id),['B','A','C']);
  assert.deepEqual(a,{connection_id:'A',generation:1,protocol:'SSH2'});
});
test('reconnect keeps the logical tab but stale drag, owner and removed references cannot move it',()=>{
  const groups=new TabGroups();groups.retain('one',[a,b]);const id=groups.create('工作');groups.assign('one',a,id);
  const next={...a,generation:2};groups.retain('one',[next,b]);assert.equal(groups.groupOf('A'),id);
  assert.throws(()=>groups.assign('one',a,''),/会话已变化/);assert.equal(groups.groupOf('A'),id);
  assert.throws(()=>groups.assign('wrong',next,''),/会话已变化/);
  groups.retain('one',[b]);assert.equal(groups.groupOf('A'),'');assert.throws(()=>groups.assign('one',next,id),/会话已变化/);
  groups.retain('two',[next,b]);assert.deepEqual(groups.list(),[]);assert.equal(groups.groupOf('B'),'');
  assert.throws(()=>groups.assign('two',next,id),/分组已不存在/);
});
test('bounded groups validate display text and return defensive snapshots',()=>{
  const groups=new TabGroups();groups.retain('service',[a]);
  for(const name of ['', ' '.repeat(5), 'x'.repeat(65), '\x1b[31m', 'abc\u202edef','\u061c','\u200e','\u200f'])assert.throws(()=>groups.create(name),/分组名/);
  const id=groups.create('<script>纯文本</script>');groups.list()[0].name='changed';assert.equal(groups.list()[0].name,'<script>纯文本</script>');
  assert.throws(()=>groups.rename(id,'\n'),/分组名/);groups.rename(id,' 新名称 ');assert.equal(groups.list()[0].name,'新名称');
  for(let n=1;n<16;n++)groups.create(String(n));assert.throws(()=>groups.create('overflow'),/16/);groups.remove(id);groups.create('free slot');assert.equal(groups.list().length,16);
});
