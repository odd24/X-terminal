import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';

const ordinary = process.argv.includes('--ordinary');
const publicationFaults = process.argv.includes('--publication-faults');
const only = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const publishModes = ['publish-failure','publish-cleanup-failure'];
const executable = path.resolve(ordinary ? 'target/debug/shared-terminal-desktop.exe' : 'target/save-recovery-fixture/shared-terminal-desktop.exe');
const prefix = 'shared-terminal-save-ui-中文-recovery-';
const namespace = 'desktop-save-recovery-v1';
const original = Buffer.from('synthetic original\r\n');
const foreign = Buffer.from('synthetic outside occupant\r\n');
const results = [];
const run = promisify(execFile);
const exists = file => access(file).then(() => true, error => {
  if (error.code !== 'ENOENT') throw error;
  return false;
});
async function until(probe, description) {
  for (let i = 0; i < 160; i++) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function fileIdentity(file) {
  const info = await stat(file, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}
const index = id => String((BigInt(id[1]) << 32n) | BigInt(id[2]));
const assertIdentity = async (file, expected) => assert.deepEqual(await fileIdentity(file), expected);
const assertBytes = async (file, bytes) => assert.deepEqual(await readFile(file), bytes);
const assertAbsent = async file => assert.equal(await exists(file), false, path.basename(file));
const waitStatus = (ui, task, phase) => until(async () => {
  const value = await save(ui, { op: 'status', ...task });
  return value.phase === phase ? value : undefined;
}, phase);
const save = (ui, request) => ui.invoke('export_save_request', { request });

async function exportSource(ui) {
  const request = request => ui.invoke('logging_request', { request });
  const created = await ui.invoke('fixture_create');
  const connection = { connection_id: created.connection_id, generation: created.generation };
  const log = await request({ op: 'start', connection, request_id: crypto.randomUUID(), limits: { segment_bytes: 131072, segments: 2 } });
  await ui.invoke('fixture_append', { connection, bytes: [...Buffer.from('synthetic source 中文\r\n')] });
  await request({ op: 'stop', connection, log_id: log.log_id });
  await until(async () => (await request({ op: 'status', connection, log_id: log.log_id })).worker_finished, 'capture stopped');
  await ui.click('终端日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="历史日志工具"]')`);
  await ui.evaluate(`document.querySelector('[aria-label="历史日志工具"]').open=true`);
  await ui.click('刷新历史目录');
  await ui.waitFor(`!document.querySelector('[aria-label="历史日志选择"]').disabled`);
  await ui.fill('历史日志选择', log.log_id);
  await ui.click('导出选中日志');
  await ui.waitFor(`!!document.querySelector('[aria-label="日志导出文件路径"]')`);
  const source = await ui.evaluate(`document.querySelector('[aria-label="日志导出文件路径"]').value`);
  return { source, bytes: await readFile(source), object: await fileIdentity(source) };
}

async function select(ui, root, target) {
  await ui.waitFor(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='另存导出文件'&&!button.disabled)`);
  await ui.click('另存导出文件');
  const { stdout } = await run('pwsh', ['-NoProfile', '-File', 'scripts/lib/NativeImportDialog.ps1',
    '-Purpose', 'SaveRecovery', '-Root', root, '-TargetProcessId', String(ui.app.pid), '-Action', 'select', '-TargetPath', target],
    { windowsHide: true });
  assert.match(stdout, /PASS native SaveRecovery picker/);
  return JSON.parse(await ui.evaluate(`sessionStorage.getItem('terminal-export-save-v1')`));
}
async function confirm(ui, task) {
  const before = await waitStatus(ui, task, 'AWAITING_CONFIRMATION');
  await ui.waitFor(`!!document.querySelector('[aria-label="确认替换保存文件"]')`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="确认替换保存文件"]').checked`), false);
  await ui.evaluate(`document.querySelector('[aria-label="确认替换保存文件"]').click()`);
  await ui.click('确认替换并保存');
  return before.confirmation;
}

async function closeOrdinary(ui) {
  await ui.evaluate(`(()=>{const d=document.querySelector('details.tools-menu');if(!d.open)d.querySelector('summary').click();return true;})()`);
  await ui.evaluate(`setTimeout(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出桌面').click(),50);true`);
  await until(() => ui.app.exitCode !== null, 'Desktop exit');
  assert.equal(ui.app.exitCode, 0);
  await ui.close();
}

async function verifySyncFailure(ui, { root, output, target, originalId, exported, task, confirmation, intent, done }) {
  const report = await waitStatus(ui, task, 'FAILED');
  assert.equal(report.failure, 'SYNC');
  assert.equal(report.os_code, 29);
  for (const field of ['confirmation', 'backup', 'staging', 'expires_at_ms']) assert.equal(report[field], null);
  assert.equal(report.diagnostic_issue, undefined);
  await ui.waitFor(`document.querySelector('[aria-label="导出另存状态"]')?.textContent.includes('无法确认文件已同步（系统代码 29）')`);
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="确认替换保存文件"]')`), false);
  assert.deepEqual(await save(ui, { op: 'confirm', ...task, confirmation }), report);
  await assertIdentity(target, originalId);
  await assertBytes(target, original);
  assert.deepEqual(await readdir(output), [path.basename(target)]);
  await assertAbsent(intent);
  await assertAbsent(done);
  await assertIdentity(exported.source, exported.object);
  await assertBytes(exported.source, exported.bytes);

  const retry = await select(ui, root, target);
  assert.notEqual(retry.save_id, task.save_id);
  assert.deepEqual(retry.scope, task.scope);
  assert.notEqual(await confirm(ui, retry), confirmation);
  const completed = await waitStatus(ui, retry, 'COMPLETED');
  assert.equal(completed.failure, null);
  const retryBackup = path.join(output, `.terminal-export-${retry.save_id}.backup`);
  assert.equal(await realpath(completed.backup), await realpath(retryBackup));
  assert.deepEqual((await readdir(output)).sort(), [path.basename(retryBackup), path.basename(target)].sort());
  await assertBytes(target, exported.bytes);
  await assertIdentity(retryBackup, originalId);
  await assertBytes(retryBackup, original);
  await assertIdentity(exported.source, exported.object);
  await assertBytes(exported.source, exported.bytes);
  assert.deepEqual(await save(ui, { op: 'status', ...task }), report);
  return { failedSave: task.save_id, retrySave: retry.save_id, failure: report.failure, osCode: report.os_code, retryBackup };
}

