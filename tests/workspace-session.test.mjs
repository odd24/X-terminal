import test from 'node:test';
import assert from 'node:assert/strict';
import { captureWorkspace, WorkspaceSession, copyWorkspace } from '../apps/desktop/src/workspace-session.ts';
const profile={id:'profile-A',settings:{protocol:'ssh2'},name:'server'};
const a={connection_id:'old-A',generation:1,protocol:'SSH2',profile_id:profile.id},b={...a,connection_id:'old-B'},temp={...a,connection_id:'temporary',profile_id:'not-saved'};
const snapshot=()=>captureWorkspace(' 布局 ',[a,b,temp],[profile],[{id:'group',name:'工作'}],id=>id===a.connection_id?'group':'',b.connection_id,true);
test('only saved configuration references and view metadata enter a snapshot, duplicate profiles remain independent slots',()=>{
 const {workspace,skipped}=snapshot();assert.equal(skipped,1);assert.equal(workspace.tabs.length,2);assert.equal(workspace.tabs[0].profile_id,workspace.tabs[1].profile_id);assert.notEqual(workspace.tabs[0].id,workspace.tabs[1].id);assert.equal(workspace.selected_tab,workspace.tabs[1].id);assert.equal(workspace.name,'布局');
 const text=JSON.stringify(workspace);for(const value of ['old-A','old-B','temporary','generation','connection_id','request_id','credential','password','token'])assert.equal(text.includes(value),false);
 const copy=copyWorkspace(workspace);copy.tabs[0].profile_id='other';assert.equal(workspace.tabs[0].profile_id,profile.id);
});
test('open has no implicit binding, explicit success must match owner/slot/profile and independent connections',()=>{
 const {workspace}=snapshot(),session=new WorkspaceSession();session.open(workspace,'service',[a,b]);const [one,two]=workspace.tabs;
 assert.equal(session.binding(one.id),undefined);assert.equal(session.bind('wrong',one.id,profile.id,a),false);assert.equal(session.bind('service',one.id,'wrong-profile',a),false);
 assert.equal(session.bind('service',one.id,profile.id,a),true);assert.equal(session.bind('service',two.id,profile.id,a),false);assert.equal(session.bind('service',two.id,profile.id,b),true);
 assert.deepEqual(session.order([b,a]).map(c=>c.connection_id),[a.connection_id,b.connection_id]);
 assert.equal(JSON.stringify(session.layout).includes('old-A'),false);session.retain('new-service',[a,b]);assert.equal(session.binding(one.id),undefined);assert.ok(session.layout);
});
test('bindings are retired safely and an edited profile reference never inherits a previous live connection',()=>{
 const {workspace}=snapshot(),session=new WorkspaceSession();const slot=workspace.tabs[0];session.open(workspace,'service',[a,b]);session.bind('service',slot.id,profile.id,a);
 session.retain('service',[{...a,generation:2},b]);assert.equal(session.binding(slot.id),undefined);session.retain('service',[b]);assert.equal(session.binding(slot.id),undefined);
 session.bind('service',slot.id,profile.id,a);const changed=copyWorkspace(workspace);changed.tabs[0].profile_id='new-profile';session.open(changed,'service',[a,b]);assert.equal(session.binding(slot.id),undefined);
 session.close();assert.equal(session.layout,undefined);
});

test('split snapshots contain only exact eligible slot references; temporary, hidden, stale and duplicate targets do not invent substitutes',()=>{
 const capture=view=>captureWorkspace('split',[a,b,temp],[profile],[],()=>'',b.connection_id,false,view);
 const {workspace,splitSkipped}=capture({direction:'vertical',connections:[b,a]});assert.equal(splitSkipped,false);assert.deepEqual(workspace.split,{direction:'vertical',tabs:[workspace.tabs[1].id,workspace.tabs[0].id]});assert.equal(workspace.selected_tab,workspace.split.tabs[0]);const copy=copyWorkspace(workspace);copy.split.tabs[0]='mutated';assert.notEqual(workspace.split.tabs[0],'mutated');
 for(const refs of [[a,temp],[{...a,generation:9},b],[a,a],[{...a,connection_id:'hidden'},b]]){const c=capture({direction:'horizontal',connections:refs});assert.equal(c.workspace.split,null);assert.equal(c.splitSkipped,true);assert.equal(c.workspace.tabs.length,2);}
 const text=JSON.stringify(workspace);for(const secret of ['old-A','old-B','temporary','connection_id','generation','service_id','request_id','text','token'])assert.equal(text.includes(secret),false);
});
const splitSnapshot=()=>captureWorkspace('split',[a,b],[profile],[],()=>'',b.connection_id,true,{direction:'horizontal',connections:[a,b]}).workspace;
test('opening never guesses prior same-profile instances; exact explicit bindings yield one restore plan with saved active slot',()=>{
 const w=splitSnapshot(),s=new WorkspaceSession(),live=[a,b].map(c=>({...c,state:'CONNECTED'}));s.open(w,'owner',live);assert.equal(s.splitState,'pending');assert.equal(s.claimSplit('owner',live),undefined);const [one,two]=w.tabs;
 s.bind('owner',one.id,profile.id,a);assert.equal(s.claimSplit('owner',live),undefined);s.bind('owner',two.id,profile.id,b);assert.equal(s.claimSplit('wrong',live),undefined);assert.equal(s.claimSplit('owner',[live[0],{...live[1],state:'DISCONNECTED'}]),undefined);
 const plan=s.claimSplit('owner',live);assert.equal(plan.direction,'horizontal');assert.equal(plan.first.connection_id,a.connection_id);assert.equal(plan.second.connection_id,b.connection_id);assert.equal(plan.active.connection_id,b.connection_id);assert.equal(s.splitState,'applied');assert.equal(s.claimSplit('owner',live),undefined);s.open(w,'owner',live);assert.equal(s.binding(one.id),undefined);assert.equal(s.claimSplit('owner',live),undefined);
});
test('manual cancellation, precise target closure, new generations and service changes cannot trigger a late restore',()=>{
 const w=splitSnapshot(),s=new WorkspaceSession(),live=[a,b].map(c=>({...c,state:'CONNECTED'}));const bind=()=>{s.bind('owner',w.tabs[0].id,profile.id,a);s.bind('owner',w.tabs[1].id,profile.id,b);};s.open(w,'owner',live);s.bind('owner',w.tabs[0].id,profile.id,a);s.cancelSplit();s.bind('owner',w.tabs[1].id,profile.id,b);assert.equal(s.claimSplit('owner',live),undefined);
 s.open(w,'owner',live);bind();s.cancelSplitFor({...a,generation:2});assert.equal(s.splitState,'pending');s.cancelSplitFor(a);assert.equal(s.splitState,'cancelled');assert.equal(s.claimSplit('owner',live),undefined);
 s.open(w,'owner',live);bind();s.retain('owner',[{...a,generation:2},b]);assert.equal(s.binding(w.tabs[0].id),undefined);assert.equal(s.claimSplit('owner',live),undefined);s.retain('new-owner',live);assert.equal(s.splitState,'cancelled');assert.equal(s.binding(w.tabs[1].id),undefined);
});
