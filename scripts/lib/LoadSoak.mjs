import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delay } from './DesktopHarness.mjs';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export function checkSoakResourceFloor(measured, stage, report) {
  const availableFloor = stage === 'preflight' ? 2 * GiB : GiB;
  const volumeFloor = stage === 'preflight' ? 8 * GiB : 4 * GiB;
  const [data, reports] = measured.free;
  const hasMemory = measured.available >= availableFloor;
  const hasDisk = measured.free.length === 2 && data >= volumeFloor && reports >= volumeFloor;
  if (!hasMemory || !hasDisk) {
    report.resourceLowWater = {
      stage, availableBytes: measured.available, availableFloorBytes: availableFloor,
      freeBytes: { data, reports }, volumeFloorBytes: volumeFloor,
    };
  }
  assert.ok(hasMemory && hasDisk, `Soak resource low water during ${stage}`);
}

export async function soakPreflight(sampler, formal, report) {
  const measured = await sampler.request('preflight');
  checkSoakResourceFloor(measured, 'preflight', report);
  if (formal) {
    assert.equal(measured.power, 'Online', 'Soak requires continuous AC power');
    assert.deepEqual(measured.acTimers, [0, 0], 'Soak requires AC sleep and hibernate timers disabled');
  }
  return measured;
}

