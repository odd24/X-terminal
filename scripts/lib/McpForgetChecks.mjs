import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './DesktopHarness.mjs';
import { requestId } from '../../apps/desktop/src/request-id.ts';

async function until(read, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  throw new Error(message);
}

export async function checkMcpForget({ directory, ui, call, success, ref, other, transport, management, lease, control, rebind, getRpc, profileId, sshPin }) {
  const start = 'sessions_forget';
  const status = 'sessions_forget_status';
  const serial = transport === 'SERIAL';
  const args = { transport, connection: ref, request_id: randomUUID() };
  const marker = name => path.join(directory, `serial-mcp-${name}`);
  const transportRequest = request => ui.invoke(serial ? 'serial_request' : 'ssh_request', { request });
  const logging = request => ui.invoke('logging_request', { request });
  const page = () => ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
  const sessions = () => ui.invoke('service_list');
  const lookup = async connection => (await sessions()).find(item => item.connection_id === connection.connection_id);
  const deny = async (name, input, code) => {
    const reply = await call(name, input);
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.error_code, code, JSON.stringify({ name, input, reply }));
  };
  const lost = async name => {
    const rpc = getRpc();
    const pending = rpc.begin('tools/call', { name, arguments: args }, 500);
    rpc.discardResponse(pending.id);
    const before = rpc.discardedResponses;
    await assert.rejects(pending.promise, /RPC timeout/);
    assert.equal(rpc.discardedResponses, before + 1);
  };
  const grant = async (action, operation) => {
    const id = randomUUID();
    const scopes = [{ target: { kind: 'connection', connection: ref }, action }];
    const signed = await management({
      op: operation ? 'grant_operation' : 'grant', request_id: id, scopes, lifetime_ms: 120000,
      ...(operation ? { operation: { protocol: transport, request: operation } } : {}),
    });
    return { id, ticket: signed.data.summary.ticket_id };
  };
  const bind = async ({ id, ticket }) => {
    await rebind(id);
    assert.equal((await success('agent_status')).data.paired_ticket, ticket);
  };
  const acquire = () => success('input_acquire', { connection: ref, lifetime_ms: 30000 });
  const query = async () => {
    const reply = await success(status, args);
    assert.deepEqual(reply, { result: 'forget', data: { connection: ref, request_id: args.request_id, state: 'REMOVED' } });
  };
  const saved = await page();
  assert.ok(saved.profiles.some(profile => profile.id === profileId));
  const log = await logging({ op: 'start', connection: ref, request_id: requestId(), limits: { segment_bytes: 131072, segments: 2 } });
  const logArgs = { connection: ref, log_id: log.log_id };
  const logReady = await until(async () => {
    const info = await logging({ op: 'status', ...logArgs });
    return info.readable && info;
  }, 'readable synthetic log was not created');
  const logFile = path.join(directory, 'logs', logReady.readable.filename);
  const message = 'FORGET_RETAINS_中文\r\n';
  const send = { ...args, request_id: randomUUID(), text: message };
  await success('terminal_send', send);
  await until(async () => (await readFile(logFile, 'utf8')).includes(message.trim()), 'synthetic bytes never reached the readable log');
  await logging({ op: 'stop', ...logArgs });
  await until(async () => (await logging({ op: 'status', ...logArgs })).durable, 'log stop never reached durable state');
  const logBefore = await readFile(logFile);

  await deny(start, args, 'PERMISSION_DENIED');
  await success('input_release', { connection: ref, lease_id: lease.lease_id });
  const live = await grant('FORGET');
  await bind(live);
  await acquire();
  const liveArgs = { ...args, request_id: randomUUID() };
  await deny(start, liveArgs, 'INVALID_STATE');
  await deny(status, liveArgs, 'PERMISSION_DENIED');
  await deny('sessions_disconnect', liveArgs, 'PERMISSION_DENIED');
  assert.equal((await lookup(ref)).state, 'CONNECTED');

  // Desktop independently requests cleanup. The Agent never uses its Forget ticket
  // to start cleanup. Closing retires old scopes, so the test approves fresh scopes.
  const endId = randomUUID();
  const endArgs = { connection: ref, request_id: endId };
  if (serial) await writeFile(marker('close-hold'), '');
  try {
    await transportRequest({ op: 'disconnect', ...endArgs });
    if (serial) {
      await until(() => access(marker('closing')).then(() => true, () => false), 'Port did not enter held cleanup');
      await bind(await grant('FORGET'));
      await acquire();
      await deny(start, args, 'INVALID_STATE');
      await deny(status, args, 'PERMISSION_DENIED');
      assert.equal((await transportRequest({ op: 'disconnect_status', ...endArgs })).state, 'REQUESTED');
      await assert.rejects(access(marker('closed')), { code: 'ENOENT' });
    }
  } finally {
    if (serial) await writeFile(marker('close-release'), '');
  }
  await until(async () => (await transportRequest({ op: 'disconnect_status', ...endArgs })).state === 'TRANSPORT_ENDED', 'local transport cleanup was not observed');
  if (serial) await access(marker('closed'));
  else await control({ op: 'wait_disconnected' });

  // A different ticket explicitly approves the now-ended target. For UART the
  // same number was known rejected before the cleanup, with no receipt to inherit.
  const disconnectOnly = await grant('DISCONNECT');
  await bind(disconnectOnly);
  await acquire();
  await deny(start, args, 'PERMISSION_DENIED');
  const currentLease = (await success('input_lease', { connection: ref })).data;
  await success('input_release', { connection: ref, lease_id: currentLease.lease_id });
  const original = await grant('FORGET', { op: 'forget_start', connection: ref, request_id: args.request_id });
  await bind(original);
  await deny(start, args, 'INPUT_BUSY');
  await acquire();
  await deny(start, { ...args, request_id: randomUUID() }, 'PERMISSION_DENIED');
  await deny(start, { ...args, connection: other }, 'PERMISSION_DENIED');
  await deny(start, { ...args, delete_logs: true }, 'INVALID_ARGUMENT');
  await deny(status, args, 'PERMISSION_DENIED');
  assert.ok(await lookup(ref));

  await lost(start);
  await lost(status);
  await query();
  assert.equal(await lookup(ref), undefined);
  assert.equal((await success('input_lease', { connection: ref })).data, null);
  assert.deepEqual(await page(), saved);
  assert.deepEqual(await readFile(logFile), logBefore);
  assert.equal((await logging({ op: 'status', ...logArgs })).durable, true);
  await deny(status, { ...args, connection: { ...ref, generation: ref.generation + 1 } }, 'INVALID_ARGUMENT');
  await deny(status, { ...args, transport: serial ? 'SSH2' : 'SERIAL' }, 'PERMISSION_DENIED');
  await bind(disconnectOnly);
  await deny(status, args, 'PERMISSION_DENIED');
  await bind(original);

  let replacement;
  if (serial) {
    const inventory = await transportRequest({ op: 'inventory' });
    assert.equal(inventory.devices.length, 1);
    replacement = (await transportRequest({
      op: 'start', profile_id: profileId, request_id: requestId(), revision: inventory.revision,
      device_id: inventory.devices[0].device_id,
    })).connection;
  } else {
    replacement = (await transportRequest({ op: 'start', profile_id: profileId, request_id: requestId(), cols: 80, rows: 24 })).connection;
  }
  const replacementRef = { connection_id: replacement.connection_id, generation: replacement.generation };
  assert.notEqual(replacementRef.connection_id, ref.connection_id);
  const answered = new Set();
  await until(async () => {
    const info = await transportRequest({ op: 'status', connection: replacementRef });
    assert.notEqual(info.connection.state, 'FAILED');
    const challenge = info.challenge;
    if (challenge && !answered.has(challenge.id)) {
      answered.add(challenge.id);
      if (challenge.kind === 'host_key') {
        assert.equal(challenge.review.candidate.fingerprint, sshPin);
        await transportRequest({ op: 'answer_host', connection: replacementRef, challenge_id: challenge.id, approve: true });
      } else {
        await transportRequest({ op: 'authenticate', connection: replacementRef, challenge_id: challenge.id, use_saved: true, password: null });
      }
    }
    return info.connection.state === 'CONNECTED';
  }, 'replacement session did not connect');
  await query();
  await deny(status, { ...args, connection: replacementRef }, 'INVALID_ARGUMENT');
  assert.equal((await lookup(replacementRef)).state, 'CONNECTED');
  await management({ op: 'grant_revoke', request_id: original.id });
  await deny(status, args, 'PERMISSION_DENIED');
  const audit = await management({ op: 'audit', cursor: 0, limit: 128 });
  const dispatches = audit.data.events.filter(e => e.kind === 'DISPATCHED' && e.request_id === args.request_id);
  assert.deepEqual(dispatches.map(e => e.client_id), [original.ticket]);
  return { transport, terminal_status: 'REMOVED', original_dispatches: dispatches.length,
    dropped_replies: ['start', 'status'], cleanup_pending_rejected: serial,
    other_ticket_and_revoked_denied: true, replacement_unchanged: true, profile_page_unchanged: true,
    log_bytes: logBefore.length, log_sha256: createHash('sha256').update(logBefore).digest('hex') };
}
