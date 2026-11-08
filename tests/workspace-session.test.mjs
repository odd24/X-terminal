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
 session.retain('service',[{...a,generation:2},b]);assert.equal(session.binding(slot.id).generation,2);session.retain('service',[b]);assert.equal(session.binding(slot.id),undefined);
 session.bind('service',slot.id,profile.id,a);const changed=copyWorkspace(workspace);changed.tabs[0].profile_id='new-profile';session.open(changed,'service',[a,b]);assert.equal(session.binding(slot.id),undefined);
 session.close();assert.equal(session.layout,undefined);
});
