import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestId } from '../../apps/desktop/src/request-id.ts';
import { delay } from './DesktopHarness.mjs';

async function until(read, reason) {
  for (let n = 0; n < 160; n++) {
    const value = await read();
    if (value) return value;
    await delay(30);
  }
  throw new Error(reason);
}

export async function checkProtectedExport({ directory, ui, call, success, ref, other, transport, management, lease, rebind, getRpc }) {
  const serviceId = (await ui.invoke('service_status')).service_id;
  const scope = [{ action: 'EXPORT', target: { kind: 'connection', connection: ref } }];
  const rules = { sensitive_fields: true, literals: ['P15_PRIVATE'] };
  const start = 'logs_export';
  const status = 'logs_export_status';
  const cancel = 'logs_export_cancel';
  const webview = request => ui.invoke('protected_export_desktop_request', { request });
  const denied = async (tool, args, expected) => {
    const result = await call(tool, args);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.error_code, expected, JSON.stringify(result));
  };
  const saveRoot = await mkdtemp(path.join(tmpdir(), 'shared-terminal-save-ui-中文-protected-'));
  const picker = target => new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-File', 'scripts/lib/NativeImportDialog.ps1',
      '-Purpose', 'ProtectedExport', '-Root', saveRoot, '-TargetProcessId', String(ui.app.pid),
      '-Action', 'select', '-TargetPath', target], { windowsHide: true });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(text)));
  });
  const complete = query => until(async () => {
    const receipt = await success(status, query);
    assert.equal(receipt.result, 'logs_export');
    assert.deepEqual(receipt.data.query, query);
    assert.deepEqual(Object.keys(receipt.data).sort(), ['query', 'state']);
    if (receipt.data.state.phase === 'PREPARING') return;
    assert.equal(receipt.data.state.phase, 'COMPLETED', JSON.stringify(receipt));
    assert.deepEqual(Object.keys(receipt.data.state).sort(), ['artifact_id', 'phase']);
    return receipt.data.state.artifact_id;
  }, 'protected export did not complete');
  const issue = async request => {
    const grantId = requestId();
    await management({ op: 'grant_protected', request_id: grantId, lifetime_ms: 120000, scopes: scope,
      form: { kind: 'single_operation', operation: { protocol: 'EXPORT', request } }, redaction: rules });
    return grantId;
  };
  try {
    await assert.rejects(webview({ op: 'prepare', service_id: serviceId, connection: ref }));
    await success('input_release', { connection: ref, lease_id: lease.lease_id });
    await ui.invoke(transport === 'SSH2' ? 'ssh_request' : 'serial_request', {
      request: { op: 'disconnect', connection: ref, request_id: requestId() },
    });
    await until(async () => (await ui.invoke('service_list')).some(item =>
      item.connection_id === ref.connection_id && item.generation === ref.generation && item.state === 'DISCONNECTED'), 'original session did not end');
    await ui.waitFor(`!document.querySelector('[aria-label="Agent授权形式"] option[value="protected_export"]')?.disabled`);
    await ui.fill('Agent授权形式', 'protected_export');
    await ui.click('添加精确文本规则');
    await ui.fill('Agent精确文本规则1', 'P15_PRIVATE');
    await ui.click('预览保护文本导出');
    const preview = '[aria-label="保护文本导出预览"]';
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(preview)})`);
    assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(preview)}).querySelector('input[type=checkbox]').checked`), false);
    await ui.evaluate(`document.querySelector(${JSON.stringify(preview)}).querySelector('input[type=checkbox]').click()`);
    await ui.click('批准单次保护文本导出');
    const handoff = '[aria-label="保护文本导出交接"]';
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(handoff)})`);
    const target = JSON.parse(await ui.evaluate(`document.querySelector(${JSON.stringify(handoff)}).querySelector('textarea').value`));
    assert.equal(target.service_id, serviceId);
    assert.deepEqual(target.retained_ended_output.connection, ref);
    const query = { connection: ref, request_id: target.request_id };
    const grantId = await ui.evaluate(`document.querySelector('[aria-label="Agent签发编号"]').value`);
    await denied(start, target, 'PERMISSION_DENIED');
    await rebind(grantId);
    await denied(start, { ...target, path: 'forbidden.txt' }, 'INVALID_ARGUMENT');
    await denied(start, { ...target, retained_ended_output: { ...target.retained_ended_output, through_cursor: target.retained_ended_output.through_cursor + 1 } }, 'PERMISSION_DENIED');
    await denied('input_acquire', { connection: ref, lifetime_ms: 1000 }, 'PERMISSION_DENIED');
    await denied('terminal_read', { connection: ref, window: null, view: { kind: 'info' } }, 'PERMISSION_DENIED');
    await denied(status, { ...query, connection: other }, 'NOT_FOUND');

    const rpc = getRpc();
    const first = rpc.begin('tools/call', { name: start, arguments: target }, 500);
    const discarded = rpc.discardedResponses;
    rpc.discardResponse(first.id);
    await assert.rejects(first.promise, /RPC timeout/);
    assert.equal(rpc.discardedResponses, discarded + 1);
    const artifact = await complete(query);
    assert.deepEqual((await success(cancel, query)).data.state, { phase: 'COMPLETED', artifact_id: artifact });

    const secondTarget = { ...target, request_id: requestId() };
    const otherGrant = await issue(secondTarget);
    await rebind(otherGrant);
    await denied(status, query, 'NOT_FOUND');
    await denied(cancel, query, 'NOT_FOUND');
    await rebind(grantId);

    const exports = path.join(directory, 'protected-output-exports', 'terminal-log-exports');
    const managed = path.join(exports, artifact, 'export.jsonl');
    const protectedText = await readFile(managed, 'utf8');
    assert.ok(protectedText.includes('MCP共享'));
    assert.ok(!protectedText.includes('P15_PRIVATE'));
    assert.deepEqual(await readdir(path.dirname(managed)), ['export.jsonl']);
    const destination = path.join(saveRoot, 'protected.txt');
    await ui.evaluate(`(() => { const input=document.querySelector(${JSON.stringify(handoff)}).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(artifact)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='另存保护文本'&&!button.disabled)`);
    await ui.click('另存保护文本');
    await picker(destination);
    await ui.waitFor(`document.querySelector('[aria-label="保护文本导出另存状态"]')?.textContent.includes('本次另存已完成')`);
    assert.equal(await readFile(destination, 'utf8'), protectedText);

    await rebind(otherGrant);
    const second = { connection: ref, request_id: secondTarget.request_id };
    await success(start, secondTarget);
    const secondArtifact = await complete(second);
    const nativeScope = { service_id: serviceId, query: second, artifact_id: secondArtifact };
    const nativeSaveId = requestId();
    await webview({ op: 'save', scope: nativeScope, save_id: nativeSaveId });
    const existing = path.join(saveRoot, 'existing.txt');
    await writeFile(existing, 'previous file');
    await picker(existing);
    const saveScope = { mode: 'PROTECTED', connection: ref, log_id: secondArtifact, request_id: second.request_id };
    const save = (op, extra = {}) => ui.invoke('export_save_request', { request: { op, scope: saveScope, save_id: nativeSaveId, ...extra } });
    const waiting = await until(async () => {
      const info = await save('status');
      return info.phase === 'AWAITING_CONFIRMATION' ? info : undefined;
    }, 'native save did not require overwrite confirmation');
    await management({ op: 'grant_revoke', request_id: otherGrant });
    await save('confirm', { confirmation: waiting.confirmation });
    const failed = await until(async () => {
      const info = await save('status');
      return info.phase === 'FAILED' ? info : undefined;
    }, 'revoked source save did not fail');
    assert.ok(['AUTHORIZATION', 'SOURCE'].includes(failed.failure));
    assert.equal(await readFile(existing, 'utf8'), 'previous file');
    assert.equal(failed.backup, null);
    assert.equal(failed.staging, null);
    await assert.rejects(webview({ op: 'save', scope: nativeScope, save_id: requestId() }));
    await until(async () => access(path.join(exports, secondArtifact)).then(() => false, () => true), 'revoked artifact was not cleaned');
    assert.equal(await readFile(destination, 'utf8'), protectedText);
    return { transport, lostStartReply: true, ownerIsolation: true, protectedBeforeDisk: true, nativeSave: true, revokedOverwrite: failed.failure, retiredArtifactRemoved: true };
  } finally {
    const resolved = path.resolve(saveRoot);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('shared-terminal-save-ui-中文-protected-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
