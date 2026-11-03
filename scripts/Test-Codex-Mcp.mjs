import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { processRpc } from './jsonrpc-client.mjs';

// Disposable app-server test context. No model turn, no sidebar chat, no delegation.
// This does not modify user MCP configuration or copy authentication material.
const home = path.resolve('.tools/codex-p06');
await mkdir(home, { recursive: true });
const binary = path.resolve('target/debug/terminal-mcp.exe');
const overrides = [
  `mcp_servers.p06_mock.command=${JSON.stringify(binary)}`,
  'mcp_servers.p06_mock.args=["--mock"]',
  'mcp_servers.p06_mock.startup_timeout_sec=10',
  'mcp_servers.p06_mock.tool_timeout_sec=5',
];
const args = ['app-server', '--stdio', ...overrides.flatMap(value => ['-c', value])];
const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const rpc = processRpc('codex', args, { env: { ...process.env, CODEX_HOME: home } });
try {
  const initialized = await rpc.request('initialize', { clientInfo: { name: 'p06_mcp_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  assert.ok(initialized.result, JSON.stringify(initialized.error));
  rpc.notify('initialized', {});
  const thread = await rpc.request('thread/start', { cwd: home, ephemeral: true, sandbox: 'read-only' }, 30000);
  assert.ok(thread.result?.thread?.id, JSON.stringify(thread.error));
  const threadId = thread.result.thread.id;
  const inventory = await rpc.request('mcpServerStatus/list', { threadId, serverName: 'p06_mock' }, 30000);
  assert.ok(inventory.result, JSON.stringify(inventory.error));
  const server = inventory.result.data.find(item => item.name === 'p06_mock');
  assert.ok(server, 'Codex did not discover mock MCP');
  const toolNames = Object.keys(server.tools).sort();
  assert.deepEqual(toolNames, ['sessions_list', 'terminal_read']);
  const list = await rpc.request('mcpServer/tool/call', { threadId, server: 'p06_mock', tool: 'sessions_list', arguments: {} });
  assert.ok(list.result, JSON.stringify(list.error));
  const listContent = list.result.structuredContent ?? JSON.parse(list.result.content.find(item => item.type === 'text').text);
  assert.equal(listContent.mock, true);
  const read = await rpc.request('mcpServer/tool/call', { threadId, server: 'p06_mock', tool: 'terminal_read', arguments: { connection_id: listContent.sessions[0].connection_id, generation: 1, cursor: 0, max_bytes: 1024 } });
  assert.ok(read.result, JSON.stringify(read.error));
  const data = read.result.structuredContent ?? JSON.parse(read.result.content.find(item => item.type === 'text').text);
  assert.match(data.text, /中文合成输出/);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/P06-codex-client.json', JSON.stringify({ result: 'PASS', codexVersion, client: 'real Codex app-server MCP client via CLI; no model turn', isolatedConfiguration: true, tools: toolNames, list: listContent, read: data, desktopClient: 'NOT_TESTED', realTerminal: 'NOT_TESTED' }, null, 2) + '\n');
  console.log('PASS: real Codex app-server discovered and called both mock MCP tools with isolated configuration; no model or real terminal involved.');
} catch (error) {
  // Only diagnostics are surfaced locally; do not copy raw app-server logs to docs.
  console.error(rpc.stderr.slice(-4000));
  throw error;
} finally {
  await rpc.close();
}
