import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { delay } from './DesktopHarness.mjs';

async function until(read, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

export async function checkMcpConnect({ directory, ui, call, success, management, grantId, rebind, getRpc }) {
  const targetRoot = path.join(directory, 'connect-target');
  await mkdir(targetRoot);
  const fixture = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [targetRoot], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve, reject) => {
    fixture.once('exit', resolve);
    fixture.once('error', reject);
  });
  exited.catch(() => {});
  const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    let timer;
    try {
      return await Promise.race([
        lines.next().then(line => JSON.parse(line.value)),
        exited.then(() => { throw new Error('Connect SSH fixture exited'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connect SSH fixture timeout')), 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const server = await next();
    const metrics = () => {
      fixture.stdin.write('{"op":"metrics"}\n');
      return next();
    };
    const result = await exerciseConnect({ ui, call, success, management, grantId, rebind, getRpc, server, metrics });
    return result;
  } finally {
    fixture.kill();
    await exited;
  }
}

async function exerciseConnect({ ui, call, success, management, grantId, rebind, getRpc, server, metrics }) {
  const start = 'ssh_connect';
  const status = 'ssh_connect_status';
  const profile_id = randomUUID();
  const request_id = randomUUID();
  const profile = {
    id: profile_id, folder_id: null, name: 'MCP固定版本SSH',
    settings: { protocol: 'ssh2', host: '127.0.0.1', port: server.port, username: 'synthetic', auth: 'password', encoding: 'utf8' },
  };
  const ssh = request => ui.invoke('ssh_request', { request });
  const config = request => ui.invoke('config_request', { request });
  const page = () => config({ op: 'page', revision: null, offset: 0, folders: false });
  const sessions = () => ui.invoke('service_list');
  const dims = { cols: 92, rows: 28 };
  const save = (name, credential) => config({ op: 'save_profile', profile: { ...profile, name }, credential });
  const grant = async (target, operation) => {
    const id = randomUUID();
    const result = await management({
      op: operation ? 'grant_operation' : 'grant', request_id: id, lifetime_ms: 120000,
      scopes: [{ target, action: 'CONNECT' }],
      ...(operation ? { operation: { protocol: 'SSH2', request: operation } } : {}),
    });
    return { id, ticket: result.data.summary.ticket_id };
  };
  const bind = async ({ id, ticket }) => {
    await rebind(id);
    assert.equal((await success('agent_status')).data.paired_ticket, ticket);
  };
  const deny = async (name, input, code) => {
    const reply = await call(name, input);
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.error_code, code, JSON.stringify({ name, reply }));
  };
  const initial = await save(profile.name, {
    action: 'replace', value: { password: server.password, private_key: null, passphrase: null },
  });
  const before = await sessions();
  const first = { profile_id, revision: initial.revision, request_id };
  await deny(start, { ...first, ...dims }, 'PERMISSION_DENIED');
  await bind(await grant({ kind: 'profile', profile_id }));
  await deny(start, { ...first, ...dims }, 'PERMISSION_DENIED');
  const fixed = revision => ({ kind: 'profile_revision', profile_id, revision });
  await bind(await grant(fixed(first.revision)));
  const { revision } = await save('MCP固定版本SSH更新版', { action: 'keep' });
  assert.notEqual(revision, first.revision);
  await deny(start, { ...first, ...dims }, 'INVALID_ARGUMENT');
  await deny(status, first, 'PERMISSION_DENIED');

  const target = { profile_id, revision, request_id };
  const args = { ...target, ...dims };
  // Existing GUI-issued Single form uses Start plus the exact ProfileRevision scope.
  const original = await grant(fixed(revision), { op: 'start', profile_id, request_id, ...dims });
  await bind(original);
  await deny(start, { ...args, revision: first.revision }, 'PERMISSION_DENIED');
  await deny(start, { ...args, profile_id: randomUUID() }, 'PERMISSION_DENIED');
  await deny(start, { ...args, cols: dims.cols + 1 }, 'PERMISSION_DENIED');
  await deny(start, { ...args, host: '127.0.0.1' }, 'INVALID_ARGUMENT');
  await deny(start, { ...args, use_saved: true }, 'INVALID_ARGUMENT');
  await deny(status, target, 'PERMISSION_DENIED');
  assert.deepEqual(await sessions(), before);
  assert.equal((await metrics()).accepted_connections, 0, 'denied calls and unknown status must open no socket');
  const savedBeforeStart = await page();

  const rpc = getRpc();
  const pending = rpc.begin('tools/call', { name: start, arguments: args }, 500);
  rpc.discardResponse(pending.id);
  const discardedBefore = rpc.discardedResponses;
  await assert.rejects(pending.promise, /RPC timeout/);
  assert.equal(rpc.discardedResponses, discardedBefore + 1);
  const receipt = await success(status, target);
  assert.equal(receipt.result, 'connect');
  const { connection_id, generation, protocol, state } = receipt.data.connection;
  const connection = { connection_id, generation };
  assert.equal(generation, 1);
  assert.equal(protocol, 'SSH2');
  assert.equal(state, 'CONNECTING');
  assert.deepEqual(receipt.data, { ...target, connection: { ...connection, protocol, state } });
  assert.ok(before.every(item => item.connection_id !== connection_id));
  assert.equal((await sessions()).length, before.length + 1);
  assert.deepEqual(await page(), savedBeforeStart);
  await deny(status, { ...target, revision: first.revision }, 'INVALID_ARGUMENT');
  await deny(status, { ...target, profile_id: randomUUID() }, 'INVALID_ARGUMENT');
  await deny('ssh_reconnect_status', { connection, request_id }, 'PERMISSION_DENIED');
  await deny('terminal_read', { connection, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await deny('terminal_send', { transport: 'SSH2', connection, request_id: randomUUID(), text: 'MUST_NOT_SEND' }, 'PERMISSION_DENIED');
  await deny('ssh_exec', { connection, request_id: '019a6000-0001-7000-8000-000000000001', command: 'MUST_NOT_EXEC', timeout_ms: 1000, max_output_bytes: 1024 }, 'PERMISSION_DENIED');
  await deny('input_acquire', { connection, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await rebind(grantId);
  await deny(status, target, 'PERMISSION_DENIED');
  await bind(original);
  assert.deepEqual(await success(status, target), receipt);

  const challenge = kind => until(async () => {
    const current = await ssh({ op: 'status', connection });
    assert.notEqual(current.connection.state, 'FAILED');
    return current.challenge?.kind === kind && current.challenge;
  }, `Desktop did not observe ${kind}`);
  const trust = await challenge('host_key');
  assert.equal(trust.review.candidate.fingerprint, server.pin);
  const beforeTrust = await metrics();
  assert.equal(beforeTrust.accepted_connections, 1);
  assert.equal(beforeTrust.attempts, 0);
  await ssh({ op: 'answer_host', connection, challenge_id: trust.id, approve: true });
  const login = await challenge('credentials');
  assert.equal((await metrics()).attempts, 0, 'host trust alone must not submit saved credentials');
  await ssh({ op: 'authenticate', connection, challenge_id: login.id, use_saved: true, password: null });
  await until(async () => (await ssh({ op: 'status', connection })).connection.state === 'CONNECTED', 'Desktop authentication did not finish');
  const after = await metrics();
  assert.equal(after.accepted_connections, 1);
  assert.equal(after.attempts, 1);
  assert.deepEqual(after.received, []);
  assert.deepEqual(after.exec_calls, []);
  const edited = await save('MCP固定版本SSH回执保留', { action: 'keep' });
  assert.notEqual(edited.revision, revision);
  assert.deepEqual(await success(status, target), receipt, 'status returns the creation snapshot after profile change');
  await management({ op: 'grant_revoke', request_id: original.id });
  await deny(status, target, 'PERMISSION_DENIED');
  const audit = await management({ op: 'audit', cursor: 0, limit: 128 });
  const dispatches = audit.data.events.filter(event => event.kind === 'DISPATCHED' && event.request_id === request_id);
  assert.deepEqual(dispatches.map(event => [event.client_id, event.scope]), [[original.ticket, { target: fixed(revision), action: 'CONNECT' }]]);
  return { result: 'PASS', creation: receipt.data, accepted_connections: 1, dispatches: 1,
    first_reply_discarded: true, host_identity_verified_by_desktop: true, authentication_by_desktop: true,
    status_survives_revision_change: true, legacy_scope_rejected: true };
}
