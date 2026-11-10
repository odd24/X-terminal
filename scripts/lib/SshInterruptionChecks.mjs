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

export async function checkSshInterruption({ ui, call, success, ref, management, grantId, lease, control, send, killSshFixture, restartPeer }) {
  const ssh = request => ui.invoke('ssh_request', { request });
  const metrics = () => control({ op: 'metrics' });
  const newInput = (text, connection = ref) => ({ transport: 'SSH2', connection, request_id: randomUUID(), text });
  const receiptArgs = (request_id, connection = ref) => ({ transport: 'SSH2', connection, request_id });
  const receipt = async request_id => (await success('terminal_input_status', receiptArgs(request_id))).data;
  const deny = async (name, args, code) => {
    const reply = await call(name, args);
    assert.equal(reply.isError, true, name);
    assert.equal(reply.structuredContent.error_code, code, name);
  };
  const statusSelector = `document.querySelector('[aria-label="SSH2 状态"]')`;
  const readStatus = () => ui.evaluate(`${statusSelector}?.textContent`);

  const accepted = await receipt(send.request_id);
  assert.equal(accepted.state, 'PIPELINE_QUEUED');
  assert.equal(accepted.pipeline_bytes, Buffer.byteLength(send.text));
  const baseline = await metrics();
  assert.deepEqual(Buffer.from(baseline.received.flat()), Buffer.from(send.text));
  await control({ op: 'stall_next_data' });
  const writes = [];
  for (let index = 0; index < 4; index++) {
    const input = newInput(`P24_BACKPRESSURE_${index}:`.padEnd(16384, 'x'));
    writes.push(input);
    await success('terminal_send', input);
  }
  await until(async () => (await metrics()).received.flat().length > accepted.pipeline_bytes, 'peer never reached the blocked handler');
  const dispatching = await until(async () => {
    for (const input of writes) {
      const current = await receipt(input.request_id);
      if (current.state === 'DISPATCHING') return current;
    }
  }, 'no write was observed in DISPATCHING');
  const tail = newInput('P24_UNSTARTED_TAIL');
  assert.equal((await success('terminal_send', tail)).data.state, 'PENDING');
  const pending = await receipt(tail.request_id);
  assert.equal(pending.state, 'PENDING');
  assert.equal((await success('input_lease', { connection: ref })).data.lease_id, lease.lease_id);
  const beforeLoss = Buffer.from((await metrics()).received.flat());
  assert.ok(!beforeLoss.includes(tail.text));
  assert.deepEqual(await receipt(dispatching.request_id), dispatching);

  // Kill the fixture process while its SSH data handler is blocked. No SSH close RPC is sent.
  const lostPeer = await killSshFixture();
  const failed = await until(async () => {
    const status = await ssh({ op: 'status', connection: ref });
    return status.connection.state === 'FAILED' && status;
  }, 'the original generation did not become FAILED');
  assert.equal(failed.failure, 'TRANSPORT');
  await ui.click('关闭Agent授权');
  const failedUi = `FAILED · 代次 ${ref.generation} · 编码 utf8 · TRANSPORT`;
  await ui.waitFor(`${statusSelector}?.textContent === ${JSON.stringify(failedUi)} && ${statusSelector}.getClientRects().length > 0`);
  assert.equal(await readStatus(), failedUi);
  const unknown = await receipt(dispatching.request_id);
  const cancelled = await receipt(tail.request_id);
  assert.deepEqual(await receipt(send.request_id), accepted);
  assert.deepEqual(unknown, { request_id: dispatching.request_id, state: 'UNKNOWN', pipeline_bytes: null, failure: 'TRANSPORT' });
  assert.deepEqual(cancelled, { request_id: tail.request_id, state: 'CANCELLED_BEFORE_DISPATCH', pipeline_bytes: null, failure: 'TRANSPORT' });
  assert.equal((await success('input_lease', { connection: ref })).data, null);
  const grant = await management({ op: 'grant_status', request_id: grantId });
  assert.deepEqual(grant.data.effective_scopes, []);
  await deny('input_acquire', { connection: ref, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await deny('terminal_send', newInput('P24_OLD_MUST_NOT_SEND'), 'PERMISSION_DENIED');

  const { server, control: replacement } = await restartPeer();
  const replacementMetrics = () => replacement({ op: 'metrics' });
  await delay(500);
  const idle = await replacementMetrics();
  assert.equal(idle.accepted_connections, 0);
  assert.equal(idle.attempts, 0);
  assert.equal(await readStatus(), failedUi);

  await ui.click('显式重连 SSH2');
  const next = { ...ref, generation: ref.generation + 1 };
  const host = await until(async () => {
    const connection = (await ui.invoke('service_list')).find(item => item.connection_id === ref.connection_id);
    if (connection?.generation !== next.generation) return;
    const status = await ssh({ op: 'status', connection: next });
    return status.challenge?.kind === 'host_key' && status.challenge;
  }, 'manual reconnect did not produce a new host challenge on the same logical connection');
  assert.equal(host.review.candidate.fingerprint, server.pin);
  assert.equal(host.review.status, 'changed');
  await ui.waitFor(`Array.from(document.querySelectorAll('.fingerprint')).some(item => item.textContent === ${JSON.stringify(server.pin)})`);
  await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
  await ui.click('信任本次 SSH2 主机');
  await ui.waitFor(`!!document.querySelector('[aria-label="SSH2 临时密码"]')`);
  const beforeAuth = await replacementMetrics();
  assert.equal(beforeAuth.accepted_connections, 1);
  assert.equal(beforeAuth.attempts, 0);
  await ui.fill('SSH2 临时密码', server.password);
  await ui.click('提交本次 SSH2 密码');
  const connectedUi = `CONNECTED · 代次 ${next.generation} · 编码 utf8`;
  await ui.waitFor(`${statusSelector}?.textContent === ${JSON.stringify(connectedUi)} && ${statusSelector}.getClientRects().length > 0`);
  assert.equal((await ssh({ op: 'status', connection: next })).connection.state, 'CONNECTED');

  assert.equal((await success('input_lease', { connection: next })).data, null);
  await deny('input_acquire', { connection: next, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await deny('terminal_send', newInput('P24_NEW_MUST_NOT_SEND', next), 'PERMISSION_DENIED');
  await deny('terminal_read', { connection: next, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  for (const original of [accepted, unknown, cancelled]) {
    await deny('terminal_input_status', receiptArgs(original.request_id), 'STALE_GENERATION');
    await deny('terminal_input_status', receiptArgs(original.request_id, next), 'NOT_FOUND');
  }
  const beforeNewInput = await replacementMetrics();
  assert.equal(beforeNewInput.attempts, 1);
  assert.deepEqual(beforeNewInput.received, []);
  const fresh = Buffer.from('P24_FRESH_DESKTOP_INPUT\r\n');
  await ssh({ op: 'write', connection: next, request_id: randomUUID(), bytes: [...fresh] });
  const newWire = await until(async () => {
    const received = Buffer.from((await replacementMetrics()).received.flat());
    return received.length >= fresh.length && received;
  }, 'the new peer did not receive explicit Desktop input');
  assert.deepEqual(newWire, fresh);
  const newOutput = await until(async () => {
    const output = (await ui.invoke('service_read_text', { connection: next, cursor: 1 })).events.map(event => event.text).join('');
    return output.includes(fresh.toString()) && output;
  }, 'the new generation did not receive its own echo');
  assert.ok(![send.text, 'P24_BACKPRESSURE_', tail.text].some(text => newOutput.includes(text)));
  assert.deepEqual(Buffer.from((await replacementMetrics()).received.flat()), fresh);

  return { result: 'PASS', transport: 'SSH2', fixture: false, old: ref, current: next,
    original_peer_exit: lostPeer, failed_ui: failedUi, recovered_ui: connectedUi,
    receipts: { accepted, dispatching, pending, unknown, cancelled },
    old_peer_bytes_at_last_sample: beforeLoss.length, new_peer_bytes_before_manual_input: 0,
    new_peer_bytes_after_manual_input: fresh.length, new_peer_dials_before_manual_reconnect: 0,
    new_peer_connections: 1, new_peer_auth_attempts: 1, old_grant_and_lease_reused: false };
}
