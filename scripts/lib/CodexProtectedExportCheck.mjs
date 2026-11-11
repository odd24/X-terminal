import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { requestId } from '../../apps/desktop/src/request-id.ts';
import { delay } from './DesktopHarness.mjs';

const marker = 'P16 导出正文';
const secret = 'P16_SYNTHETIC_EXPORT_SECRET';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function approveCodexExport({ ui, openAgent, ref, serviceId, control }) {
  await control({ op: 'push', text: `${marker} ${secret}\r\n` });
  let raw;
  for (let i = 0; i < 100; i++) {
    raw = (await ui.invoke('service_read_text', { connection: ref, cursor: 1 })).events.map(event => event.text).join('');
    if (raw.includes(`${marker} ${secret}`)) break;
    await delay(30);
  }
  assert.ok(raw.includes(`${marker} ${secret}`), 'Desktop observes the original synthetic output');
  await ui.invoke('ssh_request', { request: { op: 'disconnect', connection: ref, request_id: requestId() } });
  let ended;
  for (let i = 0; i < 100; i++) {
    ended = (await ui.invoke('service_list')).find(item =>
      item.connection_id === ref.connection_id && item.generation === ref.generation && item.state === 'DISCONNECTED');
    if (ended) break;
    await delay(30);
  }
  assert.ok(ended, 'The original synthetic SSH generation has ended');
  await openAgent();
  await ui.waitFor(`document.querySelector('[aria-label="Agent授权形式"] option[value="protected_export"]')?.disabled === false`);
  await ui.fill('Agent授权形式', 'protected_export');
  await ui.click('添加精确文本规则');
  await ui.fill('Agent精确文本规则1', secret);
  await ui.click('预览保护文本导出');
  const preview = `document.querySelector('[aria-label="保护文本导出预览"]')`;
  const consent = `${preview}.querySelector('input[type=checkbox]')`;
  await ui.waitFor(`!!${preview}`);
  assert.equal(await ui.evaluate(`${consent}.checked`), false);
  const visible = await ui.evaluate(`${preview}.textContent`);
  assert.ok(visible.includes(secret));
  await ui.evaluate(`${consent}.click()`);
  await ui.click('批准单次保护文本导出');
  const handoff = `document.querySelector('[aria-label="保护文本导出交接"] textarea')`;
  await ui.waitFor(`!!${handoff}`);
  const target = JSON.parse(await ui.evaluate(`${handoff}.value`));
  assert.equal(target.service_id, serviceId);
  assert.match(target.request_id, uuid);
  assert.equal(target.request_id[14], '7');
  assert.equal(target.format, 'protected_utf8');
  const source = target.retained_ended_output;
  assert.deepEqual(source.connection, ref);
  assert.equal(source.protocol, 'SSH2');
  assert.equal(source.from_cursor, 1);
  assert.ok(source.through_cursor > source.from_cursor);
  for (const field of [serviceId, `${ref.connection_id} / ${ref.generation}`, target.request_id,
    `[${source.from_cursor}, ${source.through_cursor})`]) assert.ok(visible.includes(field));
  return target;
}

export async function checkCodexExport({ call, directory, target, signed }) {
  const connection = target.retained_ended_output.connection;
  const query = { connection, request_id: target.request_id };
  const scopes = [{ target: { kind: 'connection', connection }, action: 'EXPORT' }];
  const status = (await call('agent_status')).data;
  assert.equal(status.paired_ticket, signed.data.summary.ticket_id);
  assert.deepEqual(status.approved_scopes, scopes);
  assert.deepEqual(status.protection, signed.data.protection);
  await call('terminal_read', { connection, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
  await call('input_acquire', { connection, lifetime_ms: 1000 }, 'PERMISSION_DENIED');

  const checkReceipt = receipt => {
    assert.deepEqual(Object.keys(receipt).sort(), ['data', 'result']);
    assert.equal(receipt.result, 'logs_export');
    assert.deepEqual(Object.keys(receipt.data).sort(), ['query', 'state']);
    assert.deepEqual(receipt.data.query, query);
    const state = receipt.data.state;
    if (state.phase === 'PREPARING') assert.deepEqual(state, { phase: 'PREPARING' });
    else {
      assert.equal(state.phase, 'COMPLETED');
      assert.deepEqual(Object.keys(state).sort(), ['artifact_id', 'phase']);
      assert.match(state.artifact_id, uuid);
    }
    return state;
  };
  const started = checkReceipt(await call('logs_export', target));
  let state;
  for (let i = 0; i < 20; i++) {
    state = checkReceipt(await call('logs_export_status', query));
    if (state.phase === 'COMPLETED') break;
    await delay(50);
  }
  assert.equal(state.phase, 'COMPLETED');
  if (started.artifact_id) assert.equal(state.artifact_id, started.artifact_id);
  await call('logs_export_status', { ...query, request_id: requestId() }, 'NOT_FOUND');
  const exports = path.join(directory, 'protected-output-exports', 'terminal-log-exports');
  assert.deepEqual((await readdir(exports)).sort(), [state.artifact_id, 'exports.lock']);
  const managed = path.join(exports, state.artifact_id);
  assert.deepEqual(await readdir(managed), ['export.jsonl']);
  const body = await readFile(path.join(managed, 'export.jsonl'), 'utf8');
  assert.ok(body.includes(`${marker} ${'*'.repeat(secret.length)}`), 'Managed UTF-8 text preserves the public marker and masks the literal');
  assert.ok(!body.includes(secret));
  return { query, retainedEndedOutput: target.retained_ended_output, artifactId: state.artifact_id,
    protectedText: true, wrongRequestDenied: true, readDenied: true, leaseDenied: true };
}