for (const mode of only ? [only] : ordinary ? ['gate-failure','completed'] : publicationFaults ? publishModes
  : ['intent','backup','published','terminal-failure','sync-failure',...publishModes]) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const data = path.join(root, '应用数据');
  const store = path.join(data, namespace);
  const output = path.join(root, '输出');
  const target = path.join(output, '原目标.jsonl');
  const unknown = path.join(store, 'foreign.txt');
  await mkdir(data);
  await mkdir(output);
  await writeFile(target, original);
  const originalId = await fileIdentity(target);
  let ui;
  let failed = false;
  try {
    if (mode === 'gate-failure') {
      for (const faultMode of publicationFaults ? publishModes : ['sync-failure']) {
        const refused = spawnSync(executable, ['--save-recovery-fixture', faultMode], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        assert.ok(!refused.error);assert.notEqual(refused.status, 0);assert.match(refused.stderr, /SAVE_RECOVERY_FIXTURE_DISABLED/);
      }
      await mkdir(store);
      await writeFile(path.join(store, 'store.lock'), '');
      await writeFile(unknown, foreign);
    }
    ui = await launchDesktop(data, { executable, fixture: true, extraArgs: ordinary ? [] : ['--save-recovery-fixture', mode] });
    const exported = await exportSource(ui);
    const task = await select(ui, root, target);
    const backup = path.join(output, `.terminal-export-${task.save_id}.backup`);
    const stage = path.join(output, `.terminal-export-${task.save_id}.partial`);
    const intent = path.join(store, `${task.save_id}.json`);
    const done = path.join(store, `${task.save_id}.done`);
    const confirmation = await confirm(ui, task);
    if (publishModes.includes(mode)) {
      const keepStage = mode === 'publish-cleanup-failure';
      const expectedPhase = keepStage ? 'PRESERVE' : 'NOT_PUBLISHED';
      const report = await waitStatus(ui, task, 'FAILED');
      assert.equal(report.failure, 'PUBLISH');
      assert.equal(report.os_code, 29);
      assert.equal(report.diagnostic_issue, undefined);
      for (const field of ['confirmation', 'backup', 'expires_at_ms']) assert.equal(report[field], null);
      await ui.waitFor(`document.querySelector('[aria-label="导出另存状态"]')?.textContent.includes('目标名称发生冲突或发布失败（系统代码 29）')`);
      assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="确认替换保存文件"]')`), false);
      assert.deepEqual(await save(ui, { op: 'confirm', ...task, confirmation }), report);
      assert.deepEqual(await save(ui, { op: 'start', ...task }), report);
      await assertIdentity(target, originalId);
      await assertBytes(target, original);
      await assertAbsent(backup);
      const record = JSON.parse(await readFile(intent,'utf8'));
      assert.equal(record.save_id, task.save_id);
      assert.equal(index(record.original), originalId.ino);
      assert.equal(JSON.parse(await readFile(done,'utf8')).phase, expectedPhase);
      let stageId = null;
      if (keepStage) {
        assert.equal(await realpath(report.staging), await realpath(stage));
        stageId = await fileIdentity(stage);
        assert.equal(index(record.staging), stageId.ino);
        assert.equal((await stat(stage)).mode & 0o200, 0);
        await assertBytes(stage, exported.bytes);
        await ui.waitFor(`!![...document.querySelectorAll('label')].find(label=>label.textContent==='未发布暂存文件'&&label.querySelector('input[readonly]'))`);
      } else {
        assert.equal(report.staging, null);
        await assertAbsent(stage);
      }
      await assertIdentity(exported.source, exported.object);
      await assertBytes(exported.source, exported.bytes);
      await ui.screenshot(`P24-save-recovery-${mode}.png`);

      const retry = await select(ui, root, target);
      assert.notEqual(retry.save_id, task.save_id);
      assert.deepEqual(retry.scope, task.scope);
      assert.equal((await waitStatus(ui, retry, 'AWAITING_CONFIRMATION')).failure, null);
      await assertIdentity(target, originalId);
      await assertBytes(target, original);
      assert.notEqual(await confirm(ui, retry), confirmation);
      const completed = await waitStatus(ui, retry, 'COMPLETED');
      const retryBackup = path.join(output, `.terminal-export-${retry.save_id}.backup`);
      assert.equal(await realpath(completed.backup), await realpath(retryBackup));
      assert.deepEqual((await readdir(output)).sort(), [path.basename(target),path.basename(retryBackup),...(keepStage?[path.basename(stage)]:[])].sort());
      await assertIdentity(retryBackup, originalId);
      await assertBytes(retryBackup, original);
      await assertBytes(target, exported.bytes);
      const publishedId = await fileIdentity(target);
      assert.notDeepEqual(publishedId, originalId);
      assert.deepEqual(await save(ui,{op:'status',...task}), report);
      await closeOrdinary(ui);ui = undefined;

      ui = await launchDesktop(data, { executable, webviewDirectory: path.join(data, 'webview-restart') });
      assert.equal((await ui.invoke('service_status')).fixture, false);
      for (const request of [{ op: 'status', ...task }, { op: 'confirm', ...task, confirmation }]) {
        assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('export_save_request',${JSON.stringify({request})}).then(()=>null,error=>String(error))`), 'NOT_FOUND');
      }
      const view = await ui.invoke('save_recovery_status');
      assert.equal(view.availability, null);
      assert.deepEqual(Object.fromEntries(view.items.map(item=>[item.save_id,item.phase])),{[task.save_id]:expectedPhase,[retry.save_id]:'PUBLISHED'});
      await assertIdentity(target, publishedId);
      await assertBytes(target, exported.bytes);
      await assertIdentity(retryBackup, originalId);
      await assertBytes(retryBackup, original);
      await assertIdentity(exported.source, exported.object);
      await assertBytes(exported.source, exported.bytes);
      if (keepStage) {
        await assertIdentity(stage, stageId);
        assert.equal((await stat(stage)).mode & 0o200, 0);
        await assertBytes(stage, exported.bytes);
      }
      await closeOrdinary(ui);ui = undefined;
      if (keepStage) await chmod(stage, 0o666); // Only our owned read-only fixture object, after all verification.
      results.push({mode,result:'PASS',failedSave:task.save_id,retrySave:retry.save_id,originalId,publishedId,stageId,
        failure:report.failure,osCode:report.os_code,diagnostic:expectedPhase,oldConfirmationAfterRestart:'NOT_FOUND'});
      console.log(`PASS P24 save recovery ${mode}`);
      continue;
    }
    if (mode === 'sync-failure') {
      const { retryBackup, ...evidence } = await verifySyncFailure(ui, {
        root, output, target, originalId, exported, task, confirmation, intent, done,
      });
      const targetAfter = await fileIdentity(target);
      await closeOrdinary(ui);ui = undefined;
      ui = await launchDesktop(data, { executable, webviewDirectory: path.join(data, 'webview-restart') });
      assert.equal((await ui.invoke('service_status')).fixture, false);
      for (const request of [{ op: 'status', ...task }, { op: 'confirm', ...task, confirmation }]) {
        assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('export_save_request',${JSON.stringify({request})}).then(()=>null,error=>String(error))`), 'NOT_FOUND');
      }
      const view = await ui.invoke('save_recovery_status');
      assert.equal(view.availability, null);
      assert.deepEqual(view.items.map(item => [item.save_id, item.phase]), [[evidence.retrySave, 'PUBLISHED']]);
      await assertIdentity(target, targetAfter);await assertBytes(target, exported.bytes);
      await assertIdentity(retryBackup, originalId);await assertBytes(retryBackup, original);
      await assertIdentity(exported.source, exported.object);await assertBytes(exported.source, exported.bytes);
      await closeOrdinary(ui);ui = undefined;
      results.push({ mode, result: 'PASS', originalId, targetAfter, ...evidence, oldConfirmationAfterRestart: 'NOT_FOUND' });
      console.log(`PASS P24 save recovery ${mode}`);
      continue;
    }
    if (mode === 'gate-failure') {
      const report = await waitStatus(ui, task, 'FAILED');
      assert.equal(report.failure, 'RECOVERY_RECORD');assert.equal(report.diagnostic_issue, 'UNTRUSTED');
      await assertIdentity(target, originalId);await assertBytes(target, original);
      await assertAbsent(stage);await assertAbsent(backup);await assertAbsent(intent);
      const fresh = path.join(output, '新文件.jsonl');
      const freshTask = await select(ui, root, fresh);
      const freshReport = await waitStatus(ui, freshTask, 'COMPLETED');
      assert.equal(freshReport.diagnostic_issue, undefined);
      await assertBytes(fresh, exported.bytes);
      assert.deepEqual((await readdir(store)).sort(), ['foreign.txt', 'store.lock']);
      await assertBytes(unknown, foreign);
      await assertIdentity(exported.source, exported.object);
      await ui.close();ui = undefined;
      results.push({ mode, result: 'PASS', originalId, blocked: report.failure, newFileCompleted: true });
      continue;
    }
    if (mode === 'completed') {
      const report = await waitStatus(ui, task, 'COMPLETED');
      assert.equal(report.diagnostic_issue, undefined);
    } else {
      await until(() => exists(path.join(data, 'save-test-reached')), 'actual save checkpoint');
    }
    const encoded = await readFile(intent);
    const saved = JSON.parse(encoded);
    assert.equal(saved.save_id, task.save_id);
    assert.deepEqual(Object.keys(saved).sort(), ['at_ms', 'name', 'original', 'parent', 'save_id', 'staging', 'version']);
    assert.equal(saved.name, path.basename(target));
    assert.equal(index(saved.original), originalId.ino);
    assert.equal(index(saved.parent), (await fileIdentity(output)).ino);
    assert.ok(!encoded.includes(Buffer.from(root)) && !encoded.includes(Buffer.from(confirmation)));
    const completedRecord = mode === 'completed' ? await readFile(done) : undefined;
    if (!completedRecord) await assertAbsent(done);
    const crashedPid = ui.app.pid;
    if (mode === 'completed') {
      await closeOrdinary(ui);ui = undefined;
    } else if (mode === 'terminal-failure') {
      await writeFile(unknown, foreign, { flag: 'wx' });
      await writeFile(path.join(data, 'save-test-release'), '', { flag: 'wx' });
      const report = await waitStatus(ui, task, 'COMPLETED');
      assert.equal(report.failure, null);assert.equal(report.diagnostic_issue, 'UNTRUSTED');
      await ui.waitFor(`document.querySelector('[aria-label="导出另存状态"]')?.textContent.includes('另存保全记录未确认')`);
      await closeOrdinary(ui);ui = undefined;
    } else {
      assert.equal(ui.app.kill(), true);
      await ui.close();
      assert.notEqual(ui.app.exitCode, 0);
      ui = undefined;
    }
    if (mode === 'intent') {
      await assertIdentity(target, originalId);await assertBytes(target, original);await assertAbsent(backup);
    } else {
      await assertIdentity(backup, originalId);await assertBytes(backup, original);
    }
    if (mode === 'backup') {
      await assertAbsent(target);
      await writeFile(target, foreign, { flag: 'wx' });
    }
    const staged = mode === 'intent' || mode === 'backup';
    if (staged) {
      await assertBytes(stage, exported.bytes);assert.equal((await fileIdentity(stage)).ino, index(saved.staging));
    } else {
      await assertAbsent(stage);await assertBytes(target, exported.bytes);assert.equal((await fileIdentity(target)).ino, index(saved.staging));
    }
    const targetAfter = await fileIdentity(target);
    ui = await launchDesktop(data, { executable, webviewDirectory: path.join(data, 'webview-restart') });
    assert.equal((await ui.invoke('service_status')).fixture, false);
    assert.deepEqual(await ui.invoke('service_list'), []);
    for (const request of [{ op: 'status', ...task }, { op: 'confirm', ...task, confirmation }]) {
      assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('export_save_request',${JSON.stringify({request})}).then(()=>null,error=>String(error))`), 'NOT_FOUND');
    }
    const view = await ui.invoke('save_recovery_status');
    if (mode === 'terminal-failure') {
      assert.deepEqual(view, { availability: 'UNTRUSTED', items: [] });
      await assertBytes(unknown, foreign);
    } else if (completedRecord) {
      const record = JSON.parse(completedRecord);
      assert.equal(record.save_id, task.save_id);
      assert.equal(record.phase, 'PUBLISHED');
      assert.deepEqual(view, { availability: null, items: [{ save_id: task.save_id, name: path.basename(target), at_ms: record.at_ms, phase: 'PUBLISHED' }] });
    } else {
      assert.deepEqual(view, { availability: null, items: [{ save_id: task.save_id, name: path.basename(target), at_ms: saved.at_ms, phase: 'UNKNOWN' }] });
    }
    if (completedRecord) {
      assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="另存保全提示"]')`), false);
      await ui.evaluate(`(()=>{const d=document.querySelector('details.tools-menu');if(!d.open)d.querySelector('summary').click();return true;})()`);
      await ui.click('另存保全信息');
    } else {
      await ui.waitFor(`!!document.querySelector('[aria-label="另存保全提示"]')`);
      await ui.click('查看另存保全信息');
    }
    await ui.waitFor(`!!document.querySelector('dialog[aria-label="另存保全信息"]')`);
    assert.ok(await ui.evaluate(`document.querySelector('dialog[aria-label="另存保全信息"]').textContent.includes('未知')`));
    await ui.click('关闭另存保全信息');
    await assertIdentity(target, targetAfter);
    await assertBytes(target, mode === 'intent' ? original : mode === 'backup' ? foreign : exported.bytes);
    if (staged) await assertBytes(stage, exported.bytes);
    if (mode !== 'intent') { await assertIdentity(backup, originalId);await assertBytes(backup, original); }
    await assertIdentity(exported.source, exported.object);await assertBytes(exported.source, exported.bytes);
    await assertBytes(intent, encoded);
    if (completedRecord) await assertBytes(done, completedRecord);
    else await assertAbsent(done);
    const restartPid = ui.app.pid;
    await closeOrdinary(ui);ui = undefined;
    results.push({ mode, result: 'PASS', crashedPid, restartPid, originalId, targetAfter, saved, view });
  } catch (error) {
    failed = true;
    console.error('P24 owned failed root retained:', root);
    if (ui) await ui.screenshot(`P24-save-recovery-${mode}-failure.png`).catch(()=>{});
    throw error;
  } finally {
    await ui?.close();
    if (!failed) {
      const absolute = await realpath(root);
      assert.equal(path.dirname(absolute), await realpath(tmpdir()));
      assert.ok(path.basename(absolute).startsWith(prefix));
      await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
  console.log(`PASS P24 save recovery ${mode}`);
}
const category = publicationFaults ? (ordinary ? 'publish-ordinary' : 'publish-fixture') : ordinary ? 'ordinary' : 'fixture';
await writeFile(`artifacts/P24-save-recovery-${only ?? category}.json`, JSON.stringify({ result: 'PASS', results }, null, 2)+'\n');
