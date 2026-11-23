import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { requestId } from '../apps/desktop/src/request-id.ts';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';
import { closeSoakDesktop } from './lib/LoadSoak.mjs';

const [executable, probe, reportFile] = process.argv.slice(2).map(file => path.resolve(file));
assert.ok(executable && probe && reportFile);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'shared-terminal-log-location-中文-')));
const data = path.join(root, '应用 数据');
const aDir = path.join(root, '目录 A');
const bDir = path.join(root, '目录 B');
const goneDir = path.join(root, '稍后 不可用');
const viewer = path.join(root, '日志 查看器.exe');
const catalogue = path.join(data, 'readable-log-locations-v1.json');
const trace = path.join(root, 'program-trace.tsv');
const defaults = path.join(data, 'logs');
const checks = {};
const peers = [];
let ui;

async function wait(condition, label) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const value = await condition();
    if (value) return value;
    await delay(50);
  }
  throw Error('Timed out: ' + label);
}
function powershell(args) {
  return execFileSync('pwsh', ['-NoProfile', '-STA', ...args], { windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
}
function pick(purpose, file) {
  const result = powershell(['-File', 'scripts/lib/NativeImportDialog.ps1', '-TargetProcessId', String(ui.app.pid),
    '-Root', root, '-Purpose', purpose, '-Action', file ? 'select' : 'cancel', ...(file ? ['-TargetPath', file] : [])]);
  assert.match(result, /PASS native/);
}
const location = action => ui.invoke('log_directory_settings', { action });
const logging = request => ui.invoke('logging_request', { request });
const native = request => ui.invoke('terminal_log_request', { request });
const status = (c, l) => logging({ op: 'status', connection: c.ref, log_id: l.log_id });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pathText = label => `document.querySelector('[aria-label="${label}"]')?.textContent`;
async function settingPanel(expected) {
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click('软件设置');
  await ui.evaluate("[...document.querySelectorAll('.settings-categories button')].find(button=>button.textContent==='日志').click()");
  await ui.waitFor(`${pathText('当前日志保存位置')}===${JSON.stringify(expected)}`);
}
async function chooseDirectory(file) {
  await ui.click('选择文件夹');
  pick('LogDirectory', file);
  if (file) await ui.waitFor(`${pathText('待保存日志目录')}===${JSON.stringify(file)}`);
}
async function saveDirectory(file) {
  await chooseDirectory(file);
  await ui.click('保存日志目录');
  await ui.waitFor(`${pathText('当前日志保存位置')}===${JSON.stringify(file)}`);
}
async function connect(name) {
  const cwd = path.join(root, name);
  await mkdir(cwd);
  const peer = spawn(path.resolve('target/debug/examples/gui_ssh_fixture.exe'), [cwd], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  peers.push(peer);
  const lines = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
  async function response() {
    let timeout;
    try {
      const line = await Promise.race([lines.next(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error('Owned SSH fixture timeout')), 10000);
      })]);
      return JSON.parse(line.value);
    } finally { clearTimeout(timeout); }
  }
  const { port, pin, password } = await response();
  const ssh = request => ui.invoke('ssh_request', { request });
  const { connection } = await ssh({ op: 'quick_start', settings: { protocol: 'ssh2', host: '127.0.0.1', port,
    username: 'synthetic', auth: 'password', encoding: 'utf8' }, request_id: requestId(), cols: 80, rows: 24 });
  const ref = { connection_id: connection.connection_id, generation: connection.generation };
  const answered = new Set();
  await wait(async () => {
    const { connection, challenge } = await ssh({ op: 'status', connection: ref });
    assert.notEqual(connection.state, 'FAILED');
    if (challenge && !answered.has(challenge.id)) {
      answered.add(challenge.id);
      if (challenge.kind === 'host_key') {
        assert.equal(challenge.review.candidate.fingerprint, pin);
        await ssh({ op: 'answer_host', connection: ref, challenge_id: challenge.id, approve: true });
      } else await ssh({ op: 'authenticate', connection: ref, challenge_id: challenge.id, use_saved: false, password });
    }
    return connection.state === 'CONNECTED';
  }, name + ' authenticated');
  return { ref, push: async text => { peer.stdin.write(JSON.stringify({ op: 'push', text }) + '\n'); await response(); } };
}
const startRequest = c => ({ op: 'start', connection: c.ref, request_id: requestId(), limits: { segment_bytes: 131072, segments: 2 } });
async function start(c) {
  const { log_id } = await logging(startRequest(c));
  return wait(async () => {
    const info = await status(c, { log_id });
    assert.notEqual(info.phase, 'FAILED', info.failure ?? '');
    return info.readable && info.phase === 'RECORDING' && info;
  }, 'recording ready');
}
async function grow(c, file, text) {
  await c.push(text + '\r\n');
  const bytes = await wait(async () => {
    const data = await readFile(file);
    return data.includes(text) && data;
  }, text + ' written to ' + file);
  return bytes.length;
}
const stop = (c, l) => logging({ op: 'stop', connection: c.ref, log_id: l.log_id });
const durable = (c, l) => wait(async () => {
  const info = await status(c, l);
  return info.phase === 'STOPPED' && info.worker_finished && info.durable && info;
}, 'durable stop');
async function rows() {
  try { return (await readFile(trace, 'utf8')).trim().split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function view(file, index) {
  const observed = await wait(async () => {
    const values = await rows();
    return values[index]?.split('\t');
  }, 'native viewer launch');
  assert.equal(observed[0], '1');
  assert.equal(await realpath(observed[2]), await realpath(file));
  assert.equal((await rows()).length, index + 1);
}
async function exit(service) {
  await closeSoakDesktop(ui, data, service, {});
  await ui.close();
  ui = undefined;
}

try {
  await Promise.all([mkdir(data), mkdir(aDir), mkdir(bDir), mkdir(goneDir)]);
  await mkdir(defaults);
  const prior = path.join(defaults, '旧版日志.log');
  await writeFile(prior, 'PREVIOUS VERSION FILE\r\n', { flag: 'wx' });
  const unrelated = Array.from({ length: 72 }, (_, index) => [`现有 ${index}.log`, `independent-${index}\n`]);
  await Promise.all(unrelated.map(([name, bytes]) => writeFile(path.join(bDir, name), bytes, { flag: 'wx' })));
  await copyFile(probe, viewer);

  ui = await launchDesktop(data, { executable });
  let service = await ui.invoke('service_status');
  assert.equal(service.fixture, false);
  assert.equal((await location({ kind: 'read' })).directory, null);
  await assert.rejects(readFile(catalogue), { code: 'ENOENT' });
  await settingPanel(defaults);
  await chooseDirectory();
  assert.equal((await location({ kind: 'read' })).effective, defaults);
  await ui.fill('日志默认打开应用', 'other');
  pick('LocationViewer', viewer);
  await ui.waitFor(`${pathText('当前日志打开方式')}===${JSON.stringify(viewer)}`);
  await saveDirectory(aDir);
  await ui.click('关闭软件设置');
  const a = await connect('回环 A'), b = await connect('回环 B');
  const la = await start(a);
  const aFile = path.join(aDir, la.readable.filename);
  const aBefore = await grow(a, aFile, 'A-BEFORE-SWITCH');
  await settingPanel(aDir);
  await chooseDirectory(bDir);
  const lost = await ui.interceptIpc({ command: 'log_directory_settings', op: 'save', mode: 'error' });
  try {
    await ui.click('保存日志目录');
    await ui.waitFor("document.querySelector('.log-directory-settings [role=status]')?.textContent==='已重新读取并确认当前目录。'");
    assert.equal(await lost.count(), 1);
  } finally { await lost.restore(); }
  assert.equal((await location({ kind: 'read' })).directory, bDir);
  checks.lostSaveReply = 'one real save followed by a read';
  await ui.click('关闭软件设置');

  // Preserve the same filename and full valid header in B. An erroneous lookup
  // using the current setting would still find a plausible file.
  const decoy = path.join(bDir, la.readable.filename);
  const decoyBytes = await readFile(aFile);
  await writeFile(decoy, decoyBytes, { flag: 'wx' });
  const lb = await start(b);
  const bFile = path.join(bDir, lb.readable.filename);
  assert.notEqual(decoy, bFile);
  const bBefore = await grow(b, bFile, 'B-FIRST');
  assert.ok(await grow(a, aFile, 'A-AFTER-SWITCH') > aBefore);
  assert.ok(await grow(b, bFile, 'B-FINAL-TAIL') > bBefore);
  await grow(a, aFile, 'A-FINAL-TAIL');
  assert.deepEqual(await readFile(decoy), decoyBytes);
  const target = { service_id: service.service_id, connection: a.ref, protocol: 'SSH2' };
  const prepareId = requestId();
  await native({ op: 'prepare', target, request_id: prepareId, source: { kind: 'recorded', log_ids: [la.log_id] } });
  const prepared = await wait(async () => {
    const result = await native({ op: 'status', target, request_id: prepareId });
    assert.notEqual(result.phase, 'FAILED', result.failure ?? '');
    return result.phase === 'COMPLETED' && result;
  }, 'A live text prepared using its frozen directory');
  const exported = await readFile(path.join(data, 'terminal-menu', 'terminal-log-exports', prepareId, 'export.jsonl'));
  assert.equal(sha(exported), prepared.sha256);
  assert.ok(exported.includes('A-AFTER-SWITCH') && exported.includes('A-FINAL-TAIL'));
  checks.liveTextExport = { bytes: exported.length, sha256: sha(exported) };
  const saveRoot = await mkdtemp(path.join(tmpdir(), 'shared-terminal-save-ui-中文-'));
  const savedFile = path.join(saveRoot, '手动另存 A.log');
  const saveId = requestId();
  const scope = { mode: 'MENU', connection: a.ref, log_id: prepareId, request_id: prepareId };
  const save = op => ui.invoke('export_save_request', { request: { op, scope, save_id: saveId } });
  await save('start');
  powershell(['-File', 'scripts/lib/NativeSaveDialog.ps1', '-TargetProcessId', String(ui.app.pid),
    '-Action', 'select', '-TargetPath', savedFile]);
  await wait(async () => {
    const result = await save('status');
    assert.notEqual(result.phase, 'FAILED', result.failure ?? '');
    return result.phase === 'COMPLETED';
  }, 'manual save completed in its own directory');
  assert.deepEqual(await readFile(savedFile), exported);
  checks.manualSave = { bytes: exported.length, sha256: sha(exported) };

  await ui.selectTab(a.ref.connection_id);
  const badge = `document.querySelector('[data-connection-id="${a.ref.connection_id}"]')?.parentElement.querySelector('.tab-record-button')`;
  await ui.waitFor(`${badge}?.dataset.recording==='recording'&&${badge}.getAttribute('aria-disabled')==='false'`);
  await ui.evaluate(`${badge}.click()`);
  await durable(a, la);
  await ui.waitFor(`document.querySelector('.recording-notice-file')?.textContent===${JSON.stringify(la.readable.filename)}`);
  await ui.click('打开该日志');
  await view(aFile, 0);
  checks.stopNotice = 'viewer received the original A path despite an identical-name file in B';
  const explorer = powershell(['-Command', "ConvertTo-Json -Compress -InputObject @((New-Object -ComObject Shell.Application).Windows() | ForEach-Object {[string]$_.HWND})"]);
  await ui.click('打开日志目录');
  assert.match(powershell(['-File', 'scripts/lib/ObserveLogShell.ps1', '-Root', root, '-TargetPath', bDir,
    '-Action', 'recording-directory', '-ExistingExplorerWindows', explorer]), /PASS exact/);
  checks.openCurrent = 'Explorer displayed B';
  await stop(b, lb);
  await durable(b, lb);
  const aBytes = await readFile(aFile), bBytes = await readFile(bFile);
  assert.ok(aBytes.toString().endsWith('A-FINAL-TAIL\r\n'));
  assert.ok(bBytes.toString().endsWith('B-FINAL-TAIL\r\n'));
  assert.ok((await readdir(path.join(data, 'terminal-logs', la.log_id))).some(name => name.endsWith('.rawlog')));
  assert.ok((await readdir(path.join(data, 'terminal-audit'))).length > 0);
  assert.equal(await readFile(prior, 'utf8'), 'PREVIOUS VERSION FILE\r\n');
  const stored = JSON.parse(await readFile(catalogue, 'utf8'));
  const bound = stored.entries.find(entry => entry.log_id === la.log_id);
  assert.equal(bound.directory, aDir);
  assert.equal(bound.filename, path.basename(aFile));
  assert.ok(bound.file_identity.some(Boolean));
  checks.recordings = {
    a: { before: aBefore, finalBytes: aBytes.length, sha256: sha(aBytes) },
    b: { before: bBefore, finalBytes: bBytes.length, sha256: sha(bBytes) },
  };
  const displaced = aFile + '.original';
  await rename(aFile, displaced);
  await assert.rejects(ui.invoke('open_original_log', { connection: a.ref, protocol: 'SSH2', logId: la.log_id }));
  await copyFile(displaced, aFile);
  assert.deepEqual(await readFile(aFile), aBytes);
  await assert.rejects(ui.invoke('open_original_log', { connection: a.ref, protocol: 'SSH2', logId: la.log_id }), /SOURCE_CHANGED/);
  assert.equal((await rows()).length, 1);
  await rename(aFile, aFile + '.replacement');
  await rename(displaced, aFile);
  checks.originalIdentity = 'moved and byte-identical replacement rejected';

  await settingPanel(bDir);
  await chooseDirectory(goneDir);
  await rmdir(goneDir);
  await ui.click('保存日志目录');
  await ui.waitFor("document.querySelector('.log-directory-settings [role=alert]')?.textContent.includes('无法写入')");
  assert.equal((await location({ kind: 'read' })).directory, bDir);
  await mkdir(goneDir);
  await chooseDirectory(goneDir);
  const sid = powershell(['-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
  assert.match(sid, /^S-1-[\d-]+$/);
  const ownAcl = (...args) => execFileSync('icacls.exe', [goneDir, ...args], { windowsHide: true, timeout: 5000 });
  ownAcl('/deny', `*${sid}:(WD,AD)`);
  try {
    await ui.click('保存日志目录');
    await ui.waitFor("document.querySelector('.log-directory-settings [role=alert]')?.textContent.includes('无法写入')");
    assert.equal((await location({ kind: 'read' })).directory, bDir);
  } finally { ownAcl('/remove:d', `*${sid}`); }
  await saveDirectory(goneDir);
  await rmdir(goneDir);
  await assert.rejects(logging(startRequest(b)), /LOG_DIRECTORY_UNAVAILABLE/);
  assert.equal((await logging({ op: 'list', connection: b.ref })).logs.length, 1);
  await saveDirectory(bDir);
  checks.failedSaveAndUnavailableDirectory = 'selection removed before save and NTFS write denied both left B committed, missing saved directory rejected start';
  await ui.click('关闭软件设置');
  await exit(service);

  ui = await launchDesktop(data, { executable });
  const restarted = await ui.invoke('service_status');
  assert.notEqual(restarted.service_id, service.service_id);
  assert.equal((await location({ kind: 'read' })).directory, bDir);
  const history = await logging({ op: 'history_list' });
  assert.ok(history.logs.some(entry => entry.log_id === la.log_id && entry.info?.protocol === 'SSH2'));
  await ui.invoke('open_original_log', { connection: a.ref, protocol: 'SSH2', logId: la.log_id });
  await view(aFile, 1);
  assert.deepEqual(await readFile(aFile), aBytes);
  await settingPanel(bDir);
  await ui.click('恢复默认目录');
  await ui.waitFor(`${pathText('当前日志保存位置')}===${JSON.stringify(defaults)}`);
  assert.equal((await location({ kind: 'read' })).directory, null);
  await ui.click('关闭软件设置');
  const c = await connect('回环 默认');
  const lc = await start(c);
  await grow(c, path.join(defaults, lc.readable.filename), 'DEFAULT-AFTER-RESTART');
  await stop(c, lc);
  await durable(c, lc);
  assert.equal(await readFile(prior, 'utf8'), 'PREVIOUS VERSION FILE\r\n');
  assert.ok((await readdir(bDir)).length > 64);
  for (const [name, bytes] of unrelated) assert.equal(await readFile(path.join(bDir, name), 'utf8'), bytes);
  checks.restart = 'new service, saved path B, identity-bound old file A, restored default used for next recording';
  checks.unrelated = unrelated.length;
  await exit(restarted);
  await writeFile(reportFile, JSON.stringify({ result: 'PASS', executable, root, checks, hardware: 'loopback SSH only' }, null, 2));
  console.log('PASS Windows native chooser, active A/B recording, frozen text export, stop notice and Explorer, replacement refusal, lost reply, restart and default restoration');
} catch (error) {
  await writeFile(reportFile, JSON.stringify({ result: 'FAIL', executable, root, checks, error: String(error.stack ?? error) }, null, 2));
  throw error;
} finally {
  if (ui) await ui.close();
  for (const peer of peers) if (peer.exitCode === null && peer.signalCode === null) peer.kill();
}
