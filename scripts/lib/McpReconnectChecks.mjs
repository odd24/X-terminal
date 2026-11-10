import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { delay } from './DesktopHarness.mjs';

async function until(read, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

export async function checkMcpReconnect({ ui, call, success, ref, management, control, rebind, getRpc, profileId, sshPin, originalInput, grantId }) {
  const start = 'ssh_reconnect';
  const status = 'ssh_reconnect_status';
  const target = { connection: ref, request_id: randomUUID() };
  const args = { ...target, cols: 91, rows: 27 };
  const ssh = request => ui.invoke('ssh_request', { request });
  const config = request => ui.invoke('config_request', { request });
  const page = () => config({ op: 'page', revision: null, offset: 0, folders: false });
  const metrics = () => control({ op: 'metrics' });
  const oldScope = { target: { kind: 'connection', connection: ref }, action: 'RECONNECT' };
  const connect = revision => ({ target: { kind: 'profile_revision', profile_id: profileId, revision }, action: 'CONNECT' });
  const acquire = () => success('input_acquire', { connection: ref, lifetime_ms: 30000 });
  const release = lease => success('input_release', { connection: ref, lease_id: lease.data.lease_id });
  const deny = async (name, input, code) => {
    const reply = await call(name, input);
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.error_code, code, JSON.stringify({ name, input, reply }));
  };
  const bind = async grant => {
    await rebind(grant.id);
    assert.equal((await success('agent_status')).data.paired_ticket, grant.ticket);
  };
  const grant = async (scopes, operation) => {
    const id = randomUUID();
    const result = await management({
      op: operation ? 'grant_operation' : 'grant', request_id: id, scopes, lifetime_ms: 120000,
      ...(operation ? { operation: { protocol: 'SSH2', request: operation } } : {}),
    });
    return { id, ticket: result.data.summary.ticket_id };
  };
  const end = { connection: ref, request_id: randomUUID() };
  await ssh({ op: 'disconnect', ...end });
  await until(async () => (await ssh({ op: 'disconnect_status', ...end })).state === 'TRANSPORT_ENDED', 'old SSH transport still active');
  await control({ op: 'wait_disconnected' });
  const before = await metrics();
  assert.equal(before.accepted_connections, 1);
  const saved = await page();
  const profile = saved.profiles.find(row => row.id === profileId);
  assert.ok(profile);

  const connectOnly = await grant([connect(saved.revision)]);
  await bind(connectOnly);
  await deny(start, args, 'PERMISSION_DENIED');
  await bind(await grant([oldScope]));
  const reconnectOnlyLease = await acquire();
  await deny(start, args, 'PERMISSION_DENIED');
  await release(reconnectOnlyLease);

  const staleGrant = await grant([oldScope, connect(saved.revision)]);
  await bind(staleGrant);
  const staleLease = await acquire();
  const { revision } = await config({
    op: 'save_profile',
    profile: { id: profile.id, folder_id: profile.folder_id, name: 'MCP合成SSH更新版本', settings: profile.settings },
    credential: { action: 'keep' },
  });
  assert.notEqual(revision, saved.revision);
  await deny(start, args, 'INVALID_ARGUMENT');
  await deny(status, target, 'PERMISSION_DENIED');
  await release(staleLease);

  const scopes = [oldScope, connect(revision)];
  const taken = await grant(scopes);
  await bind(taken);
  await acquire();
  await management({ op: 'takeover', connection: ref });
  await deny(start, args, 'PERMISSION_DENIED');
  await deny(status, target, 'PERMISSION_DENIED');
  const original = await grant(scopes, { op: 'reconnect', ...args });
  await bind(original);
  await deny(start, args, 'INPUT_BUSY');
  await acquire();
  await deny(start, { ...args, cols: 90 }, 'PERMISSION_DENIED');
  await deny(start, { ...args, connection: { ...ref, generation: ref.generation + 1 } }, 'PERMISSION_DENIED');
  await deny(start, { ...args, rows: 0 }, 'INVALID_ARGUMENT');
  await deny(start, { ...args, password: 'SYNTHETIC_MUST_NOT_PASS' }, 'INVALID_ARGUMENT');
  await deny(status, target, 'PERMISSION_DENIED');
  assert.equal((await ssh({ op: 'status', connection: ref })).connection.state, 'DISCONNECTED');
  assert.deepEqual(await metrics(), before, 'rejected operations and queries opened no socket');

  const rpc = getRpc();
  const lost = rpc.begin('tools/call', { name: start, arguments: args }, 500);
  rpc.discardResponse(lost.id);
  const discardedBefore = rpc.discardedResponses;
  await assert.rejects(lost.promise, /RPC timeout/);
  assert.equal(rpc.discardedResponses, discardedBefore + 1);

  const current = { ...ref, generation: ref.generation + 1 };
  const snapshot = {
    result: 'reconnect',
    data: { request_id: target.request_id, previous: ref, connection: { ...current, protocol: 'SSH2', state: 'CONNECTING' } },
  };
  const query = async () => assert.deepEqual(await success(status, target), snapshot);
  await query();
  const waiting = await until(async () => {
    const state = await ssh({ op: 'status', connection: current });
    return state.challenge && state;
  }, 'new SSH generation did not wait for Desktop authentication');
  const beforeAuth = await metrics();
  assert.equal(beforeAuth.accepted_connections, before.accepted_connections + 1);
  assert.equal(beforeAuth.attempts, before.attempts);
  assert.equal(waiting.connection.state, 'AUTHENTICATING');
  await deny(status, { ...target, connection: current }, 'INVALID_ARGUMENT');
  await deny(status, { ...target, cols: args.cols }, 'INVALID_ARGUMENT');
  assert.equal((await success('input_lease', { connection: ref })).data, null);
  await deny('input_acquire', { connection: current, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await deny('terminal_read', { connection: current, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await deny('terminal_send', { transport: 'SSH2', connection: current, request_id: randomUUID(), text: 'MUST_NOT_SEND' }, 'PERMISSION_DENIED');
  // SSH input status looks up the exact generation's receipt ledger.
  await deny('terminal_input_status', { transport: 'SSH2', connection: current, request_id: originalInput.request_id }, 'NOT_FOUND');
  await rebind(grantId);
  await deny(status, target, 'PERMISSION_DENIED');
  await deny('terminal_read', { connection: current, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await deny('terminal_send', { transport: 'SSH2', connection: current, request_id: randomUUID(), text: 'OLD_SCOPE_MUST_NOT_SEND' }, 'PERMISSION_DENIED');
  await deny('input_acquire', { connection: current, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await bind(original);
  await query();

  const answered = new Set();
  await until(async () => {
    const state = await ssh({ op: 'status', connection: current });
    assert.notEqual(state.connection.state, 'FAILED');
    const challenge = state.challenge;
    if (challenge && !answered.has(challenge.id)) {
      answered.add(challenge.id);
      if (challenge.kind === 'host_key') {
        assert.equal(challenge.review.candidate.fingerprint, sshPin);
        await ssh({ op: 'answer_host', connection: current, challenge_id: challenge.id, approve: true });
      } else {
        assert.equal(challenge.kind, 'credentials');
        await ssh({ op: 'authenticate', connection: current, challenge_id: challenge.id, use_saved: true, password: null });
      }
    }
    return state.connection.state === 'CONNECTED';
  }, 'Desktop did not complete SSH authentication');
  await query();
  const after = await metrics();
  assert.equal(after.accepted_connections, before.accepted_connections + 1);
  assert.equal(after.attempts, before.attempts + 1);
  assert.deepEqual(after.received, before.received, 'no old terminal input was replayed');
  const output = await ui.invoke('service_read_text', { connection: current, cursor: 1 });
  assert.ok(!output.events.some(event => event.text.includes(originalInput.text.trim())));
  await management({ op: 'grant_revoke', request_id: original.id });
  await deny(status, target, 'PERMISSION_DENIED');
  const audit = await management({ op: 'audit', cursor: 0, limit: 128 });
  const dispatches = audit.data.events.filter(event => event.kind === 'DISPATCHED' && event.request_id === target.request_id);
  assert.ok(dispatches.every(event => event.client_id === original.ticket));
  assert.deepEqual(dispatches.map(event => event.scope.action).sort(), ['CONNECT', 'RECONNECT']);
  return { result: 'PASS', transport: 'SSH2', creation: snapshot.data, accepted_connections_added: 1,
    auth_by_desktop: true, old_input_replayed: false, first_reply_discarded: true,
    dispatches: ['CONNECT', 'RECONNECT'], invalid_revision_and_takeover_denied: true };
}
