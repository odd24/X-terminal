import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { delay } from './DesktopHarness.mjs';

async function until(read, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

export async function checkMcpWait({ ui, call, success, ref, other, management, grantId, control, rebind, getRpc }) {
  const tool = 'terminal_wait';
  const wait = (connection, cursor, pattern, timeout_ms = 1500) => ({ connection, cursor, pattern, timeout_ms });
  const context = async connection => (await success('terminal_read', { connection, window: null, view: { kind: 'info' } })).data.context;
  const begin = (args, timeout = 5000) => getRpc().begin('tools/call', { name: tool, arguments: args }, timeout);
  const expected = (reply, state) => {
    assert.equal(reply.isError, false, JSON.stringify(reply));
    assert.equal(reply.structuredContent.reply.result, 'wait');
    assert.equal(reply.structuredContent.reply.data.state, state, JSON.stringify(reply));
    return reply.structuredContent.reply.data;
  };
  const denied = (reply, code) => {
    assert.equal(reply.isError, true, JSON.stringify(reply));
    assert.equal(reply.structuredContent.error_code, code, JSON.stringify(reply));
  };
  const grant = async (target, literals, lifetime_ms = 120000) => {
    const id = randomUUID();
    const body = { request_id: id, lifetime_ms, scopes: [{ target, action: 'READ' }] };
    const reply = await management(literals ? {
      ...body, op: 'grant_protected', form: { kind: 'scoped' }, redaction: { sensitive_fields: false, literals },
    } : { ...body, op: 'grant' });
    await rebind(id);
    assert.equal((await success('agent_status')).data.paired_ticket, reply.data.summary.ticket_id);
    return id;
  };
  const full = connection => ({ kind: 'connection', connection });
  const append = (connection, text) => ui.invoke('fixture_append', { connection, bytes: [...Buffer.from(text)] });
  const raw = (connection, cursor) => ui.invoke('service_read', { connection, cursor });
  const noMatch = 'WAIT_LITERAL_ABSENT_6e42';
  const current = (await context(ref)).through_cursor;
  for (const changes of [{ cursor: 0 }, { pattern: '' }, { pattern: '中'.repeat(86) }, { timeout_ms: 30001 }, { window: null }]) {
    denied(await call(tool, { ...wait(ref, current, noMatch), ...changes }), 'INVALID_ARGUMENT');
  }
  denied(await call(tool, wait(other, 1, noMatch)), 'PERMISSION_DENIED');
  denied(await call(tool, wait(ref, current + 100, noMatch)), 'INVALID_ARGUMENT');

  const literal = 'WAIT.*[终]';
  const watching = begin(wait(ref, current, literal, 2500));
  await delay(80);
  const started = performance.now();
  assert.ok((await success('agent_status')).data.paired_ticket);
  const concurrentMs = performance.now() - started;
  assert.ok(concurrentMs < 1000, 'ordinary tool must not wait for terminal_wait to end');
  denied(await call(tool, wait(ref, current, noMatch)), 'INPUT_BUSY');
  await control({ op: 'push', text: 'WAIT.*' });
  await until(async () => (await context(ref)).through_cursor > current, 'first SSH fragment did not arrive');
  await control({ op: 'push', text: '[终]\r\n' });
  const matched = expected((await watching.promise).result, 'MATCHED');
  assert.equal(matched.evidence.text, literal);
  assert.ok(matched.evidence.last_cursor > matched.evidence.first_cursor);

  const idleCursor = (await context(ref)).through_cursor;
  const cancelled = begin(wait(ref, idleCursor, noMatch, 5000), 6500);
  await delay(120);
  denied(await call(tool, wait(ref, idleCursor, noMatch)), 'INPUT_BUSY');
  getRpc().cancel(cancelled.id, 'synthetic wait cancellation');
  await assert.rejects(cancelled.promise, /Cancelled by test client/);
  assert.ok((await success('agent_status')).data.paired_ticket);
  await until(async () => {
    const reply = await call(tool, wait(ref, idleCursor, noMatch, 600));
    if (reply.structuredContent.error_code === 'INPUT_BUSY') return false;
    return expected(reply, 'TIMEOUT');
  }, 'cancelled wait did not release its slot');

  const maxStart = performance.now();
  const maxWait = await begin(wait(ref, idleCursor, noMatch, 30000), 35000).promise;
  const maxMs = performance.now() - maxStart;
  assert.ok(maxMs >= 29800 && maxMs < 32000, `30 second wait measured ${maxMs} ms`);
  if (maxWait.result.isError) denied(maxWait.result, 'WAIT_READ_DEADLINE');
  else assert.equal(expected(maxWait.result, 'TIMEOUT').next_cursor, idleCursor);

  await grant(full(other));
  await append(other, 'x'.repeat(16383) + 'C');
  await append(other, 'ROSS.*[页]');
  const firstPage = await raw(other, 1);
  const edge = firstPage.events.find(event => Buffer.from(event.bytes).toString().endsWith('C')).seq;
  const crossing = expected(await call(tool, wait(other, 1, 'CROSS.*[页]')), 'MATCHED');
  assert.deepEqual(crossing.evidence, { first_cursor: edge, last_cursor: edge + 1, text: 'CROSS.*[页]' });
  const decodeCursor = (await context(other)).through_cursor;
  await append(other, Buffer.from([255]));
  const decode = expected(await call(tool, wait(other, decodeCursor, noMatch)), 'GAP');
  assert.equal(decode.evidence.reason, 'DECODE_ERROR');
  for (let index = 0; index < 5; index++) await append(other, 'z'.repeat(65536));
  const overwritten = expected(await call(tool, wait(other, 1, noMatch)), 'GAP');
  assert.equal(overwritten.evidence.reason, 'OVERWRITTEN');
  assert.ok(overwritten.next_cursor > 1);

  const secret = 'WAIT_PROTECTED_97fc';
  const publicText = 'VISIBLE.*[页]';
  const protectedId = await grant(full(ref), [secret]);
  const protectedCursor = (await context(ref)).through_cursor;
  await control({ op: 'push', text: `${publicText} ${secret} ${'x'.repeat(64)}\r\n` });
  await until(async () => (await context(ref)).through_cursor > protectedCursor, 'protected SSH output did not arrive');
  const protectedMatch = expected(await call(tool, wait(ref, protectedCursor, publicText)), 'MATCHED');
  assert.equal(protectedMatch.evidence.text, publicText);
  const hidden = await call(tool, wait(ref, protectedCursor, secret, 620));
  expected(hidden, 'TIMEOUT');
  assert.ok(!JSON.stringify(hidden).includes(secret));
  const pending = begin(wait(ref, (await context(ref)).through_cursor, noMatch, 5000));
  await delay(120);
  await management({ op: 'grant_revoke', request_id: protectedId });
  denied((await pending.promise).result, 'PERMISSION_DENIED');

  const now = Date.now();
  const window = { from_ms: now - 10000, until_ms: now + 60000 };
  const windowScope = { kind: 'output_window', connection: ref, window };
  for (const literals of [undefined, [secret]]) {
    await grant(windowScope, literals);
    await success('terminal_read', { connection: ref, window, view: { kind: 'info' } });
    denied(await call(tool, wait(ref, 1, noMatch)), 'PERMISSION_DENIED');
  }
  await grant(full(ref), undefined, 3000);
  const expires = begin(wait(ref, (await context(ref)).through_cursor, noMatch, 5000), 6500);
  denied((await expires.promise).result, 'PERMISSION_DENIED');

  await grant(full(other));
  const oldCursor = (await context(other)).through_cursor;
  const oldWait = begin(wait(other, oldCursor, noMatch, 5000));
  await delay(120);
  const replacement = await ui.invoke('fixture_lifecycle', { connection: other, action: 'reconnect' });
  denied((await oldWait.promise).result, 'PERMISSION_DENIED');
  denied(await call(tool, wait({ connection_id: replacement.connection_id, generation: replacement.generation }, 1, noMatch)), 'PERMISSION_DENIED');

  await rebind(grantId);
  const closeArgs = { connection: ref, request_id: randomUUID() };
  const endCursor = (await context(ref)).through_cursor;
  await ui.invoke('ssh_request', { request: { op: 'disconnect', ...closeArgs } });
  await until(async () => (await ui.invoke('ssh_request', { request: { op: 'disconnect_status', ...closeArgs } })).state === 'TRANSPORT_ENDED', 'synthetic SSH did not finish');
  denied(await call(tool, wait(ref, endCursor, noMatch)), 'PERMISSION_DENIED');
  await grant(full(ref));
  const disconnected = expected(await call(tool, wait(ref, endCursor, noMatch)), 'DISCONNECTED');
  const newRef = { connection_id: replacement.connection_id, generation: replacement.generation };
  await grant(full(newRef));
  const broken = begin(wait(newRef, 1, noMatch, 5000));
  await delay(120);
  process.kill((await ui.invoke('service_status')).pid);
  denied((await broken.promise).result, 'UNKNOWN_DELIVERY');
  denied(await call(tool, wait(newRef, 1, noMatch)), 'UNKNOWN_DELIVERY');
  return { result: 'PASS', actual_match: matched, cross_page: crossing, overwritten, decode, disconnected,
    concurrent_status_ms: concurrentMs, max_wait_ms: maxMs, protected_secret_not_matched: true,
    cancelled_slot_reused: true, revoked_expired_and_generation_rejected: true, window_only_rejected: true,
    service_loss_unknown_without_restart: true };
}
