import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requestId } from '../../apps/desktop/src/request-id.ts';
import { approveCodexExport, checkCodexExport, codexExportLiteral } from './CodexProtectedExportCheck.mjs';
import { openCodexMcpClient } from './CodexMcpClient.mjs';
import { readMcpCatalog } from './McpCatalog.mjs';
import { delay } from './DesktopHarness.mjs';

export async function checkMcpLogLocation({
  ui, data, aDir, bDir, defaults, service, manifest, connect, start, stop, durable, selectDirectory, restoreDefault, wait,
}) {
  const { tools, version } = await readMcpCatalog(manifest.mcpCatalogVersion);
  assert.equal(tools.length, 33);
  const observations = [];
  const connection = await connect('MCP 回环');
  const ref = connection.ref;
  const broker = request => ui.invoke('bridge_management_request', { request });
  const management = request => ui.invoke('agent_management_request', { request });
  const native = await broker({ op: 'info' });
  const secret = 'LOG_LOCATION_MCP_PRIVATE';
  const decoy = 'LOG_LOCATION_DISK_ONLY';
  const noPaths = result => {
    const text = JSON.stringify(result);
    for (const marker of [data, aDir, bDir].map(value => path.basename(value))
      .concat([decoy, secret, codexExportLiteral])) {
      assert.ok(!text.includes(marker), `private or disk-only value exposed: ${marker}`);
    }
  };
  let client;
  async function launch() {
    client = await openCodexMcpClient({ directory: data, info: native, broker, catalog: tools, observations });
    const bridge = await call('agent_status');
    assert.equal(bridge.data.paired_ticket, null);
    assert.equal(bridge.data.peer_pid, client.child.pid);
  }
  async function closeClient() {
    if (!client) return;
    assert.equal((await client.close()).code, 0);
    noPaths(client.stderr);
    client = undefined;
    await wait(async () => (await broker({ op: 'info' })).peer === null, 'owned stdio peer released');
  }
  async function call(name, args = {}, error) {
    const { result } = await client.request('tools/call', { name, arguments: args });
    assert.equal(result.isError, !!error, JSON.stringify(result.structuredContent));
    noPaths(result.structuredContent);
    if (error) {
      assert.deepEqual(result.structuredContent, { mock: false, error_code: error });
      return;
    }
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['mock', 'reply']);
    return result.structuredContent.reply;
  }
  async function openAgent() {
    await ui.selectTab(ref.connection_id);
    if (!await ui.evaluate('!!document.querySelector(\'[aria-label="Agent签发编号"]\')')) {
      await ui.click('Agent 授权');
    }
    await ui.waitFor('!!document.querySelector(\'[aria-label="Agent签发编号"]\')');
  }
  async function pair(grantId, signed) {
    await openAgent();
    await ui.fill('Agent签发编号', grantId);
    await ui.click('查询原Agent编号');
    await ui.waitFor('document.querySelector(\'[aria-label="Agent授权详情"]\')?.textContent.includes("ACTIVE")');
    await ui.evaluate("Array.from(document.querySelectorAll('summary')).find(x=>x.textContent==='MCP 初版连接').parentElement.open=true");
    await ui.click('刷新MCP连接状态');
    await ui.waitFor(`document.body.textContent.includes(${JSON.stringify('实际进程 PID ' + client.child.pid)})`);
    await ui.click('预览MCP绑定原授权');
    const preview = 'document.querySelector(\'[aria-label="MCP固定配对预览"]\')';
    await ui.waitFor(`!!${preview}`);
    const text = await ui.evaluate(`${preview}.textContent`);
    assert.ok(text.includes(grantId) && text.includes(String(client.child.pid)));
    const consent = 'document.querySelector(\'[aria-label="同意MCP绑定原授权"]\')';
    assert.equal(await ui.evaluate(`${consent}.checked`), false);
    await ui.evaluate(`${consent}.click()`);
    await ui.click('确认MCP绑定');
    await wait(async () => (await call('agent_status')).data.paired_ticket === signed.data.summary.ticket_id, 'paired UI approval');
  }
  const read = view => call('terminal_read', { connection: ref, window: null, view });
  const info = async () => {
    const result = await read({ kind: 'info' });
    assert.equal(result.result, 'protected_context');
    assert.deepEqual(result.data.context.connection, ref);
    return result.data.context;
  };
  async function observe(label, logFile) {
    const before = (await info()).through_cursor;
    const marker = `VISIBLE.${label}[终]`;
    const pending = call('terminal_wait', { connection: ref, cursor: before, pattern: marker, timeout_ms: 5000 });
    pending.catch(() => {});
    await connection.push(`${marker} ${secret}\r\n`);
    const waited = await pending;
    assert.equal(waited.result, 'wait');
    assert.equal(waited.data.state, 'MATCHED');
    assert.equal(waited.data.evidence.text, marker);
    assert.ok(waited.data.evidence.first_cursor >= before);
    const after = (await info()).through_cursor;
    assert.equal(waited.data.next_cursor, after);
    const result = await read({ kind: 'text', cursor: before, through_cursor: after, max_bytes: 16384 });
    assert.equal(result.result, 'protected_context');
    assert.deepEqual(result.data.page.connection, ref);
    assert.equal(result.data.page.next_cursor, after);
    assert.ok(result.data.page.events.map(event => event.text).join('').includes(marker));
    const screen = await call('terminal_screen', { connection: ref, window: null, through_cursor: after });
    assert.equal(screen.result, 'protected_context');
    const hidden = await call('terminal_wait', { connection: ref, cursor: before, pattern: secret, timeout_ms: 350 });
    assert.equal(hidden.data.state, 'TIMEOUT');
    assert.equal(hidden.data.next_cursor, after);
    await wait(async () => (await readFile(logFile, 'utf8')).includes(`${marker} ${secret}`), 'raw marker in its desktop log');
    return { before, after, match: waited.data.state, protectedLiteral: hidden.data.state };
  }
  try {
    await launch();
    await call('sessions_list', {}, 'PERMISSION_DENIED');
    const grant = requestId();
    const signed = await management({
      op: 'grant_protected', request_id: grant, lifetime_ms: 180000,
      scopes: [{ action: 'READ', target: { kind: 'connection', connection: ref } }],
      form: { kind: 'scoped' }, redaction: { sensitive_fields: false, literals: [secret, codexExportLiteral] },
    });
    await pair(grant, signed);
    assert.deepEqual((await call('sessions_list')).data.map(({ connection_id, generation }) =>
      ({ connection_id, generation })), [ref]);
    await call('terminal_read', { connection: ref, window: null, view: { kind: 'info' }, directory: aDir }, 'INVALID_ARGUMENT');
    const initial = await start(connection);
    const defaultFile = path.join(defaults, initial.readable.filename);
    const before = await observe('DEFAULT', defaultFile);
    await selectDirectory(defaults, aDir);
    const during = await observe('ONGOING', defaultFile);
    await stop(connection, initial);
    await durable(connection, initial);
    const next = await start(connection);
    const aFile = path.join(aDir, next.readable.filename);
    const after = await observe('CUSTOM', aFile);
    await selectDirectory(aDir, bDir);
    await stop(connection, next);
    await durable(connection, next);
    await rename(defaultFile, defaultFile + '.moved');
    await rename(aFile, aFile + '.moved');
    const decoyFile = path.join(bDir, path.basename(aFile));
    await writeFile(decoyFile, decoy, { flag: 'wx' });
    assert.equal((await info()).through_cursor, after.after);
    await closeClient();
    await management({ op: 'grant_revoke', request_id: grant });

    const target = await approveCodexExport({
      ui, openAgent, ref, serviceId: service.service_id,
      control: async ({ text }) => connection.push(text),
      extraLiterals: [secret],
    });
    assert.ok(target.retained_ended_output.through_cursor > after.after);
    const exportId = await ui.evaluate('document.querySelector(\'[aria-label="Agent签发编号"]\').value');
    const exportGrant = await management({ op: 'grant_status', request_id: exportId });
    await launch();
    await pair(exportId, exportGrant);
    await call('logs_export', { ...target, path: decoyFile }, 'INVALID_ARGUMENT');
    await call('logs_export', { ...target, retained_ended_output: {
      ...target.retained_ended_output, through_cursor: target.retained_ended_output.through_cursor + 1,
    } }, 'PERMISSION_DENIED');
    const result = await checkCodexExport({ call, directory: data, target, signed: exportGrant });
    const artifact = path.join(data, 'protected-output-exports', 'terminal-log-exports', result.artifactId, 'export.jsonl');
    const body = await readFile(artifact, 'utf8');
    const desktop = await ui.invoke('service_read_text', { connection: ref, cursor: 1 });
    assert.equal(desktop.source_cursor, target.retained_ended_output.through_cursor);
    const expected = desktop.events.map(event => event.text).join('')
      .replaceAll(secret, '*'.repeat(secret.length))
      .replaceAll(codexExportLiteral, '*'.repeat(codexExportLiteral.length));
    assert.equal(body, expected);
    assert.ok(!body.includes(decoy));
    await restoreDefault(bDir);
    const receipt = { query: result.query, state: { phase: 'COMPLETED', artifact_id: result.artifactId } };
    assert.deepEqual((await call('logs_export_status', result.query)).data, receipt);
    await call('logs_export_status', { ...result.query, directory: bDir }, 'INVALID_ARGUMENT');
    assert.deepEqual((await call('logs_export_cancel', result.query)).data, receipt);
    await call('logs_export_cancel', { ...result.query, path: decoyFile }, 'INVALID_ARGUMENT');
    assert.equal(await readFile(artifact, 'utf8'), body);
    assert.equal(await readFile(decoyFile, 'utf8'), decoy);
    assert.deepEqual(await readdir(bDir), [path.basename(decoyFile)]);
    await management({ op: 'grant_revoke', request_id: exportId });
    await call('logs_export_status', result.query, 'PERMISSION_DENIED');
    await closeClient();
    return { client: 'official Codex app-server / real stdio', modelTurns: 0, catalogVersion: version,
      discovered: tools.map(tool => tool.name), readWaitScreen: { before, during, after },
      export: { source: result.retainedEndedOutput, bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'), exactProtectedSnapshot: true,
        removedRecordingPathsIndependent: true, pathArgumentsRejected: true, completedCancelStable: true },
      observations };
  } finally {
    if (client) await client.close();
  }
}
