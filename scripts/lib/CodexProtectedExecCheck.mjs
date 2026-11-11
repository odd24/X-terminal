import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requestId } from '../../apps/desktop/src/request-id.ts';
import { delay } from './DesktopHarness.mjs';

// The loopback SSH fixture handles this marker in its exec callback.
const command = 'protected-exec';
const secret = 'synthetic-secret';
const timeout_ms = 3000;
const max_output_bytes = 65536;
const scopes = connection => [{ target: { kind: 'connection', connection }, action: 'EXEC' }];

export async function approveCodexExec({ ui, openAgent, ref, management }) {
  await openAgent();
  await ui.fill('Agent授权形式', 'single_operation');
  await ui.fill('Agent单次动作', 'exec');
  await ui.fill('Agent单次正文', command);
  await ui.fill('Agent单次exec超时', timeout_ms);
  await ui.fill('Agent单次exec上限', max_output_bytes);
  await ui.evaluate(`document.querySelector('[aria-label="启用Agent输出保护"]').click()`);
  await ui.click('添加精确文本规则');
  await ui.fill('Agent精确文本规则1', secret);
  await ui.click('预览Agent单次操作');
  const preview = `document.querySelector('[aria-label="Agent单次预览"]')`;
  await ui.waitFor(`!!${preview}`);
  const fields = await ui.evaluate(`Object.fromEntries(Array.from(${preview}.querySelectorAll(':scope > div')).map(row =>
    [row.querySelector('strong').textContent.slice(0,-1), (row.querySelector('pre') ?? row.querySelector('p')).textContent]))`);
  const request_id = fields['原操作编号'];
  assert.match(request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fields['协议'], 'SSH2');
  assert.equal(fields['连接'], `${ref.connection_id} / 代次 ${ref.generation}`);
  assert.equal(fields['完整命令（转义显示）'], JSON.stringify(command));
  assert.equal(fields['超时'], `${timeout_ms} 毫秒`);
  assert.equal(fields['输出上限'], `${max_output_bytes} 字节`);
  const protection = `document.querySelector('[aria-label="Agent输出保护预览"]')`;
  assert.equal(await ui.evaluate(`${protection}.querySelector('pre').textContent`), JSON.stringify(secret));
  const consent = `document.querySelector('[aria-label="同意Agent单次操作"]')`;
  assert.equal(await ui.evaluate(`${consent}.checked`), false);
  await ui.evaluate(`${consent}.click()`);
  await ui.click('确认批准Agent单次');
  await ui.waitFor(`document.querySelector('[aria-label="Agent管理状态"]')?.textContent.includes('已批准一次固定操作')`);
  const grantId = await ui.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`);
  const signed = await management({ op: 'grant_status', request_id: grantId });
  assert.deepEqual(signed.data.approved_scopes, scopes(ref));
  assert.equal(signed.data.protection.literal_count, 1);
  const target = { connection: ref, request_id, command, timeout_ms, max_output_bytes };
  const operation = { protocol: 'SSH2', request: { op: 'exec', ...target } };
  assert.equal(signed.data.form.kind, 'single_operation');
  assert.equal(signed.data.form.operation.fingerprint, createHash('sha256').update(JSON.stringify(operation)).digest('hex'));
  return { target, grantId, signed };
}

export async function checkCodexExec({ call, target, signed, metrics }) {
  const { connection, request_id } = target;
  const ticket = signed.data.summary.ticket_id;
  const { data: status } = await call('agent_status');
  assert.equal(status.paired_ticket, ticket);
  assert.deepEqual(status.approved_scopes, scopes(connection));
  assert.deepEqual(status.protection, signed.data.protection);
  assert.deepEqual((await metrics()).exec_calls, []);
  assert.equal((await call('input_lease', { connection })).data, null);
  const lease = (await call('input_acquire', { connection, lifetime_ms: 30000 })).data;
  assert.deepEqual(lease.connection, connection);
  assert.equal(lease.client_id, ticket);

  const query = { connection, task_id: request_id };
  const taskStatus = reply => {
    assert.equal(reply.result, 'task');
    assert.deepEqual(reply.data.connection, connection);
    assert.equal(reply.data.task_id, request_id);
    assert.ok(!JSON.stringify(reply).includes(secret));
    return reply.data;
  };
  const started = taskStatus(await call('ssh_exec', target));
  let finished;
  for (let i = 0; i < 20; i++) {
    finished = taskStatus(await call('tasks_get', { ...query, view: { kind: 'status' } }));
    if (finished.phase === 'FINISHED') break;
    await delay(50);
  }
  assert.equal(finished.phase, 'FINISHED');
  assert.equal(finished.summary.end, 'COMPLETED');
  assert.equal(finished.summary.exit_status, 0);
  assert.equal(finished.summary.request_accepted, true);
  assert.equal(finished.summary.output_truncated, false);
  const outputView = { kind: 'output', cursor: 1, max_bytes: 65536 };
  const read = async through_cursor => {
    const reply = await call('tasks_get', { ...query, view: { ...outputView, through_cursor } });
    assert.equal(reply.result, 'task_protected_output');
    assert.deepEqual(reply.data.connection, connection);
    assert.equal(reply.data.task_id, request_id);
    assert.deepEqual(reply.data.output.context.protection, signed.data.protection);
    assert.ok(!JSON.stringify(reply).includes(secret));
    return reply.data.output;
  };
  const info = await read(null);
  assert.equal(info.result, 'info');
  assert.equal(info.context.source_completed, true);
  const through = info.context.through_cursor;
  const output = await read(through);
  assert.equal(output.result, 'text');
  assert.equal(output.next_cursor, through);
  assert.equal(output.truncated, false);
  for (const [stderr, prefix, label] of [[false, 'early|', 'OUT'], [true, 'err|', 'ERR']]) {
    const text = output.events.filter(event => event.stderr === stderr).map(event => event.text).join('');
    assert.equal(text, `${prefix}${label} ${'*'.repeat(secret.length)} ${'.'.repeat(150)} ${label}_END`);
  }
  await call('tasks_get', { ...query, task_id: requestId(), view: { kind: 'status' } }, 'NOT_FOUND');
  await call('input_release', { connection, lease_id: lease.lease_id });
  const observed = await metrics();
  assert.deepEqual(observed.exec_calls, [[...Buffer.from(command)]]);
  assert.equal(observed.received.flat().length, 0);
  return { query, startPhase: started.phase, finalStatus: finished, protectedThroughCursor: through,
    protectedStdout: true, protectedStderr: true, wrongTaskDenied: true,
    fixtureExecRequests: 1, fixtureTerminalInputBytes: 0, inputLeaseReleased: true };
}
