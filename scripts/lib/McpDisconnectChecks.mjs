import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './DesktopHarness.mjs';

export async function checkMcpDisconnect({ directory, ui, call, success, ref, other, transport, management, grantId, lease, control, rebind, getRpc }) {
  const start = 'sessions_disconnect';
  const status = 'sessions_disconnect_status';
  const request_id = randomUUID();
  const args = { transport, connection: ref, request_id };
  const serial = transport === 'SERIAL';
  const marker = name => path.join(directory, `serial-mcp-${name}`);
  const snapshot = async () => JSON.parse(await readFile(marker('controller.json'), 'utf8'));
  const deny = async (name, input, code) => {
    const result = await call(name, input);
    assert.equal(result.isError, true, JSON.stringify(result));
    if (code) assert.equal(result.structuredContent.error_code, code);
  };
  const lost = async name => {
    const rpc = getRpc();
    const pending = rpc.begin('tools/call', { name, arguments: args }, 500);
    rpc.discardResponse(pending.id);
    const before = rpc.discardedResponses;
    await assert.rejects(pending.promise, /RPC timeout/);
    assert.equal(rpc.discardedResponses, before + 1);
  };
  const query = async () => {
    const receipt = await success(status, args);
    assert.equal(receipt.result, 'disconnect');
    assert.deepEqual(receipt.data, { request_id, connection: ref, state: receipt.data.state });
    assert.ok(['REQUESTED', 'TRANSPORT_ENDED'].includes(receipt.data.state));
    return receipt.data.state;
  };
  const baseline = serial ? await snapshot() : await control({ op: 'metrics' });
  const scoped = (connection, action) => [{ target: { kind: 'connection', connection }, action }];
  await deny(start, args, 'PERMISSION_DENIED');
  await success('input_release', { connection: ref, lease_id: lease.lease_id });
  const single = randomUUID();
  const signed = await management({
    op: 'grant_operation', request_id: single, scopes: scoped(ref, 'DISCONNECT'), lifetime_ms: 120000,
    operation: { protocol: transport, request: { op: 'disconnect', connection: ref, request_id } },
  });
  const ticket = signed.data.summary.ticket_id;
  await rebind(single);
  assert.equal((await success('agent_status')).data.paired_ticket, ticket);
  await deny(start, args, 'INPUT_BUSY');
  await success('input_acquire', { connection: ref, lifetime_ms: 30000 });
  const wrongGeneration = { ...ref, generation: ref.generation + 1 };
  for (const changes of [{ request_id: randomUUID() }, { connection: wrongGeneration }, { connection: other }]) {
    await deny(start, { ...args, ...changes }, 'PERMISSION_DENIED');
  }
  await deny(status, args, 'PERMISSION_DENIED');
  await deny(start, { ...args, force: true }, 'INVALID_ARGUMENT');
  assert.equal((await ui.invoke('service_list')).find(c => c.connection_id === ref.connection_id)?.state, 'CONNECTED');

  let firstStatus;
  if (serial) await writeFile(marker('close-hold'), '');
  try {
    await lost(start);
    if (serial) {
      await access(marker('closing'));
      firstStatus = await query();
      assert.equal(firstStatus, 'REQUESTED', 'Port destructor is blocked, so worker join is incomplete');
      await assert.rejects(access(marker('closed')), { code: 'ENOENT' });
    }
    await lost(status);
  } finally {
    if (serial) await writeFile(marker('close-release'), '');
  }

  let ended;
  for (let attempt = 0; attempt < 100; attempt++) {
    ended = await query();
    if (ended === 'TRANSPORT_ENDED') break;
    await delay(20);
  }
  assert.equal(ended, 'TRANSPORT_ENDED');
  if (serial) {
    await access(marker('closed'));
    assert.equal(baseline.opened, 1);
    assert.deepEqual(await snapshot(), baseline, 'disconnect did not write, control or reopen the Port');
  } else {
    assert.deepEqual(await control({ op: 'wait_disconnected' }), baseline, 'SSH peer observed transport end without additional received data');
  }
  await deny(status, { ...args, connection: wrongGeneration }, 'INVALID_ARGUMENT');
  await deny(status, { ...args, transport: serial ? 'SSH2' : 'SERIAL' }, 'PERMISSION_DENIED');
  await deny('input_acquire', { connection: ref, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await rebind(grantId);
  await deny(status, args, 'PERMISSION_DENIED');
  await rebind(single);
  assert.equal((await success('agent_status')).data.paired_ticket, ticket);
  assert.equal(await query(), 'TRANSPORT_ENDED');
  await management({ op: 'grant_revoke', request_id: single });
  await deny(status, args, 'PERMISSION_DENIED');
  const audit = await management({ op: 'audit', cursor: 0, limit: 128 });
  const dispatches = audit.data.events.filter(e => e.kind === 'DISPATCHED' && e.client_id === ticket && e.request_id === request_id);
  assert.equal(dispatches.length, 1);
  return { transport, request_id, connection: ref, first_status: firstStatus ?? null, terminal_status: ended,
    dropped_replies: ['start', 'status'], original_dispatches: dispatches.length,
    original_ticket_rebound: true, other_ticket_and_revoked_denied: true, cleanup: serial ? 'memory-port-closed-and-worker-joined' : 'service-and-ssh-peer-observed-end' };
}
