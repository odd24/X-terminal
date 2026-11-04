import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-logging-ui-'));
let ui;
const ref = connection => ({ connection_id: connection.connection_id, generation: connection.generation });
try {
  ui = await launchDesktop(directory, { fixture: true });
  await ui.click('新建合成会话');
  await ui.waitFor(`document.querySelector('.status').textContent==='服务输出已同步'`);
  const [connection] = await ui.invoke('service_list');
  const target = ref(connection);
  await ui.waitFor(`window.__TAURI_INTERNALS__.invoke('service_read',{connection:${JSON.stringify(target)},cursor:1}).then(page=>new TextDecoder().decode(new Uint8Array(page.events.flatMap(event=>event.bytes))).includes('中文宽字'))`);
  const request = value => ui.invoke('logging_request', { request: value });
  const list = async () => (await request({ op: 'list', connection: target })).logs;
  const status = id => request({ op: 'status', connection: target, log_id: id });
  const waitStatus = async (id, predicate) => {
    for (let attempt = 0; attempt < 300; attempt++) { const value = await status(id); if (predicate(value)) return value; await delay(20); }
    throw new Error('synthetic log status did not settle');
  };
  assert.deepEqual(await list(), []);
  await ui.click('终端日志');
  await ui.waitFor(`document.querySelector('[aria-label="终端日志面板"]')?.textContent.includes(${JSON.stringify(connection.connection_id)})`);
  await ui.evaluate(`document.querySelector('[aria-label="终端日志面板"] details').open=true`);
  await ui.fill('日志每段MiB', 0.125);await ui.fill('日志保留段数', 2);
  await ui.click('开始记录终端');
  await ui.waitFor(`document.querySelector('[aria-label="日志详情"]')?.textContent.includes('正在记录')`);
  let [first] = await list();
  assert.equal(first.source_cursor, 2, 'initial demo history is outside the capture window');
  assert.equal(first.active, true);
  const before = Buffer.from('captured-before-reload\r\n');
  await ui.invoke('fixture_append', { connection: target, bytes: [...before] });
  await waitStatus(first.log_id, value => value.written_records === 1);
  await ui.click('关闭日志面板');
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="终端日志面板"]')`), false);
  await ui.invoke('fixture_append', { connection: target, bytes: [...Buffer.from('panel-closed\r\n')] });
  await waitStatus(first.log_id, value => value.written_records === 2);
  const pid = (await ui.invoke('service_status')).pid;
  await ui.command('Page.reload');
  await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ') && document.querySelector('[aria-label="日志状态"]')?.textContent.includes('正在记录')`);
  assert.equal((await ui.invoke('service_status')).pid, pid);
  assert.equal((await list())[0].log_id, first.log_id);
  await ui.invoke('fixture_append', { connection: target, bytes: [...Buffer.from('after-reload\r\n')] });
  await waitStatus(first.log_id, value => value.written_records === 3);
  for (let index = 0; index < 70; index++) {
    await ui.invoke('fixture_append', { connection: target, bytes: Array(4096).fill(65 + index % 26) });
    await waitStatus(first.log_id, value => value.written_records === index + 4);
  }
  await ui.click('终端日志');
  await ui.waitFor(`document.querySelector('[aria-label="日志详情"]')?.textContent.includes(${JSON.stringify(first.log_id)})`);
  await ui.click('停止记录终端');
  first = await waitStatus(first.log_id, value => value.worker_finished);
  assert.equal(first.durable, true);assert.equal(first.active, false);assert.equal(first.natural_end, false);
  assert.equal(first.source_gap_bytes,0);assert.equal(first.rejected_records,0);
  assert.ok(first.retired_segments > 0);assert.equal(first.last_segment - first.first_retained_segment + 1, 2);
  const logDirectory = path.join(directory, 'terminal-logs', first.log_id);
  assert.equal((await readdir(logDirectory)).length, 5);
  let previous = null;
  for (let segment = first.first_retained_segment; segment <= first.last_segment; segment++) {
    const base = String(segment).padStart(16, '0');
    const raw = await readFile(path.join(logDirectory, base + '.rawlog'));
    const text = await readFile(path.join(logDirectory, base + '.text.jsonl'));
    assert.ok(raw.length + text.length <= first.limits.segment_bytes);
    assert.equal(raw.subarray(0, 8).toString(), 'STRAW001');
    const headerSize = raw.readUInt32LE(8);const header = JSON.parse(raw.subarray(12, 12 + headerSize));
    assert.deepEqual(header.metadata.connection, target);
    const lines = text.toString().trimEnd().split('\n').map(line => JSON.parse(line));
    let offset = 12 + headerSize;let line = 1;
    while (offset < raw.length) {
      const length = raw.readUInt32LE(offset);const frame = raw.subarray(offset + 4, offset + 4 + length);
      assert.equal(frame.length, length);assert.equal(frame[0], 1);
      const seq = Number(frame.readBigUInt64LE(1));const source = Number(frame.readBigUInt64LE(9));
      if (previous !== null) assert.equal(seq, previous + 1);
      previous = seq;assert.equal(lines[line].event.seq, seq);assert.equal(lines[line].event.source_seq, source);
      assert.deepEqual(frame.subarray(33), Buffer.alloc(4096, 65 + (source - 5) % 26));
      offset += 4 + length;line++;
    }
    assert.equal(line, lines.length);
  }
  assert.equal(previous, 74);
  const completed = JSON.parse(await readFile(path.join(logDirectory, 'completion.json')));
  assert.equal(completed.written_records, 73);
  const info = await request({ op: 'start', connection: target, request_id: crypto.randomUUID(), limits: { segment_bytes: 131072, segments: 2 } });
  assert.notEqual(info.log_id, first.log_id);
  await request({ op: 'stop', connection: target, log_id: first.log_id });
  assert.equal((await status(info.log_id)).active, true, 'stopping an old log cannot detach the new capture');
  await ui.invoke('fixture_append', { connection: target, bytes: [...Buffer.from('fault-fixture')] });
  await waitStatus(info.log_id, value => value.written_records === 1);
  await writeFile(path.join(directory, 'terminal-logs', info.log_id, 'completion.partial'), 'synthetic-collision');
  await ui.waitFor(`Array.from(document.querySelector('[aria-label="日志记录"]').options).some(option=>option.value===${JSON.stringify(info.log_id)})`);
  await ui.fill('日志记录', info.log_id);await ui.waitFor(`document.querySelector('[aria-label="日志详情"]')?.textContent.includes(${JSON.stringify(info.log_id)})`);await ui.click('停止记录终端');
  const failed = await waitStatus(info.log_id, value => value.worker_finished);
  assert.equal(failed.phase, 'FAILED');assert.equal(failed.failure, 'STORAGE');assert.equal(failed.durable, false);
  await ui.waitFor(`document.querySelector('[aria-label="日志状态"]')?.textContent.includes('文件存储故障')`);
  await ui.invoke('fixture_append', { connection: target, bytes: [...Buffer.from('\r\nCONNECTION_STILL_ALIVE')] });
  await ui.waitFor(`(Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='屏幕快照').click(),document.querySelector('[aria-label="屏幕快照"]')?.textContent.includes('CONNECTION_STILL_ALIVE'))`);
  await ui.screenshot('desktop-logging-synthetic.png');
  console.log('PASS logging native WebView: explicit scope/start/stop, no history backfill, panel close/reload keep capture, exact bounded raw/text rotation, stop old log cannot stop new log, visible file failure while terminal continues; synthetic only');
} finally {
  await ui?.close();
  const target = path.resolve(directory);assert.equal(path.dirname(target), path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-logging-ui-'));
  await rm(target, { recursive: true, force: true });
}
