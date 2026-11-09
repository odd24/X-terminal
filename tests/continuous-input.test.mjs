import test from 'node:test';import assert from 'node:assert/strict';
import {ContinuousInput} from '../apps/desktop/src/continuous-input.ts';
const tick=()=>new Promise(r=>setImmediate(r)),target=(id,protocol='SSH2')=>({connection_id:id,generation:1,protocol,label:id,encoding:'utf8'}),targets=()=>[target('a'),target('b','SERIAL')];
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(overrides={}){let id=0;const sent=[],queries=[];const run=new ContinuousInput({alive:o=>o==='owner',id:()=>String(++id),ready:async()=>true,send:async(t,id,text)=>{sent.push({t,id,text});return {state:'ACCEPTED',bytes:Buffer.byteLength(text),message:'accepted only'};},query:async(t,id)=>{queries.push({t,id});return {state:'ACCEPTED',bytes:1,message:'original receipt'};},...overrides});return {run,sent,queries};}

test('default off, explicit frozen scope, exact Unicode/control FIFO and snapshots never retain input body',async()=>{
 const {run,sent}=setup(),fixed=targets();assert.equal(run.input('not-armed'),false);assert.equal(run.arm('owner',fixed),true);fixed[0].generation=9;fixed.push(target('excluded'));assert.equal(run.arm('owner',targets()),false);
 assert.equal(sent.length,0);const text='中😀 $HOME';run.input(text);run.input('\r');run.input('\x7f');run.input('\x03');await tick();
 for(const id of ['a','b'])assert.equal(sent.filter(s=>s.t.connection_id===id).map(s=>s.text).join(''),text+'\r\x7f\x03');
 assert.ok(sent.every(s=>s.t.generation===1));assert.equal(new Set(sent.map(s=>s.id)).size,sent.length);assert.equal(run.snapshot().totals.length,2);assert.equal(JSON.stringify(run.snapshot()).includes('$HOME'),false);
 const snap=run.snapshot();snap.totals[0].target.generation=10;snap.results[0].target.generation=10;assert.equal(run.snapshot().totals[0].target.generation,1);assert.equal(run.snapshot().results[0].target.generation,1);run.stop();assert.equal(run.input('not-resumed'),false);
});

test('stop during preflight drops all targets and queued text; stop in flight keeps only actual current receipt',async()=>{
 const pre=gate(),a=setup({ready:async()=>{await pre.promise;return true;}});a.run.arm('owner',targets());a.run.input('A');a.run.input('TAIL');a.run.stop();assert.equal(a.run.arm('owner',targets()),false);pre.resolve();await tick();assert.equal(a.sent.length,0);assert.equal(a.run.snapshot().working,false);
 const flight=gate(),sent=[],b=setup({send:async(t,id,text)=>{sent.push({t,id,text});await flight.promise;return {state:'ACCEPTED',bytes:1,message:'receipt'};}});b.run.arm('owner',targets());b.run.input('A');await tick();b.run.input('TAIL');b.run.stop();flight.resolve();await tick();assert.equal(sent.length,1);assert.deepEqual(b.run.snapshot().results.map(r=>r.state),['ACCEPTED','SKIPPED']);assert.equal(b.run.snapshot().totals[0].accepted,1);assert.equal(b.run.snapshot().totals[1].accepted,0);
});

test('16 items including active, 4KiB merged tail limit, barriers and queue overflow stops without dispatching tail',async()=>{
 const held=gate(),seen=[],{run}=setup({ready:async()=>{await held.promise;return true;},send:async(t,id,text)=>{seen.push(text);return {state:'ACCEPTED',bytes:text.length,message:'receipt'};}});run.arm('owner',targets());run.input('active');
 for(let n=0;n<15;n++)assert.equal(run.input('x'.repeat(4096)),true);assert.equal(run.input('overflow'),false);assert.equal(run.snapshot().enabled,false);assert.match(run.snapshot().reason,/16项/);held.resolve();await tick();assert.deepEqual(seen,[]);
 const after=setup();after.run.arm('owner',targets());after.run.input('active');after.run.input('中');after.run.input('文');after.run.input('\x7f');after.run.input('\x7f');after.run.input('\r');after.run.input('tail');await tick();assert.deepEqual(after.sent.filter(s=>s.t.connection_id==='a').map(s=>s.text),['active','中文','\x7f\x7f','\r','tail']);after.run.stop();
});

test('known rejection or unavailable/authentication/lease preflight fail closes continuous mode unlike single batches',async()=>{
 for(const receipt of [{state:'REJECTED',bytes:null,message:'encoding'},{state:'UNKNOWN',bytes:null,message:'lost'},{state:'ACCEPTED',bytes:null,message:'bad count'}]){const sent=[],{run}=setup({send:async t=>{sent.push(t.connection_id);return receipt;}});run.arm('owner',targets());run.input('x');run.input('\r');await tick();assert.equal(run.snapshot().enabled,false);assert.deepEqual(sent,['a']);assert.equal(run.snapshot().results[1].state,'SKIPPED');}
 for(const ready of [async()=>false,async()=>{throw new Error('lease unavailable');}]){const {run,sent}=setup({ready});run.arm('owner',targets());run.input('x');await tick();assert.equal(sent.length,0);assert.equal(run.snapshot().enabled,false);}
});

test('unknown query is original-ID only, updates known totals once, never resumes, and stale query cannot contaminate a new arm',async()=>{
 let sends=0;const {run,queries}=setup({send:async()=>{sends++;return {state:'UNKNOWN',bytes:null,message:'lost'};}});run.arm('owner',targets());run.input('private');await tick();const id=run.snapshot().results[0].request_id;assert.equal(await run.query(id),true);assert.equal(await run.query(id),true);assert.deepEqual(queries.map(q=>q.id),[id,id]);assert.equal(run.snapshot().enabled,false);assert.equal(run.snapshot().totals[0].accepted,1);assert.equal(run.snapshot().results[1].state,'SKIPPED');assert.equal(sends,1);
 const held=gate(),late=setup({send:async()=>({state:'UNKNOWN',bytes:null,message:'lost'}),query:async()=>{await held.promise;return {state:'ACCEPTED',bytes:9,message:'old'};}});late.run.arm('owner',targets());late.run.input('x');await tick();const pending=late.run.query(late.run.snapshot().results[0].request_id);assert.equal(late.run.arm('owner',targets()),true);held.resolve();await pending;assert.deepEqual(late.run.snapshot().totals.map(r=>r.accepted),[0,0]);late.run.stop();
});

test('owner changes after awaited preflight prevent dispatch; invalid inputs/targets fail closed',async()=>{
 let owner='owner';const held=gate(),{run,sent}=setup({alive:o=>o===owner,ready:async()=>{await held.promise;return true;}});run.arm(owner,targets());run.input('x');owner='new';held.resolve();await tick();assert.deepEqual(sent,[]);assert.equal(run.snapshot().enabled,false);
 for(const t of [[target('a')],[target('a'),target('a')],[target('a'),target('b','SSH1')],Array.from({length:9},(_,i)=>target(String(i)))])assert.throws(()=>setup().run.arm('owner',t));
 for(const input of ['','\ud800','x'.repeat(4097)]){const s=setup();s.run.arm('owner',targets());assert.equal(s.run.input(input),false);assert.equal(s.run.snapshot().enabled,false);assert.deepEqual(s.sent,[]);}
});