export async function measureSoak({ directory, ui, fixture, service, sampler, connections, seconds, control,
  done, report, publish, optionalJson, stopped, protocolFailure }) {
  const started = await control({ op: 'start', seconds });
  assert.equal(started.interval_seconds, 10);
  assert.equal(started.seconds, seconds);
  assert.equal(started.block_bytes, 1024);
  const wall = Number(started.start_unix_ms);
  const t0 = performance.now() + wall - Date.now();
  report.sourceStartUnixMs = wall;
  await publish('load-observer-heartbeat', {});
  await publish('load-observer-go.json', { start_unix_ms: wall });

  const minuteRows = report.resourceMinutes = [];
  const ids = connections.map(c => `${c.connection_id}:${c.generation}`).sort();
  async function verifyConnections() {
    const observed = await ui.invoke('service_status');
    assert.equal(observed.service_id, service.service_id);
    assert.equal(observed.pid, service.pid);
    const live = await ui.invoke('service_list');
    assert.ok(live.every(c => c.protocol === 'SSH2' && c.state === 'CONNECTED'));
    assert.deepEqual(live.map(c => `${c.connection_id}:${c.generation}`).sort(), ids);
  }
  async function sampleResources(index, began) {
      const measure = await sampler.request('sample', { desktop: ui.app.pid, service: service.pid, fixture: fixture.pid });
      checkSoakResourceFloor(measure, 'sampling', report);
      if (seconds === 28800) assert.equal(measure.power, 'Online', 'Soak lost AC power');
      const node = process.memoryUsage().rss;
      assert.ok(node <= 512 * MiB, 'Soak Node RSS limit');
      const processes = measure.processes;
      for (const [name, p] of Object.entries(processes)) {
        const ceiling = name === 'webview' ? 2 * GiB : GiB;
        assert.ok(p.private <= ceiling && p.working <= ceiling, `Soak ${name} memory limit`);
      }
      await verifyConnections();
      const { status: audit } = await ui.invoke('audit_history_request', { request: { op: 'info' } });
      assert.equal(audit.state, 'HEALTHY');
      assert.equal(audit.rejected_records, '0');
      assert.equal(audit.incomplete_segments, '0');
      const sample = { processes, node, available: measure.available, free: measure.free, latencyMs: performance.now() - began,
        audit, auditBacklog: Number(BigInt(audit.accepted_through) - BigInt(audit.synced_through)) };
      assert.ok(sample.auditBacklog < 1024, 'Soak audit backlog reached the queue capacity');
      const minute = Math.floor(index / 6);
      const row = minuteRows[minute] ??= { minute, count: 0, peaks: { node: 0, auditBacklog: 0, latencyMs: 0, processes: {} } };
      row.count++;
      row.last = sample;
      row.peaks.node = Math.max(row.peaks.node, node);
      row.peaks.auditBacklog = Math.max(row.peaks.auditBacklog, sample.auditBacklog);
      row.peaks.latencyMs = Math.max(row.peaks.latencyMs, sample.latencyMs);
      for (const [name, p] of Object.entries(processes)) {
        const peak = row.peaks.processes[name] ??= {};
        for (const [key, value] of Object.entries(p)) peak[key] = Math.max(peak[key] ?? 0, value);
      }
      if (index % 6 === 0) {
        await publish('load-observer-progress.json', { minute, duration: seconds, sample });
        console.log(`T18 soak minute ${minute}/${Math.ceil(seconds / 60)}`);
      }
  }
  let nextSample = 0;
  let lastTick = performance.now();
  let nextHeartbeat = lastTick + 5000;
  let sampleJob, sampleError;
  try {
    while (true) {
      assert.ok(!await stopped(), 'Soak stop requested');
      const fixtureError = protocolFailure();
      if (fixtureError) throw fixtureError;
      if (sampleError) throw sampleError;
      assert.equal(ui.app.exitCode, null, 'Owned Desktop exited during soak');
      assert.equal(fixture.exitCode, null, 'Owned fixture exited during soak');
      const tick = performance.now();
      const elapsed = tick - t0;
      const tickGap = tick - lastTick;
      const clockDrift = Math.abs(Date.now() - wall - elapsed);
      assert.ok(tickGap <= 4000 && clockDrift <= 500, `Soak clock check: gap=${tickGap.toFixed(1)}ms drift=${clockDrift.toFixed(1)}ms`);
      lastTick = tick;
      if (tick >= nextHeartbeat) {
        await publish('load-observer-heartbeat', {});
        nextHeartbeat = tick + 5000;
      }
      const result = await optionalJson('load-observer-result.json');
      if (result) {
        report.nativeObserver = result;
        assert.ok(result.passed, result.error);
        if (done.size === 20 && !sampleJob) break;
      }
      assert.ok(elapsed < seconds * 1000 + 10000, 'Soak final summary or source completion deadline');
      if (elapsed >= nextSample * 10000 && nextSample * 10 < seconds) {
        assert.ok(!sampleJob, 'Soak previous resource sample exceeded its interval');
        assert.ok(elapsed - nextSample * 10000 < 3000, 'Soak resource sample missed its slot');
        sampleJob = sampleResources(nextSample++, tick).catch(error => { sampleError = error; })
          .finally(() => { sampleJob = undefined; });
      }
      await delay(250);
    }
  } catch (error) {
    await writeFile(path.join(directory, 'load-observer-stop'), '').catch(() => {});
    throw error;
  } finally {
    await sampleJob;
  }

  const native = report.nativeObserver;
  assert.equal(native.observer_worker_joined, true);
  assert.equal(native.active_ticket_count, 0);
  assert.equal(native.stats.final_revocation_verified, true);
  assert.equal(native.stats.rotations_verified, seconds === 28800 ? 23 : 2);
  assert.equal(native.streams.length, 20);
  await verifyConnections();
  const frames = Math.ceil(seconds / 10);
  report.streams = native.streams.map((stream, i) => {
    const source = done.get(i);
    assert.deepEqual(stream.connection, connections[i]);
    assert.equal(source.error, null);
    assert.equal(source.frames, frames);
    assert.ok(source.elapsed_s >= seconds);
    assert.ok(source.max_wall_mono_drift_ms <= 500);
    assert.equal(stream.frames, frames);
    assert.equal(stream.bytes, frames * 1024);
    assert.equal(stream.pending_bytes, 0);
    assert.equal(stream.late_bytes, 0);
    assert.equal(stream.sha256, source.sha256);
    return { ...stream, source };
  });
  const remote = await control({ op: 'metrics' });
  assert.equal(remote.notification_failed, false);
  assert.equal(remote.received.length, 20);
  assert.ok(remote.received.every(bytes => bytes.length === 0), 'Soak terminal input must be zero on all sources');
  assert.equal(nextSample, Math.ceil(seconds / 10));
  if (seconds === 28800) {
    assert.equal(minuteRows.length, 480);
    assert.ok(minuteRows.every(row => row.count === 6));
    const median = values => {
      values.sort((a, b) => a - b);
      return (values[14] + values[15]) / 2;
    };
    const growth = get => {
      const first = median(minuteRows.slice(0, 30).map(get));
      const last = median(minuteRows.slice(-30).map(get));
      const maximumGrowth = Math.max(64 * MiB, first / 4);
      assert.ok(last - first <= maximumGrowth, 'Soak sustained memory growth limit');
      return { first, last, maximumGrowth };
    };
    report.memoryGrowth = { node: growth(row => row.peaks.node) };
    for (const name of ['desktop', 'service', 'fixture', 'webview', 'sampler'])
      report.memoryGrowth[name] = growth(row => row.peaks.processes[name].private);
  }
}

export async function closeSoakDesktop(ui, directory, service) {
  await ui.evaluate(`(() => { const menu=document.querySelector('details.tools-menu');
    if(!menu.open)menu.querySelector('summary').click(); return true; })()`);
  await ui.click('退出桌面');
  await ui.evaluate(`setTimeout(() => Array.from(document.querySelectorAll('button'))
    .find(b=>b.textContent==='确认退出并停止服务')?.click(), 250); true`).catch(error => {
    if (ui.app.exitCode === null) throw error;
  });
  for (let i = 0; i < 160 && ui.app.exitCode === null; i++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  const receipt = JSON.parse(await readFile(path.join(directory, 'desktop-close-receipts-v1', `${service.service_id}.json`), 'utf8'));
  assert.equal(receipt.service_id, service.service_id);
  assert.equal(receipt.owned_pid, service.pid);
  assert.equal(receipt.shutdown_ack, 'ACKNOWLEDGED');
  assert.equal(receipt.exited, true);
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.kill_requested, false);
  assert.equal(receipt.reader.diagnostic.outcome, 'CLOSED');
  assert.equal(receipt.reader.diagnostic.accepted, receipt.reader.diagnostic.synced);
  return receipt;
}
