import assert from 'node:assert/strict';
import test from 'node:test';
import {PaneLayout} from '../apps/desktop/src/pane-layout.ts';
const a={connection_id:'same-profile-1',generation:1,protocol:'SSH2',state:'CONNECTED'},b={...a,connection_id:'same-profile-2'},serial={...a,connection_id:'uart',protocol:'SERIAL'};
const ready=()=>{const m=new PaneLayout();m.retain('service',[a,b,serial]);m.select(a.connection_id);m.retain('service',[a,b,serial]);return m;};
test('two panes require exact distinct connected identities, keep initial focus and bound snapshots',()=>{const m=ready();assert.throws(()=>m.split('other',a,b,'horizontal'));assert.throws(()=>m.split('service',a,a,'horizontal'));assert.throws(()=>m.split('service',{...a,generation:2},b,'vertical'));m.split('service',a,b,'horizontal');assert.equal(m.slots.length,2);assert.equal(m.active,'first');const copy=m.slots;copy[0].binding.generation=9;assert.equal(m.current.binding.generation,1);m.select(b.connection_id);assert.equal(m.active,'second');assert.equal(m.slots.length,2);});
test('focus round trips, layout changes and explicit selections each invalidate queued route epochs',()=>{const m=ready();m.split('service',a,serial,'vertical');const before=m.epoch;m.focus('second');m.focus('first');assert.ok(m.epoch>=before+2);const e=m.epoch;m.select(a.connection_id);assert.ok(m.epoch>e);assert.equal(m.current.pending,true);m.retain('service',[a,b,serial],false);assert.equal(m.current.pending,true);m.retain('service',[a,b,serial]);assert.equal(m.current.pending,false);});
test('generation removal and service change never inherit pane bindings',()=>{const m=ready();m.split('service',a,b,'vertical');m.retain('service',[{...a,generation:2},b]);assert.equal(m.current.retired,true);assert.equal(m.current.binding.generation,1);m.retain('service',[a,b]);assert.equal(m.current.retired,true);m.select(a.connection_id);m.retain('service',[{...a,generation:2},b]);assert.equal(m.current.binding.generation,2);m.retain('new-service',[a,b]);assert.equal(m.direction,'single');assert.equal(m.current.binding,undefined);assert.equal(m.current.requested,'');});
test('collapse keeps focused identity; exact close removes only its pane without inventing connection',()=>{const m=ready();m.split('service',a,b,'horizontal');assert.equal(m.remove({...a,generation:2}),false);m.focus('second');m.collapse();assert.equal(m.current.binding.connection_id,b.connection_id);assert.equal(m.current.key,'second');m.split('service',b,serial,'vertical');assert.equal(m.remove(serial),true);assert.equal(m.direction,'single');assert.equal(m.current.binding.connection_id,b.connection_id);assert.equal(m.remove(b),true);assert.equal(m.current.binding,undefined);assert.equal(m.current.requested,'');});

test('authoritative same-target selection keeps authentication stable; expected new generation cannot bind old list',()=>{const m=ready();m.select(a.connection_id,a,1);assert.equal(m.current.pending,false);assert.deepEqual(m.current.binding,{connection_id:a.connection_id,generation:1,protocol:'SSH2'});m.select(a.connection_id,a,2);assert.equal(m.current.pending,true);m.retain('service',[a,b]);assert.equal(m.current.pending,true);m.retain('service',[{...a,generation:2},b]);assert.equal(m.current.pending,false);assert.equal(m.current.binding.generation,2);});

test('restoring a validated plan uses ordered exact identities and the saved active member without accepting foreign owner or fallback',()=>{const m=ready();assert.throws(()=>m.restore('wrong',a,b,'horizontal',b));assert.throws(()=>m.restore('service',a,a,'horizontal',a));assert.throws(()=>m.restore('service',a,b,'vertical',serial));assert.throws(()=>m.restore('service',a,{...b,state:'DISCONNECTED'},'horizontal',a));const before=m.epoch;m.restore('service',a,b,'vertical',b);assert.deepEqual(m.slots.map(s=>s.binding.connection_id),[a.connection_id,b.connection_id]);assert.equal(m.active,'second');assert.equal(m.direction,'vertical');assert.ok(m.epoch>before);});

test('nested positioning keeps existing pane keys, moves a tab once and removes an empty group',()=>{
 const m=ready(),extra={...a,connection_id:'extra'},live=[a,b,serial,extra];
 m.split('service',a,b,'horizontal',false,live);
 m.split('service',a,serial,'vertical',false,live);
 assert.deepEqual(m.slots.map(slot=>slot.binding.connection_id),[a.connection_id,serial.connection_id,b.connection_id]);
 assert.equal(m.tree.first.direction,'vertical');
 assert.equal(m.paneOf(extra.connection_id),'first');
 assert.equal(m.move(extra,'second',live),true);
 assert.equal(m.paneOf(extra.connection_id),'second');
 m.select(extra.connection_id,extra);
 assert.equal(m.current.key,'second');
 assert.equal(m.remove(extra,live),true);
 assert.equal(m.current.binding.connection_id,b.connection_id);
 m.move(serial,'second',[a,b,serial]);m.select(serial.connection_id,serial);
 assert.deepEqual(m.slots.map(slot=>slot.key),['first','second']);
 assert.equal(m.current.binding.connection_id,serial.connection_id);
});

test('an isolated tab dragged to the other pane edge retains its renderer key',()=>{
 const m=ready();m.split('service',a,b,'horizontal',false,[a,b]);
 m.split('service',a,b,'vertical',true,[a,b]);
 assert.deepEqual(m.slots.map(slot=>slot.key),['second','first']);
 assert.equal(m.active,'first');
});
