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

export async function checkMcpSshResize({ ui, call, success, ref, other, management, lease, control, rebind, getRpc }) {
  const tool = 'ssh_resize';
  const ssh = request => ui.invoke('ssh_request', { request });
  const metrics = () => control({ op: 'metrics' });
  const resize = (cols, rows, request_id = randomUUID()) => ({ connection: ref, request_id, cols, rows });
  const size = ({ cols, rows }) => [cols, rows];
  const requestStatus = ({ connection, request_id }) => ({ connection, request_id });
  const status = args => success('terminal_input_status', { transport: 'SSH2', ...requestStatus(args) });
  const count = async args => (await metrics()).sizes.filter(([cols, rows]) => cols === args.cols && rows === args.rows).length;
  const accepted = async args => until(async () => {
    const receipt = await status(args);
    assert.equal(receipt.result, 'ssh_input');
    assert.equal(receipt.data.request_id, args.request_id);
    return receipt.data.state === 'PIPELINE_QUEUED' && receipt;
  }, 'SSH resize was not accepted by its pipeline');
  const deny = async (name, args, code) => {
    const reply = await call(name, args);
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.error_code, code, JSON.stringify({ name, args, reply }));
  };
  const grant = async (actions, operation) => {
    const id = randomUUID();
    const signed = await management({
      op: operation ? 'grant_operation' : 'grant', request_id: id, lifetime_ms: 120000,
      scopes: actions.map(action => ({ target: { kind: 'connection', connection: ref }, action })),
      ...(operation ? { operation: { protocol: 'SSH2', request: operation } } : {}),
    });
    return { id, ticket: signed.data.summary.ticket_id };
  };
  const bind = async ({ id, ticket }) => {
    await rebind(id);
    assert.equal((await success('agent_status')).data.paired_ticket, ticket);
  };
  const acquire = async () => (await success('input_acquire', { connection: ref, lifetime_ms: 30000 })).data;
  const release = lease => success('input_release', { connection: ref, lease_id: lease.lease_id });
  const initial = await metrics();
  const exact = resize(127, 39);
  await deny(tool, exact, 'PERMISSION_DENIED');
  await release(lease);
  await bind(await grant(['EXEC']));
  const execLease = await acquire();
  await deny(tool, exact, 'PERMISSION_DENIED');
  await release(execLease);

  const original = await grant(['CONTROL'], { op: 'resize', ...exact });
  await bind(original);
  await deny(tool, exact, 'INPUT_BUSY');
  const controlLease = await acquire();
  for (const changes of [{ cols: 128 }, { rows: 40 }, { request_id: randomUUID() },
    { connection: other }, { connection: { ...ref, generation: ref.generation + 1 } }]) {
    await deny(tool, { ...exact, ...changes }, 'PERMISSION_DENIED');
  }
  for (const changes of [{ cols: 1 }, { cols: 501 }, { rows: 0 }, { rows: 201 }, { transport: 'SERIAL' }, { pixels: 100 }]) {
    await deny(tool, { ...exact, ...changes }, 'INVALID_ARGUMENT');
  }
  await deny('terminal_read', { connection: ref, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await deny('terminal_send', { transport: 'SSH2', connection: ref, request_id: randomUUID(), text: 'MUST_NOT_SEND' }, 'PERMISSION_DENIED');
  assert.deepEqual((await metrics()).sizes, initial.sizes);

  const rpc = getRpc();
  const pending = rpc.begin('tools/call', { name: tool, arguments: exact }, 500);
  rpc.discardResponse(pending.id);
  const discardedBefore = rpc.discardedResponses;
  await assert.rejects(pending.promise, /RPC timeout/);
  assert.equal(rpc.discardedResponses, discardedBefore + 1);
  const receipt = await accepted(exact);
  await until(async () => await count(exact) === 1, 'SSH peer did not receive exact dimensions');
  await deny('terminal_input_status', { transport: 'SSH2', ...requestStatus(exact), connection: { ...ref, generation: ref.generation + 1 } }, 'STALE_GENERATION');
  const fence = resize(129, 41);
  await ssh({ op: 'resize', ...fence });
  await until(async () => await count(fence) === 1, 'Desktop resize fence did not reach the peer');
  assert.deepEqual((await success('input_lease', { connection: ref })).data, controlLease);
  await release(controlLease);
  await bind(await grant(['CONTROL']));
  await deny('terminal_input_status', { transport: 'SSH2', ...requestStatus(exact) }, 'PERMISSION_DENIED');
  await bind(original);
  assert.deepEqual(await status(exact), receipt);
  assert.equal(await count(exact), 1);

  const cancellations = [];
  for (const mode of ['revoke', 'takeover']) {
    const active = await grant(['WRITE', 'CONTROL']);
    await bind(active);
    await acquire();
    const blocked = mode === 'revoke' ? resize(137, 43) : resize(141, 45);
    const barrier = mode === 'revoke' ? resize(139, 47) : resize(143, 49);
    const before = (await metrics()).received.flat().length;
    await control({ op: 'stall_next_data' });
    try {
      const writes = [];
      for (let index = 0; index < 4; index++) {
        const args = { transport: 'SSH2', connection: ref, request_id: randomUUID(), text: 'x'.repeat(16384) };
        writes.push(args);
        await success('terminal_send', args);
      }
      await until(async () => (await metrics()).received.flat().length > before, 'synthetic peer did not receive the blocking write prefix');
      await until(async () => {
        for (const write of writes) {
          if ((await status(write)).data.state === 'DISPATCHING') return true;
        }
        return false;
      }, 'SSH transport was not backpressured');
      const queued = await success(tool, blocked);
      assert.equal(queued.result, 'ssh_input');
      assert.equal(queued.data.request_id, blocked.request_id);
      assert.equal(queued.data.state, 'PENDING');
      if (mode === 'revoke') await management({ op: 'grant_revoke', request_id: active.id });
      else await management({ op: 'takeover', connection: ref });
    } finally {
      await control({ op: 'unblock_data' });
    }
    await until(async () => (await ssh({ op: 'input_status', ...requestStatus(blocked) })).state === 'CANCELLED_BEFORE_DISPATCH', 'queued Resize did not cancel');
    if (mode === 'revoke') await deny('terminal_input_status', { transport: 'SSH2', ...requestStatus(blocked) }, 'PERMISSION_DENIED');
    else assert.equal((await status(blocked)).data.state, 'CANCELLED_BEFORE_DISPATCH');
    await ssh({ op: 'resize', ...barrier });
    await until(async () => await count(barrier) === 1, 'wire-visible resize fence did not arrive');
    assert.equal(await count(blocked), 0, 'invalidated queued size reached the peer');
    cancellations.push({ mode, receipt: 'CANCELLED_BEFORE_DISPATCH', rejected_dimensions: size(blocked), fence_dimensions: size(barrier) });
  }
  assert.equal(await count(exact), 1);
  return { result: 'PASS', pipeline_receipt: receipt.data, actual_dimensions: size(exact), actual_count: 1,
    first_reply_discarded: true, desktop_resize_preserves_agent_lease: true, cancellations };
}
