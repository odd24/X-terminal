import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-agent-ui-中文-'));
let ui;
try {
  ui = await launchDesktop(directory, { fixture: true });
  const call = request => ui.invoke('agent_management_request', { request });
  const connection = await ui.invoke('fixture_create');
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  const scopes = ['READ', 'WRITE'].map(action => ({ target: { kind: 'connection', connection: ref }, action }));
  const request_id = randomUUID();
  const grant = { op: 'grant', request_id, scopes, lifetime_ms: 60000 };
  const first = await call(grant);
  assert.equal(first.type, 'grant');
  assert.equal(first.data.summary.state, 'ACTIVE');
  assert.equal(first.data.summary.request_id, request_id);
  assert.deepEqual(first.data.approved_scopes, scopes);
  assert.deepEqual(first.data.effective_scopes.map(s => s.action).sort(), ['READ', 'WRITE']);
  assert.ok(first.data.effective_scopes.every(s => JSON.stringify(s.target) === JSON.stringify(scopes[0].target)));
  assert.equal('token' in first, false);
  assert.equal('token' in first.data, false);
  assert.deepEqual(await call(grant), first, 'same native request recovers the original receipt');
  const list = await call({ op: 'grant_list' });
  assert.equal(list.type, 'grant_list'); assert.equal(list.data.length, 1);
  assert.equal(list.data[0].ticket_id, first.data.summary.ticket_id);
  assert.equal(JSON.stringify(list).includes('token'), false);
  for (const request of [
    { ...grant, lifetime_ms: 1 },
    { ...grant, request_id: randomUUID(), role: 'desktop' },
    { op: 'acquire', connection: ref, lifetime_ms: 1000 },
    { op: 'release', connection: ref, lease_id: randomUUID() },
    { op: 'grant_status', request_id, token: 'synthetic-rejected-secret' },
    { op: 'audit', cursor: 0, limit: 1, path: 'rejected' },
  ]) await assert.rejects(call(request));
  assert.deepEqual(await call({ op: 'lease', connection: ref }), { type: 'lease', data: null });
  await call({ op: 'takeover', connection: ref });
  const after = await call({ op: 'grant_status', request_id });
  assert.equal(after.data.summary.state, 'ACTIVE', 'ticket validity differs from executable scopes');
  assert.deepEqual(after.data.approved_scopes, scopes);
  assert.deepEqual(after.data.effective_scopes, scopes.slice(0, 1));
  assert.equal(after.data.summary.expires_at_ms, first.data.summary.expires_at_ms);
  const audit = await call({ op: 'audit', cursor: 0, limit: 128 });
  assert.equal(audit.type, 'audit'); assert.equal(audit.data.gap, false);
  assert.ok(audit.data.events.some(event => event.kind === 'TAKEOVER'));
  assert.equal(JSON.stringify(audit).includes('token'), false);
  const lost = await ui.interceptIpc({ command: 'agent_management_request', op: 'grant', mode: 'error' });
  const unknown_id = randomUUID();
  try {
    await assert.rejects(call({ ...grant, request_id: unknown_id }));
    assert.equal(await lost.count(), 1);
  } finally { await lost.restore(); }
  const restored = await call({ op: 'grant_status', request_id: unknown_id });
  assert.equal(restored.data.summary.state, 'ACTIVE');
  assert.equal((await call({ op: 'grant_list' })).data.length, 2);
  await ui.command('Page.reload');
  assert.deepEqual(await call({ op: 'grant_status', request_id: unknown_id }), restored);
  const revoked = await call({ op: 'grant_revoke', request_id: unknown_id });
  assert.equal(revoked.data.summary.state, 'REVOKED');
  assert.deepEqual(revoked.data.effective_scopes, []);
  assert.deepEqual(await call({ op: 'grant_revoke', request_id: unknown_id }), revoked);
  const expiring = randomUUID();
  await call({ ...grant, request_id: expiring, lifetime_ms: 50 });
  await delay(100);
  assert.equal((await call({ op: 'grant_status', request_id: expiring })).data.summary.state, 'EXPIRED');
  await ui.close(); ui = await launchDesktop(directory, { fixture: true });
  assert.deepEqual((await call({ op: 'grant_list' })).data, []);
  await assert.rejects(call({ op: 'grant_status', request_id }));
  console.log('PASS native Agent management: strict desktop-only actions, no WebView token, original receipt/reload/lost response, effective scopes, revoke/expiry/restart; synthetic connections only');
} finally {
  await ui?.close();
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('shared-terminal-agent-ui-中文-'));
  await rm(target, { recursive: true, force: true });
}
