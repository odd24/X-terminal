import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { processRpc } from './jsonrpc-client.mjs';

const binary = path.resolve('target/debug/terminal-mcp.exe');
async function initialize(rpc) {
  const response = await rpc.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p06-contract-test', version: '0.1.0' } });
  assert.ok(response.result?.capabilities.tools);
  rpc.notify('notifications/initialized', {});
  return response.result.protocolVersion;
}

const rpc = processRpc(binary, ['--mock']);
let version;
try {
  version = await initialize(rpc);
  const tools = await rpc.request('tools/list', {});
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), ['sessions_list', 'terminal_read']);
  assert.ok(tools.result.tools.every(tool => tool.annotations.readOnlyHint));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/P06-tool-catalog.json', JSON.stringify(tools.result, null, 2) + '\n');
  const list = await rpc.request('tools/call', { name: 'sessions_list', arguments: {} });
  const session = list.result.structuredContent.sessions[0];
  assert.equal(session.protocol, 'MOCK');
  const args = { connection_id: session.connection_id, generation: 1, cursor: 0, max_bytes: 4 };
  let cursor = 0;
  let output = '';
  for (let count = 0; count < 100; count++) {
    const read = await rpc.request('tools/call', { name: 'terminal_read', arguments: { ...args, cursor } });
    const data = read.result.structuredContent;
    assert.equal(read.result.isError, false);
    assert.ok(Buffer.byteLength(data.text, 'utf8') <= 4);
    if (data.next_cursor === cursor) break;
    output += data.text;
    cursor = data.next_cursor;
  }
  assert.match(output, /中文合成输出/);
  assert.ok(!output.includes('�'));
  for (const [change, code] of [[{ generation: 2 }, 'STALE_GENERATION'], [{ connection_id: 'not-authorized' }, 'PERMISSION_DENIED'], [{ max_bytes: 0 }, 'INVALID_ARGUMENT'], [{ unexpected: true }, 'INVALID_ARGUMENT']]) {
    const response = await rpc.request('tools/call', { name: 'terminal_read', arguments: { ...args, ...change } });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error_code, code);
  }
  assert.ok(rpc.stderr.includes('MOCK ONLY'));
  rpc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'tools/call', params: { name: 'terminal_read', arguments: { oversized: 'x'.repeat(129 * 1024) } } }) + '\n');
  assert.ok((await rpc.request('ping', {})).result, 'oversized frame must not poison subsequent protocol frames');
} finally {
  assert.equal((await rpc.close()).code, 0);
}

const slow = processRpc(binary, ['--mock', '--mock-delay-ms', '2000']);
try {
  await initialize(slow);
  const busyCalls = Array.from({ length: 5 }, () => slow.begin('tools/call', { name: 'terminal_read', arguments: { connection_id: 'mock-p06-connection', generation: 1, cursor: 0, max_bytes: 64 } }));
  const first = await Promise.race(busyCalls.map(call => call.promise));
  assert.equal(first.result.structuredContent.error_code, 'INPUT_BUSY');
  const settled = Promise.allSettled(busyCalls.map(call => call.promise));
  for (const call of busyCalls) slow.cancel(call.id, 'bounded concurrency test');
  await settled;
  const afterCancel = await slow.request('tools/call', { name: 'terminal_read', arguments: { connection_id: 'mock-p06-connection', generation: 1, cursor: 0, max_bytes: 64 } }, 3000);
  assert.equal(afterCancel.result.isError, false, 'cancellation must release tool capacity');
  const request = slow.begin('tools/call', { name: 'terminal_read', arguments: { connection_id: 'mock-p06-connection', generation: 1, cursor: 0, max_bytes: 64 } }, 100);
  await assert.rejects(request.promise, /timeout/);
  slow.cancel(request.id, 'contract-test timeout');
  const start = performance.now();
  const ping = await slow.request('ping', {}, 1000);
  assert.ok(ping.result);
  assert.ok(performance.now() - start < 1000);
} finally {
  assert.equal((await slow.close()).code, 0);
}

await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/P06-mcp-contract.json', JSON.stringify({ result: 'PASS', protocolVersion: version, tools: ['sessions_list', 'terminal_read'], scope: 'read-only mock; no real device', checks: ['initialize', 'tool discovery', 'bounded UTF-8 cursor reads', 'generation', 'connection visibility', 'argument rejection', 'oversized frame resynchronization', 'bounded tool concurrency', 'client timeout and cancellation', 'responsive ping', 'stderr separation', 'EOF exit'] }, null, 2) + '\n');
console.log('PASS: MCP stdio mock contract, bounded reads, negative cases, timeout/cancel, stderr separation and EOF cleanup.');
