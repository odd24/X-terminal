import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { delay } from './DesktopHarness.mjs';

export async function openSilentLink(port) {
  const connections = [];
  let blocked = false;
  let blockedAt;
  const listener = createServer({ allowHalfOpen: true }, client => {
    if (connections.length === 4) {
      client.destroy();
      return;
    }
    const peer = createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
    const pair = { client, peer, dropped: [0, 0], ends: [], errors: [] };
    connections.push(pair);
    for (const [index, source, target] of [[0, client, peer], [1, peer, client]]) {
      source.setNoDelay(true);
      source.on('data', bytes => {
        if (blocked) {
          pair.dropped[index] += bytes.length;
        } else if (!target.destroyed && !target.write(bytes)) {
          source.pause();
          target.once('drain', () => source.resume());
        }
      });
      source.on('end', () => {
        pair.ends.push({ index, at: performance.now() });
        if (!blocked) target.end();
      });
      source.on('error', error => {
        pair.errors.push({ index, code: error.code, at: performance.now() });
        if (!blocked) target.destroy();
      });
    }
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: listener.address().port,
    connections,
    blackhole() {
      assert.equal(connections.length, 1);
      assert.equal(blocked, false);
      assert.ok(connections[0].client.readable && connections[0].peer.readable);
      blockedAt = performance.now();
      blocked = true;
      return blockedAt;
    },
    restore() {
      assert.ok(blocked && blockedAt);
      // Retire only the failed original pair. Every dropped byte was discarded.
      connections[0].client.destroy();
      connections[0].peer.destroy();
      blocked = false;
    },
    async close() {
      for (const pair of connections) {
        pair.client.destroy();
        pair.peer.destroy();
      }
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    },
  };
}

const statusSelector = `document.querySelector('[aria-label="SSH2 状态"]')`;
const button = label => `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;

export async function checkSilentLink({ ui, link, call, success, control, management, grantId, ref, send, sshPin }) {
  const ssh = request => ui.invoke('ssh_request', { request });
  const receipts = (request_id, connection = ref) => ({ transport: 'SSH2', connection, request_id });
  const deny = async (name, args, code) => {
    const reply = await call(name, args);
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.error_code, code, name);
  };
  const original = (await success('terminal_input_status', receipts(send.request_id))).data;
  assert.equal(original.state, 'PIPELINE_QUEUED');
  const baseline = await control({ op: 'metrics' });
  assert.equal(baseline.accepted_connections, 1);
  assert.equal(baseline.attempts, 1);
  assert.deepEqual(Buffer.from(baseline.received.flat()), Buffer.from(send.text));
  const recoveryMarker = 'P24_EXPLICIT_NEW_INPUT\r\n';
  const blockedSend = { ...send, request_id: randomUUID(), text: 'P24_DROP_CLIENT_TO_SERVER\r\n' };
  const blockedAt = link.blackhole();
  await success('terminal_send', blockedSend);
  await control({ op: 'push', text: 'P24_DROP_SERVER_TO_CLIENT\r\n' });
  const pair = link.connections[0];
  const state = () => ssh({ op: 'status', connection: ref });
  let failed;
  while (performance.now() - blockedAt < 150_000) {
    const status = await state();
    if (status.connection.state === 'FAILED') {
      failed = status;
      break;
    }
    assert.equal(status.connection.state, 'CONNECTED');
    await delay(250);
  }
  const elapsedMs = performance.now() - blockedAt;
  assert.ok(failed, 'default SSH keepalive did not terminate the original generation');
  assert.ok(elapsedMs >= 85_000, 'a prompt socket closure is not a keepalive timeout');
  assert.deepEqual([failed.connection.connection_id, failed.connection.generation], [ref.connection_id, ref.generation]);
  assert.equal(failed.failure, 'TRANSPORT');
  assert.ok(pair.dropped.every(count => count > 0));
  assert.ok(pair.ends.every(event => event.index === 0 && event.at - blockedAt >= 85_000));
  assert.ok(pair.errors.every(event => event.index === 0 && event.at - blockedAt >= 85_000));
  assert.equal(pair.peer.readable, true, 'upstream remained TCP-open until the owned proxy retired it');
  assert.equal(link.connections.length, 1);
  await ui.click('关闭Agent授权');
  const failedUi = `FAILED · 代次 ${ref.generation} · 编码 utf8 · TRANSPORT`;
  await ui.waitFor(`${statusSelector}?.textContent===${JSON.stringify(failedUi)} && ${statusSelector}.getClientRects().length>0`);
  const grant = await management({ op: 'grant_status', request_id: grantId });
  assert.deepEqual(grant.data.effective_scopes, []);
  assert.equal((await success('input_lease', { connection: ref })).data, null);
  assert.deepEqual((await success('terminal_input_status', receipts(send.request_id))).data, original);
  await deny('terminal_send', { ...blockedSend, request_id: randomUUID() }, 'PERMISSION_DENIED');
  const oldText = (await ui.invoke('service_read_text', { connection: ref, cursor: 1 })).events.map(row => row.text).join('');
  assert.ok(!oldText.includes('P24_DROP_SERVER_TO_CLIENT'));

  const socketEvents = [...pair.ends, ...pair.errors].map(({ index, at, code }) => ({ index, elapsedMs: at - blockedAt, code }));
  link.restore();
  await delay(750);
  assert.equal(link.connections.length, 1);
  const idle = await control({ op: 'metrics' });
  assert.equal(idle.accepted_connections, 1);
  assert.equal(idle.attempts, 1);
  assert.deepEqual(idle.received, baseline.received);
  assert.equal(await ui.evaluate(`${statusSelector}?.textContent`), failedUi);

  await ui.click('显式重连 SSH2');
  const next = { ...ref, generation: ref.generation + 1 };
  const connectedUi = `CONNECTED · 代次 ${next.generation} · 编码 utf8`;
  const hostAction = `!!${button('拒绝 SSH2 主机')}`;
  const authAction = `!!${button('使用保存的 SSH2 凭据')}`;
  await ui.waitFor(`${hostAction} || ${authAction}`);
  if (await ui.evaluate(hostAction)) {
    assert.equal(await ui.evaluate(`document.querySelector('.ssh-panel .fingerprint').textContent`), sshPin);
    await ui.evaluate(`document.querySelector('[aria-label="已核对 SSH2 主机指纹"]').click()`);
    await ui.click('信任本次 SSH2 主机');
    await ui.waitFor(authAction);
  }
  await ui.click('使用保存的 SSH2 凭据');
  await ui.waitFor(`${statusSelector}?.textContent===${JSON.stringify(connectedUi)} && ${statusSelector}.getClientRects().length>0`);
  assert.equal((await ssh({ op: 'status', connection: next })).connection.state, 'CONNECTED');
  assert.equal(link.connections.length, 2);
  assert.equal((await success('input_lease', { connection: next })).data, null);
  await deny('input_acquire', { connection: next, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await deny('terminal_send', { ...blockedSend, request_id: randomUUID(), connection: next }, 'PERMISSION_DENIED');
  await deny('terminal_read', { connection: next, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await deny('terminal_input_status', receipts(send.request_id), 'STALE_GENERATION');
  await deny('terminal_input_status', receipts(send.request_id, next), 'NOT_FOUND');
  const newPeer = await control({ op: 'metrics' });
  assert.equal(newPeer.accepted_connections, 2);
  assert.equal(newPeer.attempts, 2);
  assert.deepEqual(newPeer.received, baseline.received);
  const fresh = Buffer.from(recoveryMarker);
  await ssh({ op: 'write', connection: next, request_id: randomUUID(), bytes: [...fresh] });
  let newOutput = '';
  for (let attempt = 0; attempt < 100 && !newOutput.includes(recoveryMarker); attempt++) {
    newOutput = (await ui.invoke('service_read_text', { connection: next, cursor: 1 })).events.map(row => row.text).join('');
    if (!newOutput.includes(recoveryMarker)) await delay(30);
  }
  assert.ok(newOutput.includes(recoveryMarker));
  assert.ok(!newOutput.includes(send.text) && !newOutput.includes(blockedSend.text));
  assert.deepEqual(Buffer.from((await control({ op: 'metrics' })).received.flat()), Buffer.concat([Buffer.from(send.text), fresh]));
  return { result: 'PASS', old: ref, next, failure: failed.failure, elapsedMs, droppedBytes: pair.dropped, socketEvents,
    upstreamSocketStayedOpen: true, priorDialsAfterRestore: 1, authAttempts: 2, replayedBytes: 0, freshBytes: fresh.length };
}
