import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './DesktopHarness.mjs';

async function until(read, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

export async function checkMcpSerialConnect({ directory, ui, call, success, ref, other, management, grantId, rebind, getRpc }) {
  const start = 'serial_connect';
  const status = 'serial_connect_status';
  const profile_id = randomUUID();
  const profile = {
    id: profile_id, folder_id: null, name: 'MCP单次固定内存UART',
    settings: { protocol: 'serial', port: 'COM7', baud_rate: 115200, data_bits: 8, stop_bits: 1, parity: 'none', flow: 'none', dtr_on_open: true, rts_on_open: true, encoding: 'utf8' },
  };
  const marker = name => path.join(directory, `serial-mcp-${name}`);
  const serial = request => ui.invoke('serial_request', { request });
  const save = name => ui.invoke('config_request', { request: { op: 'save_profile', profile: { ...profile, name }, credential: { action: 'keep' } } });
  const handoff = '[aria-label="已批准的 MCP 串口建连参数"]';
  const value = label => ui.evaluate(`document.querySelector('[aria-label="${label}"]').value`);
  const snapshot = () => until(async () => {
    try { return JSON.parse(await readFile(marker('controller.json'), 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  }, 'no complete UART controller snapshot');
  const deny = async (name, args, code) => {
    const reply = await call(name, args);
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.error_code, code, JSON.stringify({ name, reply }));
  };
  const assertReceipt = (reply, target) => {
    assert.equal(reply.result, 'serial_connect');
    assert.deepEqual(reply.data.target, target);
    assert.equal(reply.data.connection.state, 'CONNECTING');
    assert.equal(reply.data.connection.protocol, 'SERIAL');
    assert.equal(reply.data.connection.generation, 1);
    const { connection_id, generation } = reply.data.connection;
    return { connection_id, generation };
  };
  const revoke = request_id => management({ op: 'grant_revoke', request_id });
  const baseline = await snapshot();
  assert.equal(baseline.opened, 1);
  assert.equal(baseline.dtr, false);
  assert.equal(baseline.rts, false);
  const initial = await save(profile.name);
  const inventory = await serial({ op: 'inventory' });
  assert.equal(inventory.devices.length, 1);
  const deniedTarget = { profile_id, profile_revision: initial.revision, inventory_revision: inventory.revision, device_id: inventory.devices[0].device_id, request_id: randomUUID() };
  await deny(start, deniedTarget, 'PERMISSION_DENIED');
  const scopedId = randomUUID();
  await management({
    op: 'grant', request_id: scopedId, lifetime_ms: 120000,
    scopes: [{ target: { kind: 'profile_revision', profile_id, revision: initial.revision }, action: 'CONNECT' }],
  });
  await rebind(scopedId);
  await deny(start, deniedTarget, 'PERMISSION_DENIED');
  await deny(status, deniedTarget, 'PERMISSION_DENIED');
  const legacyId = randomUUID();
  await management({
    op: 'grant', request_id: legacyId, lifetime_ms: 120000,
    scopes: [{ target: { kind: 'profile', profile_id }, action: 'CONNECT' }],
  });
  await rebind(legacyId);
  await deny(start, deniedTarget, 'PERMISSION_DENIED');
  const end = { connection: ref, request_id: randomUUID() };
  await ui.selectTab(other.connection_id);
  await serial({ op: 'disconnect', ...end });
  await until(async () => (await serial({ op: 'disconnect_status', ...end })).state === 'TRANSPORT_ENDED', 'original fixture did not join');
  assert.deepEqual(await snapshot(), baseline);

  const approve = async (capture = false) => {
    const previousHandoff = await ui.evaluate(`document.querySelector(${JSON.stringify(handoff)})?.value ?? null`);
    await ui.fill('Agent授权形式', 'scoped');
    await ui.fill('Agent授权形式', 'single_operation');
    await ui.fill('Agent单次动作', 'start');
    await ui.click('读取单次固定配置');
    await ui.waitFor(`Array.from(document.querySelector('[aria-label="Agent单次配置"]').options).some(o=>o.value===${JSON.stringify(profile_id)})`);
    await ui.fill('Agent单次配置', profile_id);
    await ui.click('读取单次串口库存');
    await ui.waitFor(`document.querySelector('[aria-label="Agent单次设备"]')?.options.length===2`);
    const device = await ui.evaluate(`document.querySelector('[aria-label="Agent单次设备"]').options[1].value`);
    await ui.fill('Agent单次设备', device);
    await ui.click('预览Agent单次操作');
    await ui.waitFor(`!!document.querySelector('[aria-label="Agent单次预览"]')`);
    const text = await ui.evaluate(`document.querySelector('[aria-label="Agent单次预览"]').textContent`);
    for (const visible of [profile_id, device, 'COM7', '初始DTR 开启', '初始RTS 开启', '库存版本']) assert.ok(text.includes(visible));
    assert.equal(await ui.evaluate(`document.querySelector('[aria-label="同意Agent单次操作"]').checked`), false);
    if (capture) await ui.screenshot('P15-serial-connect-v8-approved-preview.png');
    await ui.evaluate(`document.querySelector('[aria-label="同意Agent单次操作"]').click()`);
    await ui.click('确认批准Agent单次');
    await ui.waitFor(`document.querySelector(${JSON.stringify(handoff)})?.value != null && document.querySelector(${JSON.stringify(handoff)}).value !== ${JSON.stringify(previousHandoff)}`);
    const id = await value('Agent签发编号');
    const args = await ui.evaluate(`JSON.parse(document.querySelector(${JSON.stringify(handoff)}).value)`);
    assert.deepEqual(Object.keys(args).sort(), ['device_id', 'inventory_revision', 'profile_id', 'profile_revision', 'request_id']);
    assert.equal(args.profile_id, profile_id);
    assert.equal(args.device_id, device);
    for (const field of Object.values(args)) assert.ok(text.includes(field));
    assert.deepEqual(await snapshot(), baseline, 'approval does not open or change lines');
    if (capture) {
      await ui.evaluate(`document.querySelector(${JSON.stringify(handoff)}).scrollIntoView({block:'center'})`);
      await ui.screenshot('P15-serial-connect-v8-handoff.png');
    }
    await rebind(id);
    return { id, args, ticket: (await success('agent_status')).data.paired_ticket };
  };
  const oldProfile = await approve();
  await save('MCP单次固定内存UART改版');
  await deny(start, oldProfile.args, 'INVALID_ARGUMENT');
  await deny(status, oldProfile.args, 'PERMISSION_DENIED');
  const oldInventory = await approve();
  await serial({ op: 'inventory' });
  await deny(start, oldInventory.args, 'INVALID_STATE');
  await deny(status, oldInventory.args, 'PERMISSION_DENIED');
  assert.deepEqual(await snapshot(), baseline);

  for (const invalidate of ['revoke', 'close', 'inventory']) {
    const { id, args } = await approve();
    await writeFile(marker('open-hold'), '');
    let connection;
    try {
      connection = assertReceipt(await success(start, args), args);
      await until(() => access(marker('open-entered')).then(() => true, () => false), 'worker did not reach pre-open gate');
      assert.deepEqual(await snapshot(), baseline);
      if (invalidate === 'revoke') await revoke(id);
      if (invalidate === 'close') await serial({ op: 'close', connection });
      if (invalidate === 'inventory') await serial({ op: 'inventory' });
    } finally {
      await writeFile(marker('open-release'), '');
    }
    await until(async () => {
      const info = await serial({ op: 'status', connection });
      return !info.cleanup_pending && ['DISCONNECTED', 'FAILED'].includes(info.connection.state);
    }, `worker not released after ${invalidate}`);
    for (const file of ['open-hold', 'open-entered', 'open-release']) await unlink(marker(file));
    assert.deepEqual(await snapshot(), baseline, `${invalidate} must not open or apply initial lines`);
    if (invalidate === 'revoke') await deny(status, args, 'PERMISSION_DENIED');
    else assert.deepEqual(assertReceipt(await success(status, args), args), connection);
  }

  const { id, args, ticket } = await approve(true);
  for (const field of ['profile_id', 'profile_revision', 'inventory_revision', 'device_id', 'request_id']) {
    await deny(start, { ...args, [field]: randomUUID() }, 'PERMISSION_DENIED');
  }
  for (const extra of [{ port: 'COM7' }, { path: 'synthetic-path' }, { dtr_on_open: false }]) {
    await deny(start, { ...args, ...extra }, 'INVALID_ARGUMENT');
  }
  await deny(status, args, 'PERMISSION_DENIED');
  const rpc = getRpc();
  const pending = rpc.begin('tools/call', { name: start, arguments: args }, 500);
  rpc.discardResponse(pending.id);
  const discardedBefore = rpc.discardedResponses;
  await assert.rejects(pending.promise, /RPC timeout/);
  assert.equal(rpc.discardedResponses, discardedBefore + 1);
  const receipt = await success(status, args);
  const connection = assertReceipt(receipt, args);
  await until(async () => (await serial({ op: 'status', connection })).connection.state === 'CONNECTED', 'counted memory port did not open');
  assert.deepEqual(await snapshot(), { ...baseline, opened: baseline.opened + 1, dtr: true, rts: true });
  await deny(status, { ...args, device_id: randomUUID() }, 'INVALID_ARGUMENT');
  await deny('terminal_read', { connection, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await deny('serial_write', { connection, request_id: randomUUID(), bytes: [0, 255] }, 'PERMISSION_DENIED');
  await deny('serial_control', { connection, request_id: randomUUID(), line: 'DTR', asserted: false }, 'PERMISSION_DENIED');
  await deny('input_acquire', { connection, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
  await rebind(grantId);
  assert.equal(await ui.evaluate(`!!document.querySelector(${JSON.stringify(handoff)})`), false);
  await deny(status, args, 'PERMISSION_DENIED');
  await rebind(id);
  await serial({ op: 'inventory' });
  assert.deepEqual(await success(status, args), receipt);
  await revoke(id);
  await deny(status, args, 'PERMISSION_DENIED');
  const audit = await management({ op: 'audit', cursor: 0, limit: 128 });
  const dispatches = audit.data.events.filter(event => event.kind === 'DISPATCHED' && event.request_id === args.request_id);
  assert.deepEqual(dispatches.map(event => [event.client_id, event.scope]), [[ticket, {
    target: { kind: 'profile_revision', profile_id, revision: args.profile_revision }, action: 'CONNECT',
  }]]);
  const final = await snapshot();
  assert.deepEqual(final, { ...baseline, opened: baseline.opened + 1, dtr: true, rts: true });
  return { result: 'PASS', receipt: receipt.data, baseline, final, opens_added: 1, dispatches: 1,
    first_reply_discarded: true, desktop_single_handoff: true, pre_open_denials: ['revoke', 'close', 'inventory'] };
}
